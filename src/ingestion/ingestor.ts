import type { Config } from "../config.ts";
import type { Federation } from "@fedify/fedify";
import { Announce, Create, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type {
  AppstreamApp,
  FlathubClient,
  RecentlyUpdatedHit,
} from "../flathub/client.ts";
import type { FederationData } from "../federation/fedify.ts";
import {
  appCollectionActors,
  getCollectionActor,
} from "../federation/collections.ts";
import { logError, logEvent } from "../log.ts";
import {
  buildNewAppNoteContent,
  buildNoteContent,
  latestRelease,
  type NormalizedRelease,
  normalizeReleases,
  releasePublishedAt,
  sanitizeHtml,
} from "../releases.ts";
import {
  announceActivityId,
  createActivityId,
  newAppNoteId,
  noteId,
} from "../federation/activity.ts";
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
    await this.pollRecentlyUpdated();
    await this.pollRecentlyAdded();
    await this.pollAppCollections();
  }

  private async pollRecentlyUpdated(): Promise<void> {
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

  private async pollRecentlyAdded(): Promise<void> {
    const previous = await this.repos.state.getRecentlyAddedState();
    const baseline = previous == null;
    const watermark = previous?.watermarkAddedAt ?? 0;
    let nextWatermark = watermark;
    let page = 1;
    logEvent("recently_added.start", { watermark, baseline });

    try {
      while (true) {
        const result = await this.client.recentlyAdded(
          page,
          this.config.recentlyUpdatedPerPage,
        );
        const validHits = result.hits.filter((hit) => hitAddedAt(hit) > 0);
        for (const hit of validHits) {
          nextWatermark = Math.max(nextWatermark, hitAddedAt(hit));
        }
        const candidates = baseline
          ? []
          : validHits.filter((hit) => hitAddedAt(hit) > watermark);
        for (const hit of candidates) {
          const profile = await this.repos.apps.upsertFromHit(hit);
          await this.publishNewApp(profile, hitAddedAt(hit));
        }
        logEvent("recently_added.page", {
          page,
          hits: result.hits.length,
          candidates: candidates.length,
        });
        const fullPageAtOrBeforeWatermark = !baseline &&
          result.hits.length > 0 && candidates.length === 0;
        if (
          baseline || fullPageAtOrBeforeWatermark || page >= result.totalPages
        ) {
          break;
        }
        page++;
      }

      if (baseline && nextWatermark === 0) {
        logEvent("recently_added.baseline_empty", { page });
        return;
      }

      await this.repos.state.setRecentlyAddedState({
        watermarkAddedAt: nextWatermark,
        completedAt: new Date().toISOString(),
      });
      logEvent("recently_added.finish", { watermark: nextWatermark });
    } catch (error) {
      logError("recently_added.failed", error, { page });
      throw error;
    }
  }

  private async processBootstrapHit(hit: RecentlyUpdatedHit): Promise<void> {
    const fetched = await this.fetchAppstream(hit.appId);
    const profile = await this.repos.apps.upsertFromHit(
      appProfileInput(hit, fetched?.appstream),
    );
    if (fetched == null) return;
    for (const release of fetched.releases) {
      await this.storeObservedRelease(profile, release);
    }
    const latest = latestRelease(fetched.releases);
    if (latest) await this.publishRelease(profile, latest);
  }

  private async pollAppCollections(): Promise<void> {
    for (const collection of appCollectionActors()) {
      const result = await this.client.collection(
        collection.flathubCollection,
        1,
        this.config.recentlyUpdatedPerPage,
      );
      const profiles: AppProfile[] = [];
      for (const hit of result.hits) {
        profiles.push(await this.repos.apps.upsertFromHit(hit));
      }
      const snapshot = await this.repos.feeds.replaceAppSnapshot(
        collection.id,
        profiles.map((profile) => profile.appId),
      );
      if (snapshot.hadPrevious) {
        for (const profile of profiles) {
          if (snapshot.addedAppIds.includes(profile.appId)) {
            await this.deliverCollectionAppAnnounce(collection.id, profile);
          }
        }
      }
      logEvent("collection.snapshot", {
        collection: collection.flathubCollection,
        actor: collection.id,
        hits: result.hits.length,
        added: snapshot.hadPrevious ? snapshot.addedAppIds.length : 0,
        baseline: !snapshot.hadPrevious,
      });
    }
  }

  private async processPollingHit(hit: RecentlyUpdatedHit): Promise<void> {
    const fetched = await this.fetchAppstream(hit.appId);
    if (fetched == null) {
      throw new Error(`failed to fetch AppStream for ${hit.appId}`);
    }
    const profile = await this.repos.apps.upsertFromHit(
      appProfileInput(hit, fetched.appstream),
    );
    for (const release of fetched.releases) {
      const existing = await this.repos.releases.get(
        hit.appId,
        release.fingerprint,
      );
      if (existing) {
        const post = await this.repos.releases.getPost(
          hit.appId,
          release.fingerprint,
        );
        if (post) await this.retryPostDelivery(post, "recent-releases");
        continue;
      }
      await this.publishRelease(profile, release);
    }
  }

  private async publishNewApp(
    profile: AppProfile,
    addedAt: number,
  ): Promise<void> {
    const noteUrl = newAppNoteId(this.config.origin, profile.appId);
    const post: PostRecord = {
      appId: profile.appId,
      releaseFingerprint: "new-app",
      kind: "new-app",
      noteId: noteUrl,
      createActivityId: createActivityId(noteUrl),
      contentHtml: buildNewAppNoteContent(profile),
      publishedAt: addedAt > 0
        ? new Date(addedAt * 1000).toISOString()
        : new Date().toISOString(),
      deliveryState: "queued",
    };
    const created = await this.repos.releases.createStandalonePostIfAbsent(
      post,
    );
    const saved = created
      ? post
      : await this.repos.releases.getPost(profile.appId, "new-app");
    if (saved) await this.retryPostDelivery(saved, "new-apps");
    if (created) {
      logEvent("app.announced", { appId: profile.appId });
    }
  }

  private async fetchAppstream(
    appId: string,
  ): Promise<
    { appstream: AppstreamApp; releases: NormalizedRelease[] } | null
  > {
    try {
      const appstream = await this.client.appstream(appId);
      const releases = await normalizeReleases(appId, appstream.releases);
      logEvent("appstream.fetched", {
        appId,
        releases: appstream.releases.length,
        described: releases.length,
      });
      return { appstream, releases };
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
      kind: "release",
      deliveryState: "queued",
    };
    const created = await this.repos.releases.createPostIfAbsent(
      { ...releaseRecord, publishedAt },
      post,
    );
    const saved = created
      ? post
      : await this.repos.releases.getPost(profile.appId, release.fingerprint);
    if (saved) await this.retryPostDelivery(saved, "recent-releases");
    if (created) {
      logEvent("release.published", {
        appId: profile.appId,
        fingerprint: release.fingerprint,
      });
    }
  }

  private async retryPostDelivery(
    post: PostRecord,
    collectionId: string,
  ): Promise<void> {
    if (post.deliveryState === "delivered") return;
    try {
      await this.deliverPost(post);
      await this.deliverCollectionAnnounce(collectionId, post);
      await this.repos.releases.setPostDeliveryState(
        post.appId,
        post.releaseFingerprint,
        "delivered",
      );
    } catch (error) {
      await this.repos.releases.setPostDeliveryState(
        post.appId,
        post.releaseFingerprint,
        "failed",
      );
      throw error;
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

  private async deliverCollectionAnnounce(
    collectionId: string,
    post: PostRecord,
  ): Promise<void> {
    if (!this.federation) return;
    const collection = getCollectionActor(collectionId);
    if (!collection) return;
    const ctx = this.federation.createContext(
      new Request(this.config.origin),
      { repos: this.repos },
    );
    const actor = ctx.getActorUri(collection.id);
    const followers = ctx.getFollowersUri(collection.id);
    await ctx.sendActivity(
      { identifier: collection.id },
      "followers",
      new Announce({
        id: new URL(announceActivityId(post, collection.id)),
        actor,
        to: PUBLIC_COLLECTION,
        cc: followers,
        object: new URL(post.noteId),
      }),
      {
        preferSharedInbox: true,
        orderingKey: `${collection.id}:${post.noteId}`,
      },
    );
  }

  private async deliverCollectionAppAnnounce(
    collectionId: string,
    profile: AppProfile,
  ): Promise<void> {
    if (!this.federation) return;
    const collection = getCollectionActor(collectionId);
    if (!collection) return;
    const ctx = this.federation.createContext(
      new Request(this.config.origin),
      { repos: this.repos },
    );
    const actor = ctx.getActorUri(collection.id);
    const followers = ctx.getFollowersUri(collection.id);
    await ctx.sendActivity(
      { identifier: collection.id },
      "followers",
      new Announce({
        id: new URL(
          `${actor.href}/announces/${encodeURIComponent(profile.appId)}`,
        ),
        actor,
        to: PUBLIC_COLLECTION,
        cc: followers,
        object: ctx.getActorUri(profile.appId),
      }),
      {
        preferSharedInbox: true,
        orderingKey: `${collection.id}:${profile.appId}`,
      },
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

function hitAddedAt(hit: RecentlyUpdatedHit): number {
  return hit.addedAt ?? 0;
}

function appProfileInput(hit: RecentlyUpdatedHit, appstream?: AppstreamApp) {
  const descriptionHtml = sanitizeHtml(appstream?.description ?? "");
  return {
    appId: hit.appId,
    name: appstream?.name ?? hit.name,
    summary: appstream?.summary ?? hit.summary,
    descriptionHtml: descriptionHtml === "" ? undefined : descriptionHtml,
    iconUrl: appstream?.iconUrl ?? hit.iconUrl,
    updatedAt: hit.updatedAt,
  };
}
