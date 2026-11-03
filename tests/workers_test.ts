import { test, expect, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { openDatabase } from "./helpers.ts";
import worker, {
  processIngestion,
  type Env,
  type IngestionMessage,
} from "../src/main.ts";
import { loadConfig } from "../src/config.ts";
import { createApp, handler } from "../src/server.ts";
import { Ingestor, type CrawlJob } from "../src/ingestion/ingestor.ts";
import { FakeFlathubClient } from "../src/testing/fake_client.ts";
import { createRepositories } from "../src/store/d1_store.ts";
import { D1KvStore } from "../src/store/fedify_kv.ts";
import { FlathubClient } from "../src/flathub/client.ts";

test("a resumed crawl keeps its original page size across configuration changes", async () => {
  const { db, close } = await openDatabase();
  try {
    const sent: IngestionMessage[] = [];
    const env = {
      DB: db,
      INGESTION_QUEUE: {
        send: async (message: IngestionMessage) => {
          sent.push(message);
        },
      },
    } as unknown as Env;
    const hits = Array.from({ length: 4 }, (_, index) => ({
      app_id: `app-${index}`,
      name: `App ${index}`,
      updated_at: 100 + index,
    }));
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/appstream/"))
        return Response.json({
          releases: [
            { version: "1", timestamp: 100, description: "<p>Release</p>" },
          ],
        });
      const size = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      return Response.json({
        page,
        totalPages: Math.ceil(hits.length / size),
        hits: url.pathname.endsWith("/collection/recently-updated")
          ? hits.slice((page - 1) * size, page * size)
          : [],
      });
    };
    const firstConfig = loadConfig({ RECENTLY_UPDATED_PER_PAGE: "2" });
    const first = createApp(firstConfig, db);
    first.ingestor = new Ingestor(
      firstConfig,
      new FlathubClient(firstConfig.flathubApiBase, fetcher),
      first.repos,
    );
    await processIngestion({ kind: "poll", id: "run" }, env, first);
    for (let i = 0; i < 3; i++)
      await processIngestion(sent.shift()!, env, first);
    expect((await first.repos.state.get<CrawlJob>("job:poll"))?.page).toBe(2);
    const nextConfig = loadConfig({ RECENTLY_UPDATED_PER_PAGE: "4" });
    const resumed = createApp(nextConfig, db);
    resumed.ingestor = new Ingestor(
      nextConfig,
      new FlathubClient(nextConfig.flathubApiBase, fetcher),
      resumed.repos,
    );
    let steps = 0;
    while (sent.length) {
      expect(++steps).toBeLessThan(50);
      await processIngestion(sent.shift()!, env, resumed);
    }
    expect(await resumed.repos.apps.count()).toBe(4);
    expect(await resumed.repos.releases.countPosts()).toBe(4);
  } finally {
    await close();
  }
});

test("bootstrap recovery restarts safely when its durable cursor is missing", async () => {
  const { db, close } = await openDatabase();
  try {
    const config = loadConfig({});
    const app = createApp(config, db);
    await app.repos.state.setBootstrapState({
      currentPage: 20,
      completed: false,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect((await app.ingestor.newJob("bootstrap", "restart")).page).toBe(1);
  } finally {
    await close();
  }
});

test.each([
  { kind: "poll" as const, status: 404 },
  { kind: "poll" as const, status: 410 },
  { kind: "bootstrap" as const, status: 404 },
  { kind: "bootstrap" as const, status: 410 },
])(
  "$kind continues past a checkpointed app returning $status",
  async ({ kind, status }) => {
    const { db, close } = await openDatabase();
    try {
      const sent: IngestionMessage[] = [];
      const env = {
        DB: db,
        INGESTION_QUEUE: {
          send: async (message: IngestionMessage) => {
            sent.push(message);
          },
        },
      } as unknown as Env;
      const config = loadConfig(env);
      const app = createApp(config, db);
      let removed = false;
      const client = new FlathubClient(config.flathubApiBase, async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/appstream/removed"))
          return new Response(null, { status });
        if (path.endsWith("/appstream/healthy"))
          return Response.json({
            releases: [
              { version: "1", timestamp: 200, description: "<p>Release</p>" },
            ],
          });
        const hits = path.endsWith("/collection/recently-updated")
          ? [
              ...(removed
                ? []
                : [{ app_id: "removed", name: "Removed", updated_at: 100 }]),
              { app_id: "healthy", name: "Healthy", updated_at: 200 },
            ]
          : [];
        return Response.json({ page: 1, totalPages: 1, hits });
      });
      app.ingestor = new Ingestor(config, client, app.repos);
      await processIngestion({ kind, id: "initial" }, env, app);
      removed = true; // The live collection has moved on, but the durable page still contains the app.
      let steps = 0;
      while (sent.length) {
        expect(++steps).toBeLessThan(50);
        await processIngestion(sent.shift()!, env, app);
      }
      expect((await app.repos.state.get<CrawlJob>(`job:${kind}`))?.phase).toBe(
        "done",
      );
      expect(await app.repos.releases.countPosts()).toBe(1);
      expect(await app.repos.apps.get("removed")).toBeNull();
      if (kind === "poll")
        expect(
          (await app.repos.state.getCrawlState())?.watermarkUpdatedAt,
        ).toBe(200);
      else
        expect((await app.repos.state.getBootstrapState())?.completed).toBe(
          true,
        );
    } finally {
      await close();
    }
  },
);

test.each([429, 503])(
  "transient AppStream HTTP %s retains the checkpoint for a successful retry",
  async (status) => {
    const { db, close } = await openDatabase();
    try {
      const sent: IngestionMessage[] = [];
      const env = {
        DB: db,
        INGESTION_QUEUE: {
          send: async (message: IngestionMessage) => {
            sent.push(message);
          },
        },
      } as unknown as Env;
      const config = loadConfig(env);
      const app = createApp(config, db);
      let failing = true;
      const client = new FlathubClient(config.flathubApiBase, async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.includes("/appstream/"))
          return failing
            ? new Response(null, { status })
            : Response.json({
                releases: [
                  {
                    version: "1",
                    timestamp: 200,
                    description: "<p>Release</p>",
                  },
                ],
              });
        return Response.json({
          page: 1,
          totalPages: 1,
          hits: path.endsWith("/collection/recently-updated")
            ? [{ app_id: "healthy", name: "Healthy", updated_at: 200 }]
            : [],
        });
      });
      app.ingestor = new Ingestor(config, client, app.repos);
      await processIngestion({ kind: "poll", id: "retry" }, env, app);
      const before = await app.repos.state.get("job:poll");
      const message = sent.shift()!;
      await expect(processIngestion(message, env, app)).rejects.toThrow(
        "failed to fetch AppStream",
      );
      expect(await app.repos.state.get("job:poll")).toEqual(before);
      expect(await app.repos.state.getCrawlState()).toBeNull();
      failing = false;
      await processIngestion(message, env, app);
      let steps = 0;
      while (sent.length) {
        expect(++steps).toBeLessThan(50);
        await processIngestion(sent.shift()!, env, app);
      }
      expect(await app.repos.releases.countPosts()).toBe(1);
      expect((await app.repos.state.getCrawlState())?.watermarkUpdatedAt).toBe(
        200,
      );
    } finally {
      await close();
    }
  },
);

test("D1 deduplicates concurrent post creation and keeps the original publication date", async () => {
  const { db, close } = await openDatabase();
  try {
    const repos = createRepositories(db);
    const release = {
      appId: "app",
      fingerprint: "release",
      version: "1",
      timestamp: "100",
      date: "",
      type: "",
      urgency: "",
      descriptionHtml: "<p>Hello</p>",
      firstSeenAt: "2026-01-01T00:00:00Z",
    };
    const post = {
      appId: "app",
      releaseFingerprint: "release",
      noteId: "https://example.org/note",
      createActivityId: "https://example.org/create",
      contentHtml: "<p>Hello</p>",
      publishedAt: "2026-01-01T00:00:00Z",
      deliveryState: "queued" as const,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repos.releases.createPostIfAbsent(release, post),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await repos.releases.createPostIfAbsent(release, {
      ...post,
      publishedAt: "2026-02-01T00:00:00Z",
    });
    expect((await repos.releases.get("app", "release"))?.publishedAt).toBe(
      post.publishedAt,
    );
    expect(await repos.releases.countPosts()).toBe(1);
    await repos.apps.upsertFromHit({ appId: "app", name: "App", updatedAt: 1 });
    await repos.apps.upsertFromHit({ appId: "app", name: "App", updatedAt: 2 });
    expect(await repos.apps.listRecent()).toHaveLength(1);
  } finally {
    await close();
  }
});

test("D1 Fedify cache supports structured prefixes, expiry and deletion", async () => {
  const { db, close } = await openDatabase();
  try {
    const kv = new D1KvStore(db);
    await kv.set(["a"], null);
    await kv.set(["a", "b"], { hello: true });
    await kv.set(["ab"], "not a child");
    await db
      .prepare("INSERT INTO fedify_kv VALUES (?, ?, ?)")
      .bind('["a","expired"]', '"old"', Date.now() - 1)
      .run();
    expect(await kv.get(["a"])).toBeNull();
    expect(await kv.get(["a", "missing"])).toBeUndefined();
    expect(await kv.get(["a", "expired"])).toBeUndefined();
    const entries = [];
    for await (const entry of kv.list(["a"])) entries.push(entry);
    expect(entries).toHaveLength(2);
    await kv.delete(["a", "b"]);
    expect(await kv.get(["a", "b"])).toBeUndefined();
    await kv.prune();
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM fedify_kv")
        .first("count"),
    ).toBe(2);
  } finally {
    await close();
  }
});

test("ingestion checkpoints one app at a time, recovers a failed continuation, and ignores stale jobs", async () => {
  const { db, close } = await openDatabase();
  try {
    const sent: IngestionMessage[] = [];
    let failSend = false;
    const env = {
      DB: db,
      ORIGIN: "https://example.org",
      INGESTION_QUEUE: {
        send: async (message: IngestionMessage) => {
          if (failSend) throw new Error("queue unavailable");
          sent.push(message);
        },
      },
    } as unknown as Env;
    const config = loadConfig(env);
    const app = createApp(config, db);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 2,
      totalPages: 1,
      totalHits: 2,
      hits: [
        { appId: "a", name: "A", updatedAt: 100 },
        { appId: "b", name: "B", updatedAt: 200 },
      ],
    });
    for (const appId of ["a", "b"])
      client.apps.set(appId, {
        appId,
        releases: [
          { version: "1", timestamp: 100, description: "<p>Release</p>" },
        ],
      });
    app.ingestor = new Ingestor(config, client as never, app.repos);
    const initial: IngestionMessage = { kind: "poll", id: "first" };
    await processIngestion(initial, env, app); // Fetch the first page.
    expect(await app.repos.apps.count()).toBe(0);
    const continuation = sent.shift()!;
    failSend = true;
    await expect(processIngestion(continuation, env, app)).rejects.toThrow(
      "queue unavailable",
    );
    expect(await app.repos.apps.count()).toBe(1);
    expect(await app.repos.state.getCrawlState()).toBeNull();
    failSend = false;
    await processIngestion(continuation, env, app);
    expect(await app.repos.apps.count()).toBe(2);
    while (sent.length) await processIngestion(sent.shift()!, env, app);
    expect((await app.repos.state.getCrawlState())?.watermarkUpdatedAt).toBe(
      200,
    );
    expect(await app.repos.releases.countPosts()).toBe(2);
    await processIngestion(initial, env, app);
    expect(sent).toHaveLength(0);
    await processIngestion({ kind: "poll", id: "new" }, env, app);
    const state = await app.repos.state.get<CrawlJob>("job:poll");
    await processIngestion({ ...initial, continuation: true }, env, app);
    expect(await app.repos.state.get("job:poll")).toEqual(state);
  } finally {
    await close();
  }
});

test("internal ingestion responds 202 only after enqueue and never runs the crawl inline", async () => {
  const { db, close } = await openDatabase();
  try {
    const app = createApp(loadConfig({ INTERNAL_API_TOKEN: "secret" }), db);
    app.enqueueIngestion = vi.fn(async () => {});
    app.ingestor.poll = vi.fn(async () => {
      throw new Error("must not run inline");
    });
    const response = await handler(app)(
      new Request("http://localhost/internal/ingest/poll", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(response.status).toBe(202);
    expect(app.enqueueIngestion).toHaveBeenCalledWith("poll");
    expect(app.ingestor.poll).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

test("queue failures retry instead of acknowledging the task", async () => {
  const { db, close } = await openDatabase();
  try {
    const ack = vi.fn();
    const retry = vi.fn();
    const env = {
      DB: db,
      INGESTION_QUEUE: {
        send: vi.fn(async () => {
          throw new Error("unavailable");
        }),
      },
      FEDERATION_QUEUE: {},
    } as unknown as Env;
    await createRepositories(db).state.set<CrawlJob>("job:poll", {
      id: "job",
      kind: "poll",
      phase: "updated",
      page: 1,
      perPage: 10,
      index: 0,
      watermark: 0,
      nextWatermark: 0,
      baseline: false,
      collectionIndex: 0,
      result: {
        page: 1,
        hitsPerPage: 10,
        totalPages: 1,
        totalHits: 0,
        hits: [],
      },
    });
    await worker.queue(
      {
        queue: "flathub-ingestion",
        messages: [
          {
            id: "message",
            body: { kind: "poll", id: "job" },
            attempts: 2,
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      env,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  } finally {
    await close();
  }
});

test("bundled Worker starts, serves federation keys consistently, and handles scheduled events in workerd", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/main.js",
      compatibilityDate: "2026-11-03",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { ORIGIN: "https://example.org", INTERNAL_API_TOKEN: "secret" },
      queueProducers: {
        FEDERATION_QUEUE: "flathub-federation",
        INGESTION_QUEUE: "flathub-ingestion",
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await db.exec(
      await readFile(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    const health = await mf.dispatchFetch("https://example.org/healthz");
    expect(health.status).toBe(200);
    const keys = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const response = await mf.dispatchFetch(
          "https://example.org/apps/new-apps",
          { headers: { accept: "application/activity+json" } },
        );
        expect(response.status).toBe(200);
        const actor = (await response.json()) as {
          publicKey: { publicKeyPem: string };
        };
        return actor.publicKey.publicKeyPem;
      }),
    );
    expect(keys[0]).toContain("PUBLIC KEY");
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM actor_keys")
        .first("count"),
    ).toBe(2);
    const queued = await mf.dispatchFetch(
      "https://example.org/internal/ingest/poll",
      { method: "POST", headers: { authorization: "Bearer secret" } },
    );
    expect(queued.status).toBe(202);
    const entrypoint = await mf.getWorker();
    await entrypoint.scheduled({ cron: "*/5 * * * *" });
  } finally {
    await mf.dispose();
  }
});
