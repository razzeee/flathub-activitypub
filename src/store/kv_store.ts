import type {
  AppProfile,
  BootstrapState,
  CrawlState,
  FollowerRecord,
  PostRecord,
  ReleaseRecord,
} from "./types.ts";

export type Kv = Deno.Kv;

export class AppRepository {
  constructor(private readonly kv: Kv) {}

  async upsertFromHit(input: {
    appId: string;
    name: string;
    summary?: string;
    iconUrl?: string;
    updatedAt: number;
  }): Promise<AppProfile> {
    const now = new Date().toISOString();
    const existing = await this.get(input.appId);
    const profile: AppProfile = {
      appId: input.appId,
      name: input.name || existing?.name || input.appId,
      summary: input.summary ?? existing?.summary,
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

  async getPost(
    appId: string,
    fingerprint: string,
  ): Promise<PostRecord | null> {
    return (await this.kv.get<PostRecord>(["post", appId, fingerprint])).value;
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
}

export class StateRepository {
  constructor(private readonly kv: Kv) {}

  async getCrawlState(): Promise<CrawlState | null> {
    return (await this.kv.get<CrawlState>(["crawl", "recentlyUpdated"])).value;
  }

  async setCrawlState(state: CrawlState): Promise<void> {
    await this.kv.set(["crawl", "recentlyUpdated"], state);
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
  state: StateRepository;
}

export function createRepositories(kv: Kv): Repositories {
  return {
    apps: new AppRepository(kv),
    releases: new ReleaseRepository(kv),
    followers: new FollowerRepository(kv),
    state: new StateRepository(kv),
  };
}
