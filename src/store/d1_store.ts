import type {
  AppProfile,
  BootstrapState,
  CrawlState,
  FollowerRecord,
  PostKind,
  PostRecord,
  RecentlyAddedState,
  ReleaseRecord,
} from "./types.ts";

async function read<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as T) : null;
}

async function list<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<{ data: string }>();
  return result.results.map((row) => JSON.parse(row.data) as T);
}

export class AppRepository {
  constructor(private readonly db: D1Database) {}

  async upsertFromHit(input: {
    appId: string;
    name: string;
    summary?: string;
    descriptionHtml?: string;
    iconUrl?: string;
    updatedAt: number;
  }): Promise<AppProfile> {
    const existing = await this.get(input.appId);
    const now = new Date().toISOString();
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
    await this.db
      .prepare(
        "INSERT INTO apps(id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data",
      )
      .bind(input.appId, input.updatedAt, JSON.stringify(profile))
      .run();
    return profile;
  }

  get(id: string): Promise<AppProfile | null> {
    return read(this.db, "SELECT data FROM apps WHERE id=?", id);
  }
  listRecent(limit = 50): Promise<AppProfile[]> {
    return list(
      this.db,
      "SELECT data FROM apps ORDER BY updated_at DESC, id LIMIT ?",
      limit,
    );
  }
  listAll(limit = 50_000): Promise<AppProfile[]> {
    return list(
      this.db,
      "SELECT data FROM apps ORDER BY json_extract(data, '$.updatedAt') DESC, id LIMIT ?",
      limit,
    );
  }
  async count(): Promise<number> {
    return (await this.db
      .prepare("SELECT count(*) AS count FROM apps")
      .first<number>("count"))!;
  }
}

export class ReleaseRepository {
  constructor(private readonly db: D1Database) {}

  get(appId: string, fingerprint: string): Promise<ReleaseRecord | null> {
    return read(
      this.db,
      "SELECT data FROM releases WHERE app_id=? AND fingerprint=?",
      appId,
      fingerprint,
    );
  }
  async putObserved(record: ReleaseRecord): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO releases VALUES (?, ?, ?)")
      .bind(record.appId, record.fingerprint, JSON.stringify(record))
      .run();
  }
  async createPostIfAbsent(
    release: ReleaseRecord,
    post: PostRecord,
  ): Promise<boolean> {
    // D1 batches are transactional: a post and its observed release cannot diverge.
    const results = await this.db.batch([
      this.insertPost(post),
      this.db
        .prepare(
          "INSERT INTO releases VALUES (?, ?, json_set(?, '$.publishedAt', (SELECT published_at FROM posts WHERE app_id=? AND fingerprint=?))) ON CONFLICT(app_id, fingerprint) DO UPDATE SET data=json_set(releases.data, '$.publishedAt', json_extract(excluded.data, '$.publishedAt'))",
        )
        .bind(
          release.appId,
          release.fingerprint,
          JSON.stringify(release),
          post.appId,
          post.releaseFingerprint,
        ),
    ]);
    return results[0].meta.changes > 0;
  }
  private insertPost(post: PostRecord): D1PreparedStatement {
    return this.db
      .prepare("INSERT OR IGNORE INTO posts VALUES (?, ?, ?, ?, ?)")
      .bind(
        post.appId,
        post.releaseFingerprint,
        post.kind ?? "release",
        post.publishedAt,
        JSON.stringify(post),
      );
  }
  async createStandalonePostIfAbsent(post: PostRecord): Promise<boolean> {
    return (await this.insertPost(post).run()).meta.changes > 0;
  }
  getPost(appId: string, fingerprint: string): Promise<PostRecord | null> {
    return read(
      this.db,
      "SELECT data FROM posts WHERE app_id=? AND fingerprint=?",
      appId,
      fingerprint,
    );
  }
  async setPostDeliveryState(
    appId: string,
    fingerprint: string,
    deliveryState: PostRecord["deliveryState"],
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE posts SET data=json_set(data, '$.deliveryState', ?) WHERE app_id=? AND fingerprint=?",
      )
      .bind(deliveryState, appId, fingerprint)
      .run();
  }
  listPosts(appId: string): Promise<PostRecord[]> {
    return list(
      this.db,
      "SELECT data FROM posts WHERE app_id=? ORDER BY published_at DESC, fingerprint",
      appId,
    );
  }
  listRecentPosts(kind?: PostKind, limit = 50): Promise<PostRecord[]> {
    return kind == null
      ? list(
          this.db,
          "SELECT data FROM posts ORDER BY published_at DESC, app_id, fingerprint LIMIT ?",
          limit,
        )
      : list(
          this.db,
          "SELECT data FROM posts WHERE kind=? ORDER BY published_at DESC, app_id, fingerprint LIMIT ?",
          kind,
          limit,
        );
  }
  async countPosts(kind?: PostKind): Promise<number> {
    const statement =
      kind == null
        ? this.db.prepare("SELECT count(*) AS count FROM posts")
        : this.db
            .prepare("SELECT count(*) AS count FROM posts WHERE kind=?")
            .bind(kind);
    return (await statement.first<number>("count"))!;
  }
}

export class FollowerRepository {
  constructor(private readonly db: D1Database) {}
  async put(record: FollowerRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO followers VALUES (?, ?, ?) ON CONFLICT(app_id, actor_id) DO UPDATE SET data=excluded.data",
      )
      .bind(record.appId, record.actorId, JSON.stringify(record))
      .run();
  }
  async delete(appId: string, actorId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM followers WHERE app_id=? AND actor_id=?")
      .bind(appId, actorId)
      .run();
  }
  list(appId: string): Promise<FollowerRecord[]> {
    return list(
      this.db,
      "SELECT data FROM followers WHERE app_id=? ORDER BY actor_id",
      appId,
    );
  }
  async count(): Promise<number> {
    return (await this.db
      .prepare("SELECT count(*) AS count FROM followers")
      .first<number>("count"))!;
  }
}

export class FeedRepository {
  constructor(
    private readonly db: D1Database,
    private readonly apps: AppRepository,
  ) {}
  async replaceAppSnapshot(
    feedId: string,
    appIds: string[],
  ): Promise<{ hadPrevious: boolean; addedAppIds: string[] }> {
    const previous = await this.snapshotIds(feedId);
    await this.db
      .prepare(
        "INSERT INTO feed_snapshots VALUES (?, ?) ON CONFLICT(feed_id) DO UPDATE SET data=excluded.data",
      )
      .bind(feedId, JSON.stringify(appIds))
      .run();
    return {
      hadPrevious: previous !== null,
      addedAppIds: appIds.filter((id) => !previous?.includes(id)),
    };
  }
  snapshotIds(feedId: string): Promise<string[] | null> {
    return read(
      this.db,
      "SELECT data FROM feed_snapshots WHERE feed_id=?",
      feedId,
    );
  }
  async listAppProfiles(feedId: string, limit = 50): Promise<AppProfile[]> {
    const profiles = await Promise.all(
      ((await this.snapshotIds(feedId)) ?? [])
        .slice(0, limit)
        .map((id) => this.apps.get(id)),
    );
    return profiles.filter(
      (profile): profile is AppProfile => profile !== null,
    );
  }
  async countAppProfiles(feedId: string): Promise<number> {
    return (await this.snapshotIds(feedId))?.length ?? 0;
  }
}

export class StateRepository {
  constructor(private readonly db: D1Database) {}
  get<T>(id: string): Promise<T | null> {
    return read(this.db, "SELECT data FROM state WHERE id=?", id);
  }
  async set<T>(id: string, state: T): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO state VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .bind(id, JSON.stringify(state))
      .run();
  }
  getCrawlState(): Promise<CrawlState | null> {
    return this.get("recentlyUpdated");
  }
  setCrawlState(state: CrawlState): Promise<void> {
    return this.set("recentlyUpdated", state);
  }
  getRecentlyAddedState(): Promise<RecentlyAddedState | null> {
    return this.get("recentlyAdded");
  }
  setRecentlyAddedState(state: RecentlyAddedState): Promise<void> {
    return this.set("recentlyAdded", state);
  }
  getBootstrapState(): Promise<BootstrapState | null> {
    return this.get("bootstrap");
  }
  setBootstrapState(state: BootstrapState): Promise<void> {
    return this.set("bootstrap", state);
  }
}

export interface Repositories {
  apps: AppRepository;
  releases: ReleaseRepository;
  followers: FollowerRepository;
  feeds: FeedRepository;
  state: StateRepository;
}

export function createRepositories(db: D1Database): Repositories {
  const apps = new AppRepository(db);
  return {
    apps,
    releases: new ReleaseRepository(db),
    followers: new FollowerRepository(db),
    feeds: new FeedRepository(db, apps),
    state: new StateRepository(db),
  };
}
