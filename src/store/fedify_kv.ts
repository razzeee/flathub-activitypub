import type {
  KvKey,
  KvStore,
  KvStoreListEntry,
  KvStoreSetOptions,
} from "@fedify/fedify";

/** Fedify's transient cache and deduplication state, not actor signing keys. */
export class D1KvStore implements KvStore {
  constructor(private readonly db: D1Database) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const row = await this.db
      .prepare(
        "SELECT value FROM fedify_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)",
      )
      .bind(JSON.stringify(key), Date.now())
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: KvStoreSetOptions,
  ): Promise<void> {
    const expiresAt =
      options?.ttl == null
        ? null
        : Date.now() + options.ttl.total("milliseconds");
    await this.db
      .prepare(
        "INSERT INTO fedify_kv VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
      )
      .bind(JSON.stringify(key), JSON.stringify(value), expiresAt)
      .run();
  }

  async delete(key: KvKey): Promise<void> {
    await this.db
      .prepare("DELETE FROM fedify_kv WHERE key=?")
      .bind(JSON.stringify(key))
      .run();
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    let cursor = "";
    const exact = JSON.stringify(prefix ?? []);
    const nested = exact.slice(0, -1) + ",";
    while (true) {
      const { results } = await this.db
        .prepare(
          "SELECT key, value FROM fedify_kv WHERE key>? AND (expires_at IS NULL OR expires_at>?) AND (?=1 OR key=? OR substr(key,1,?)=?) ORDER BY key LIMIT 100",
        )
        .bind(
          cursor,
          Date.now(),
          prefix == null ? 1 : 0,
          exact,
          nested.length,
          nested,
        )
        .all<{ key: string; value: string }>();
      for (const row of results) {
        yield {
          key: JSON.parse(row.key) as KvKey,
          value: JSON.parse(row.value),
        };
      }
      if (results.length < 100) return;
      cursor = results[results.length - 1].key;
    }
  }

  async prune(): Promise<void> {
    await this.db
      .prepare("DELETE FROM fedify_kv WHERE expires_at<=?")
      .bind(Date.now())
      .run();
  }
}
