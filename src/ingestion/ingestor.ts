import type { Config } from "../config.ts";
import type { Federation } from "@fedify/fedify";
import { Create, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type { FlathubClient, RecentlyUpdatedHit } from "../flathub/client.ts";
import type { FederationData } from "../federation/fedify.ts";
import { logError, logEvent } from "../log.ts";
import {
  buildNoteContent,
  latestRelease,
  type NormalizedRelease,
  normalizeReleases,
  releasePublishedAt,
} from "../releases.ts";
import { createActivityId, noteId } from "../federation/activity.ts";
import type { Repositories } from "../store/kv_store.ts";
import type { AppProfile, PostRecord, ReleaseRecord } from "../store/types.ts";

export class Ingestor {
  constructor(
    private readonly config: Config,
    private readonly client: FlathubClient,
    private readonly repos: Repositories,
    private readonly federation?: Federation<FederationData>,
  ) {}

  async bootstrap(): Promise<void> {
    const state = await this.repos.state.getBootstrapState();
    if (state?.completed) return;
    let page = state?.currentPage ?? 1;
    logEvent("bootstrap.start", { page });

    while (true) {
      const result = await this.client.recentlyUpdated(
        page,
        this.config.recentlyUpdatedPerPage,
      );
      for (const hit of result.hits) {
        await this.repos.state.setBootstrapState({
          currentPage: page,
          currentAppId: hit.appId,
          completed: false,
          updatedAt: new Date().toISOString(),
        });
        await this.processBootstrapHit(hit);
        if (this.config.bootstrapThrottleMs > 0) {
          await delay(this.config.bootstrapThrottleMs);
        }
      }
      logEvent("bootstrap.page", { page, hits: result.hits.length });
      if (page >= result.totalPages) break;
      page++;
    }

    await this.repos.state.setBootstrapState({
      currentPage: page,
      completed: true,
      updatedAt: new Date().toISOString(),
    });
    logEvent("bootstrap.finish", { page });
  }

  async poll(): Promise<void> {
    const previous = await this.repos.state.getCrawlState();
    const watermark = previous?.watermarkUpdatedAt ?? 0;
    const cutoff = Math.max(
      0,
      watermark - this.config.recentlyUpdatedOverlapSeconds,
    );
    let nextWatermark = watermark;
    let page = 1;
    logEvent("crawl.start", { watermark, cutoff });

    try {
      while (true) {
        const result = await this.client.recentlyUpdated(
          page,
          this.config.recentlyUpdatedPerPage,
        );
        const candidates = result.hits.filter((hit) => hit.updatedAt >= cutoff);
        const fullPageOlderThanCutoff = result.hits.length > 0 &&
          candidates.length === 0;
        for (const hit of candidates) {
          nextWatermark = Math.max(nextWatermark, hit.updatedAt);
          await this.processPollingHit(hit);
        }
        logEvent("crawl.page", {
          page,
          hits: result.hits.length,
          candidates: candidates.length,
        });
        if (fullPageOlderThanCutoff || page >= result.totalPages) break;
        page++;
      }

      await this.repos.state.setCrawlState({
        watermarkUpdatedAt: nextWatermark,
        completedAt: new Date().toISOString(),
      });
      logEvent("crawl.finish", { watermark: nextWatermark });
    } catch (error) {
      logError("crawl.failed", error, { page });
      throw error;
    }
  }

  private async processBootstrapHit(hit: RecentlyUpdatedHit): Promise<void> {
    const profile = await this.repos.apps.upsertFromHit(hit);
    const releases = await this.fetchReleases(hit.appId);
    if (releases == null) return;
    for (const release of releases) {
      await this.storeObservedRelease(profile, release);
    }
    const latest = latestRelease(releases);
    if (latest) await this.publishRelease(profile, latest);
  }

  private async processPollingHit(hit: RecentlyUpdatedHit): Promise<void> {
    const profile = await this.repos.apps.upsertFromHit(hit);
    const releases = await this.fetchReleases(hit.appId);
    if (releases == null) {
      throw new Error(`failed to fetch AppStream for ${hit.appId}`);
    }
    for (const release of releases) {
      const existing = await this.repos.releases.get(
        hit.appId,
        release.fingerprint,
      );
      if (existing) continue;
      await this.publishRelease(profile, release);
    }
  }

  private async fetchReleases(
    appId: string,
  ): Promise<NormalizedRelease[] | null> {
    try {
      const appstream = await this.client.appstream(appId);
      const releases = await normalizeReleases(appId, appstream.releases);
      logEvent("appstream.fetched", {
        appId,
        releases: appstream.releases.length,
        described: releases.length,
      });
      return releases;
    } catch (error) {
      logError("appstream.failed", error, { appId });
      return null;
    }
  }

  private async storeObservedRelease(
    profile: AppProfile,
    release: NormalizedRelease,
  ): Promise<void> {
    await this.repos.releases.putObserved(
      this.toReleaseRecord(profile, release),
    );
  }

  private async publishRelease(
    profile: AppProfile,
    release: NormalizedRelease,
  ): Promise<void> {
    const releaseRecord = this.toReleaseRecord(profile, release);
    const noteUrl = noteId(
      this.config.origin,
      profile.appId,
      release.fingerprint,
    );
    const publishedAt = releasePublishedAt(release);
    const post: PostRecord = {
      appId: profile.appId,
      releaseFingerprint: release.fingerprint,
      noteId: noteUrl,
      createActivityId: createActivityId(noteUrl),
      contentHtml: buildNoteContent(profile.name, profile.appId, release),
      publishedAt,
      deliveryState: "queued",
    };
    const created = await this.repos.releases.createPostIfAbsent(
      { ...releaseRecord, publishedAt },
      post,
    );
    if (created) {
      await this.deliverPost(post);
      logEvent("release.published", {
        appId: profile.appId,
        fingerprint: release.fingerprint,
      });
    }
  }

  private async deliverPost(post: PostRecord): Promise<void> {
    if (!this.federation) return;
    const ctx = this.federation.createContext(
      new Request(this.config.origin),
      { repos: this.repos },
    );
    const actor = ctx.getActorUri(post.appId);
    const followers = ctx.getFollowersUri(post.appId);
    const note = new Note({
      id: new URL(post.noteId),
      attribution: actor,
      to: PUBLIC_COLLECTION,
      cc: followers,
      content: post.contentHtml,
      url: new URL(post.noteId),
    });
    await ctx.sendActivity(
      { identifier: post.appId },
      "followers",
      new Create({
        id: new URL(post.createActivityId),
        actor,
        to: PUBLIC_COLLECTION,
        cc: followers,
        object: note,
      }),
      { preferSharedInbox: true, orderingKey: post.noteId },
    );
  }

  private toReleaseRecord(
    profile: AppProfile,
    release: NormalizedRelease,
  ): ReleaseRecord {
    return {
      appId: profile.appId,
      fingerprint: release.fingerprint,
      version: release.version,
      timestamp: release.timestamp,
      date: release.date,
      type: release.type,
      urgency: release.urgency,
      descriptionHtml: release.descriptionHtml,
      url: release.url,
      firstSeenAt: new Date().toISOString(),
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
