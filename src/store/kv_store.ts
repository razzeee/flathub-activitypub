import type {
  AppProfile,
  BootstrapState,
  CrawlState,
  FeedAppRecord,
  FollowerRecord,
  PostKind,
  PostRecord,
  RecentlyAddedState,
  ReleaseRecord,
} from "./types.ts";

export type Kv = Deno.Kv;

export class AppRepository {
  constructor(private readonly kv: Kv) {}

  async upsertFromHit(input: {
    appId: string;
    name: string;
    summary?: string;
    descriptionHtml?: string;
    iconUrl?: string;
    updatedAt: number;
  }): Promise<AppProfile> {
    const now = new Date().toISOString();
    const existing = await this.get(input.appId);
    const profile: AppProfile = {
      appId: input.appId,
      name: input.name || existing?.name || input.appId,
      summary: input.summary ?? existing?.summary,
      descriptionHtml: input.descriptionHtml ?? existing?.descriptionHtml,
      iconUrl: input.iconUrl ?? existing?.iconUrl,
      flathubUrl: `https://flathub.org/apps/${encodeURIComponent(input.appId)}`,
      lastSeenUpdatedAt: input.updatedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.kv.atomic()
      .set(["app", input.appId], profile)
      .set(["appByUpdatedAt", input.updatedAt, input.appId], true)
      .commit();
    return profile;
  }

  async get(appId: string): Promise<AppProfile | null> {
    return (await this.kv.get<AppProfile>(["app", appId])).value;
  }

  async listRecent(limit = 50): Promise<AppProfile[]> {
    const profiles: AppProfile[] = [];
    for await (
      const entry of this.kv.list<boolean>(
        { prefix: ["appByUpdatedAt"] },
        { limit, reverse: true },
      )
    ) {
      const appId = entry.key[2];
      if (typeof appId !== "string") continue;
      const profile = await this.get(appId);
      if (profile) profiles.push(profile);
    }
    return profiles;
  }

  async listAll(limit = 50_000): Promise<AppProfile[]> {
    const profiles: AppProfile[] = [];
    for await (
      const entry of this.kv.list<AppProfile>({ prefix: ["app"] }, { limit })
    ) {
      profiles.push(entry.value);
    }
    return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _entry of this.kv.list({ prefix: ["app"] })) count++;
    return count;
  }
}

export class ReleaseRepository {
  constructor(private readonly kv: Kv) {}

  async get(appId: string, fingerprint: string): Promise<ReleaseRecord | null> {
    return (await this.kv.get<ReleaseRecord>(["release", appId, fingerprint]))
      .value;
  }

  async putObserved(record: ReleaseRecord): Promise<void> {
    const existing = await this.get(record.appId, record.fingerprint);
    if (existing) return;
    await this.kv.set(["release", record.appId, record.fingerprint], record);
  }

  async createPostIfAbsent(
    release: ReleaseRecord,
    post: PostRecord,
  ): Promise<boolean> {
    const releaseKey = ["release", release.appId, release.fingerprint];
    const postKey = ["post", post.appId, post.releaseFingerprint];
    const existingRelease = await this.kv.get<ReleaseRecord>(releaseKey);
    const existingPost = await this.kv.get<PostRecord>(postKey);
    if (existingPost.value) return false;

    const record: ReleaseRecord = {
      ...(existingRelease.value ?? release),
      publishedAt: post.publishedAt,
    };
    const result = await this.kv.atomic()
      .check(existingPost)
      .set(releaseKey, record)
      .set(postKey, post)
      .commit();
    return result.ok;
  }

  async createStandalonePostIfAbsent(post: PostRecord): Promise<boolean> {
    const postKey = ["post", post.appId, post.releaseFingerprint];
    const existingPost = await this.kv.get<PostRecord>(postKey);
    if (existingPost.value) return false;

    const result = await this.kv.atomic()
      .check(existingPost)
      .set(postKey, post)
      .commit();
    return result.ok;
  }

  async getPost(
    appId: string,
    fingerprint: string,
  ): Promise<PostRecord | null> {
    return (await this.kv.get<PostRecord>(["post", appId, fingerprint])).value;
  }

  async setPostDeliveryState(
    appId: string,
    fingerprint: string,
    deliveryState: PostRecord["deliveryState"],
  ): Promise<void> {
    const key = ["post", appId, fingerprint];
    const existing = await this.kv.get<PostRecord>(key);
    if (!existing.value) return;
    await this.kv.atomic()
      .check(existing)
      .set(key, { ...existing.value, deliveryState })
      .commit();
  }

  async listPosts(appId: string): Promise<PostRecord[]> {
    const posts: PostRecord[] = [];
    for await (
      const entry of this.kv.list<PostRecord>({ prefix: ["post", appId] })
    ) {
      posts.push(entry.value);
    }
    return posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  async listRecentPosts(
    kind?: PostKind,
    limit = 50,
  ): Promise<PostRecord[]> {
    const posts: PostRecord[] = [];
    for await (const entry of this.kv.list<PostRecord>({ prefix: ["post"] })) {
      if (kind != null && postKind(entry.value) !== kind) continue;
      posts.push(entry.value);
    }
    return posts
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }

  async countPosts(kind?: PostKind): Promise<number> {
    let count = 0;
    for await (const entry of this.kv.list<PostRecord>({ prefix: ["post"] })) {
      if (kind == null || postKind(entry.value) === kind) count++;
    }
    return count;
  }
}

export class FollowerRepository {
  constructor(private readonly kv: Kv) {}

  async put(record: FollowerRecord): Promise<void> {
    await this.kv.set(["follower", record.appId, record.actorId], record);
  }

  async delete(appId: string, actorId: string): Promise<void> {
    await this.kv.delete(["follower", appId, actorId]);
  }

  async list(appId: string): Promise<FollowerRecord[]> {
    const followers: FollowerRecord[] = [];
    for await (
      const entry of this.kv.list<FollowerRecord>({
        prefix: ["follower", appId],
      })
    ) {
      followers.push(entry.value);
    }
    return followers;
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _entry of this.kv.list({ prefix: ["follower"] })) count++;
    return count;
  }
}

export class FeedRepository {
  constructor(private readonly kv: Kv, private readonly apps: AppRepository) {}

  async replaceAppSnapshot(
    feedId: string,
    appIds: string[],
  ): Promise<{ hadPrevious: boolean; addedAppIds: string[] }> {
    const previous = new Set<string>();
    const deletions: Deno.KvKey[] = [];
    for await (
      const entry of this.kv.list<FeedAppRecord>({
        prefix: ["feedApp", feedId],
      })
    ) {
      previous.add(entry.value.appId);
      deletions.push(entry.key);
    }

    const now = new Date().toISOString();
    let atomic = this.kv.atomic();
    for (const key of deletions) atomic = atomic.delete(key);
    for (const [rank, appId] of appIds.entries()) {
      atomic = atomic.set(
        ["feedApp", feedId, rank, appId],
        {
          feedId,
          appId,
          rank,
          observedAt: now,
        } satisfies FeedAppRecord,
      );
    }
    await atomic.commit();

    return {
      hadPrevious: previous.size > 0,
      addedAppIds: appIds.filter((appId) => !previous.has(appId)),
    };
  }

  async listAppProfiles(feedId: string, limit = 50): Promise<AppProfile[]> {
    const profiles: AppProfile[] = [];
    for await (
      const entry of this.kv.list<FeedAppRecord>(
        { prefix: ["feedApp", feedId] },
        { limit },
      )
    ) {
      const profile = await this.apps.get(entry.value.appId);
      if (profile) profiles.push(profile);
    }
    return profiles;
  }

  async countAppProfiles(feedId: string): Promise<number> {
    let count = 0;
    for await (const _entry of this.kv.list({ prefix: ["feedApp", feedId] })) {
      count++;
    }
    return count;
  }
}

function postKind(post: PostRecord): PostKind {
  return post.kind ?? "release";
}

export class StateRepository {
  constructor(private readonly kv: Kv) {}

  async getCrawlState(): Promise<CrawlState | null> {
    return (await this.kv.get<CrawlState>(["crawl", "recentlyUpdated"])).value;
  }

  async setCrawlState(state: CrawlState): Promise<void> {
    await this.kv.set(["crawl", "recentlyUpdated"], state);
  }

  async getRecentlyAddedState(): Promise<RecentlyAddedState | null> {
    return (await this.kv.get<RecentlyAddedState>(["crawl", "recentlyAdded"]))
      .value;
  }

  async setRecentlyAddedState(state: RecentlyAddedState): Promise<void> {
    await this.kv.set(["crawl", "recentlyAdded"], state);
  }

  async getBootstrapState(): Promise<BootstrapState | null> {
    return (await this.kv.get<BootstrapState>(["bootstrap", "state"])).value;
  }

  async setBootstrapState(state: BootstrapState): Promise<void> {
    await this.kv.set(["bootstrap", "state"], state);
  }
}

export interface Repositories {
  apps: AppRepository;
  releases: ReleaseRepository;
  followers: FollowerRepository;
  feeds: FeedRepository;
  state: StateRepository;
}

export function createRepositories(kv: Kv): Repositories {
  const apps = new AppRepository(kv);
  return {
    apps,
    releases: new ReleaseRepository(kv),
    followers: new FollowerRepository(kv),
    feeds: new FeedRepository(kv, apps),
    state: new StateRepository(kv),
  };
}
