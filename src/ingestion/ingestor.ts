import type { Config } from "../config.ts";
import { FlathubRequestError } from "../flathub/client.ts";
import type { Federation } from "@fedify/fedify";
import { Announce, Create, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type {
  AppstreamApp,
  FlathubClient,
  RecentlyUpdatedHit,
  RecentlyUpdatedPage,
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
import type { Repositories } from "../store/d1_store.ts";
import type { AppProfile, PostRecord, ReleaseRecord } from "../store/types.ts";

export interface CrawlJob {
  id: string;
  kind: "bootstrap" | "poll";
  phase: "bootstrap" | "updated" | "added" | "collections" | "done";
  page: number;
  perPage: number;
  index: number;
  result?: RecentlyUpdatedPage;
  watermark: number;
  nextWatermark: number;
  baseline: boolean;
  collectionIndex: number;
  addedAppIds?: string[];
}

export class Ingestor {
  constructor(
    private readonly config: Config,
    private readonly client: FlathubClient,
    private readonly repos: Repositories,
    private readonly federation?: Federation<FederationData>,
  ) {}

  async newJob(kind: CrawlJob["kind"], id: string): Promise<CrawlJob> {
    const previous = await this.repos.state.getCrawlState();
    const bootstrap =
      kind === "bootstrap" ? await this.repos.state.getBootstrapState() : null;
    return {
      id,
      kind,
      phase: bootstrap?.completed
        ? "done"
        : kind === "bootstrap"
          ? "bootstrap"
          : "updated",
      // Resume only durable CrawlJob cursors; bootstrap progress is for status.
      page: 1,
      perPage: this.config.recentlyUpdatedPerPage,
      index: 0,
      watermark: previous?.watermarkUpdatedAt ?? 0,
      nextWatermark: previous?.watermarkUpdatedAt ?? 0,
      baseline: false,
      collectionIndex: 0,
    };
  }

  /** One bounded unit of work. Persist the returned cursor before enqueueing its continuation. */
  async step(input: CrawlJob): Promise<CrawlJob> {
    // Do not mutate the durable cursor if a fetch or delivery fails halfway through.
    const job = structuredClone(input);
    if (job.phase === "done") return job;
    if (job.phase === "collections") return this.collectionStep(job);
    if (!job.result) {
      job.result = await (job.phase === "added"
        ? this.client.recentlyAdded(job.page, job.perPage)
        : this.client.recentlyUpdated(job.page, job.perPage));
      return job;
    }

    const hit = job.result.hits[job.index];
    const cutoff = Math.max(
      0,
      job.watermark - this.config.recentlyUpdatedOverlapSeconds,
    );
    if (hit) {
      if (job.phase === "bootstrap") {
        await this.repos.state.setBootstrapState({
          currentPage: job.page,
          currentAppId: hit.appId,
          completed: false,
          updatedAt: new Date().toISOString(),
        });
        await this.processBootstrapHit(hit);
      } else if (job.phase === "updated" && hit.updatedAt >= cutoff) {
        await this.processPollingHit(hit);
        job.nextWatermark = Math.max(job.nextWatermark, hit.updatedAt);
      } else if (job.phase === "added") {
        const addedAt = hitAddedAt(hit);
        job.nextWatermark = Math.max(job.nextWatermark, addedAt);
        if (!job.baseline && addedAt > job.watermark) {
          await this.publishNewApp(
            await this.repos.apps.upsertFromHit(hit),
            addedAt,
          );
        }
      }
      job.index++;
      return job;
    }

    const finished =
      job.page >= job.result.totalPages ||
      (job.phase === "updated" &&
        job.result.hits.length > 0 &&
        job.result.hits.every((hit) => hit.updatedAt < cutoff)) ||
      (job.phase === "added" &&
        (job.baseline ||
          (job.result.hits.length > 0 &&
            job.result.hits.every((hit) => hitAddedAt(hit) <= job.watermark))));
    delete job.result;
    job.index = 0;
    if (!finished) {
      job.page++;
      return job;
    }

    if (job.phase === "bootstrap") {
      await this.repos.state.setBootstrapState({
        currentPage: job.page,
        completed: true,
        updatedAt: new Date().toISOString(),
      });
      job.phase = "done";
    } else if (job.phase === "updated") {
      await this.repos.state.setCrawlState({
        watermarkUpdatedAt: job.nextWatermark,
        completedAt: new Date().toISOString(),
      });
      const previous = await this.repos.state.getRecentlyAddedState();
      job.phase = "added";
      job.page = 1;
      job.baseline = previous == null;
      job.watermark = job.nextWatermark = previous?.watermarkAddedAt ?? 0;
    } else {
      if (!job.baseline || job.nextWatermark > 0) {
        await this.repos.state.setRecentlyAddedState({
          watermarkAddedAt: job.nextWatermark,
          completedAt: new Date().toISOString(),
        });
      }
      job.phase = "collections";
      job.page = 1;
    }
    return job;
  }

  private async collectionStep(job: CrawlJob): Promise<CrawlJob> {
    const collection = appCollectionActors()[job.collectionIndex];
    if (!collection) {
      job.phase = "done";
      return job;
    }
    if (!job.result) {
      job.result = await this.client.collection(
        collection.flathubCollection,
        1,
        job.perPage,
      );
      return job;
    }
    if (job.index < job.result.hits.length) {
      await this.repos.apps.upsertFromHit(job.result.hits[job.index++]);
      return job;
    }
    if (!job.addedAppIds) {
      const previous = await this.repos.feeds.snapshotIds(collection.id);
      job.addedAppIds =
        previous === null
          ? []
          : job.result.hits
              .map((hit) => hit.appId)
              .filter((id) => !previous.includes(id));
      return job;
    }
    if (job.addedAppIds.length > 0) {
      const profile = await this.repos.apps.get(job.addedAppIds[0]);
      if (profile)
        await this.deliverCollectionAppAnnounce(collection.id, profile);
      job.addedAppIds.shift();
      return job;
    }
    await this.repos.feeds.replaceAppSnapshot(
      collection.id,
      job.result.hits.map((hit) => hit.appId),
    );
    delete job.result;
    delete job.addedAppIds;
    job.index = 0;
    job.collectionIndex++;
    return job;
  }

  async bootstrap(): Promise<void> {
    let job = await this.newJob("bootstrap", crypto.randomUUID());
    while (job.phase !== "done") job = await this.step(job);
  }

  async poll(): Promise<void> {
    let job = await this.newJob("poll", crypto.randomUUID());
    while (job.phase !== "done") job = await this.step(job);
  }

  private async processBootstrapHit(hit: RecentlyUpdatedHit): Promise<void> {
    const fetched = await this.fetchAppstream(hit.appId);
    if (fetched == null) return;
    const profile = await this.repos.apps.upsertFromHit(
      appProfileInput(hit, fetched.appstream),
    );
    for (const release of fetched.releases) {
      await this.storeObservedRelease(profile, release);
    }
    const latest = latestRelease(fetched.releases);
    if (latest) await this.publishRelease(profile, latest);
  }

  private async processPollingHit(hit: RecentlyUpdatedHit): Promise<void> {
    const fetched = await this.fetchAppstream(hit.appId);
    if (fetched == null) return;
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
      publishedAt:
        addedAt > 0
          ? new Date(addedAt * 1000).toISOString()
          : new Date().toISOString(),
      deliveryState: "queued",
    };
    const created =
      await this.repos.releases.createStandalonePostIfAbsent(post);
    const saved = created
      ? post
      : await this.repos.releases.getPost(profile.appId, "new-app");
    if (saved) await this.retryPostDelivery(saved, "new-apps");
    if (created) {
      logEvent("app.announced", { appId: profile.appId });
    }
  }

  private async fetchAppstream(appId: string): Promise<{
    appstream: AppstreamApp;
    releases: NormalizedRelease[];
  } | null> {
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
      if (
        error instanceof FlathubRequestError &&
        (error.status === 404 || error.status === 410)
      ) {
        logEvent("appstream.removed", { appId, status: error.status });
        return null;
      }
      logError("appstream.failed", error, { appId });
      throw new Error(`failed to fetch AppStream for ${appId}`, {
        cause: error,
      });
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
    const ctx = this.federation.createContext(new Request(this.config.origin), {
      repos: this.repos,
    });
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
      { preferSharedInbox: true },
    );
  }

  private async deliverCollectionAnnounce(
    collectionId: string,
    post: PostRecord,
  ): Promise<void> {
    if (!this.federation) return;
    const collection = getCollectionActor(collectionId);
    if (!collection) return;
    const ctx = this.federation.createContext(new Request(this.config.origin), {
      repos: this.repos,
    });
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
    const ctx = this.federation.createContext(new Request(this.config.origin), {
      repos: this.repos,
    });
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
