import { assertEquals, assertRejects } from "@std/assert";
import type { Config } from "../src/config.ts";
import { Ingestor } from "../src/ingestion/ingestor.ts";
import { createRepositories } from "../src/store/kv_store.ts";
import { FakeFlathubClient } from "../src/testing/fake_client.ts";

const config: Config = {
  origin: "https://example.org",
  port: 8000,
  flathubApiBase: "https://flathub.org/api/v2",
  recentlyUpdatedPerPage: 2,
  recentlyUpdatedOverlapSeconds: 3600,
  crawlIntervalSeconds: 300,
  bootstrapThrottleMs: 0,
};

Deno.test("bootstrap publishes only the latest described release and stores older fingerprints", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{ appId: "org.example.App", name: "Example", updatedAt: 100 }],
    });
    client.apps.set("org.example.App", {
      appId: "org.example.App",
      releases: [
        { version: "2", timestamp: 200, description: "<p>New</p>" },
        { version: "1", timestamp: 100, description: "<p>Old</p>" },
      ],
    });

    await new Ingestor(config, client as never, repos).bootstrap();

    const posts = await repos.releases.listPosts("org.example.App");
    assertEquals(posts.length, 1);
    assertEquals(posts[0].contentHtml.includes("Example 2"), true);
    let releases = 0;
    for await (
      const _entry of kv.list({ prefix: ["release", "org.example.App"] })
    ) releases++;
    assertEquals(releases, 2);
  } finally {
    kv.close();
  }
});

Deno.test("poll creates exactly one post for a new described release", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{ appId: "org.example.App", name: "Example", updatedAt: 100 }],
    });
    client.apps.set("org.example.App", {
      appId: "org.example.App",
      releases: [{ version: "1", timestamp: 100, description: "<p>First</p>" }],
    });
    const ingestor = new Ingestor(config, client as never, repos);

    await ingestor.poll();
    await ingestor.poll();

    assertEquals((await repos.releases.listPosts("org.example.App")).length, 1);
    assertEquals((await repos.state.getCrawlState())?.watermarkUpdatedAt, 100);
  } finally {
    kv.close();
  }
});

Deno.test("poll skips releases without description", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{ appId: "org.example.App", name: "Example", updatedAt: 100 }],
    });
    client.apps.set("org.example.App", {
      appId: "org.example.App",
      releases: [{ version: "1", timestamp: 100, description: "" }],
    });

    await new Ingestor(config, client as never, repos).poll();

    assertEquals((await repos.releases.listPosts("org.example.App")).length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("poll does not advance watermark when AppStream fetch fails", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{ appId: "org.example.App", name: "Example", updatedAt: 100 }],
    });

    await assertRejects(
      () => new Ingestor(config, client as never, repos).poll(),
      Error,
      "failed to fetch AppStream",
    );

    assertEquals(await repos.state.getCrawlState(), null);
  } finally {
    kv.close();
  }
});
