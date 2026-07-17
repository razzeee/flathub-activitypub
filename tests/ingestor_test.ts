import { assertEquals, assertRejects } from "@std/assert";
import type { Config } from "../src/config.ts";
import { createFedifyFederation } from "../src/federation/fedify.ts";
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
      description:
        '<p>Long <strong>description</strong></p><script>alert("x")</script>',
      releases: [
        { version: "2", timestamp: 200, description: "<p>New</p>" },
        { version: "1", timestamp: 100, description: "<p>Old</p>" },
      ],
    });

    await new Ingestor(config, client as never, repos).bootstrap();

    const posts = await repos.releases.listPosts("org.example.App");
    assertEquals(posts.length, 1);
    assertEquals(posts[0].contentHtml.includes("Example 2"), true);
    assertEquals(
      (await repos.apps.get("org.example.App"))?.descriptionHtml,
      "<p>Long <strong>description</strong></p>",
    );
    let releases = 0;
    for await (
      const _entry of kv.list({ prefix: ["release", "org.example.App"] })
    ) releases++;
    assertEquals(releases, 2);
  } finally {
    kv.close();
  }
});

Deno.test("bootstrap ignores future-dated releases when choosing latest", async () => {
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
        {
          version: "Future",
          timestamp: 4_102_444_800,
          description: "<p>Future</p>",
        },
        { version: "Current", timestamp: 200, description: "<p>Current</p>" },
      ],
    });

    await new Ingestor(config, client as never, repos).bootstrap();

    const posts = await repos.releases.listPosts("org.example.App");
    assertEquals(posts.length, 1);
    assertEquals(posts[0].contentHtml.includes("Example Current"), true);
    assertEquals(posts[0].publishedAt, "1970-01-01T00:03:20.000Z");
  } finally {
    kv.close();
  }
});

Deno.test("poll creates release posts without treating local first-seen apps as new", async () => {
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
    assertEquals((await repos.releases.listRecentPosts("release")).length, 1);
    assertEquals((await repos.releases.listRecentPosts("new-app")).length, 0);
    assertEquals((await repos.state.getCrawlState())?.watermarkUpdatedAt, 100);
  } finally {
    kv.close();
  }
});

Deno.test("poll delivery materializes actor keys before sending activities", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const federation = createFedifyFederation(config, kv);
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
    await repos.followers.put({
      appId: "org.example.App",
      actorId: "https://remote.example/users/alice",
      inboxUrl: "https://remote.example/inbox",
      acceptedAt: "1970-01-01T00:00:00.000Z",
    });

    await new Ingestor(config, client as never, repos, federation).poll();

    assertEquals((await repos.releases.listRecentPosts("release")).length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("poll retries queued release delivery after transient delivery failure", async () => {
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
    let sends = 0;
    const federation = {
      createContext() {
        return {
          getActorUri: (id: string) =>
            new URL(`https://example.org/apps/${id}`),
          getFollowersUri: (id: string) =>
            new URL(`https://example.org/apps/${id}/followers`),
          sendActivity: () => {
            sends++;
            if (sends === 1) throw new Error("transient delivery failure");
            return Promise.resolve();
          },
        };
      },
    };
    const ingestor = new Ingestor(
      config,
      client as never,
      repos,
      federation as never,
    );

    await assertRejects(
      () => ingestor.poll(),
      Error,
      "transient delivery failure",
    );
    const failedPost = (await repos.releases.listRecentPosts("release"))[0];
    const failed = await repos.releases.getPost(
      "org.example.App",
      failedPost.releaseFingerprint,
    );
    assertEquals(failed?.deliveryState, "failed");

    await ingestor.poll();

    const post = (await repos.releases.listRecentPosts("release"))[0];
    assertEquals(post.deliveryState, "delivered");
    assertEquals(sends >= 3, true);
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

    assertEquals((await repos.releases.listRecentPosts("release")).length, 0);
    assertEquals((await repos.releases.listRecentPosts("new-app")).length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("recently-added feed baselines first, then publishes official new app posts", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 0,
      totalPages: 1,
      totalHits: 0,
      hits: [],
    });
    client.addedPages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{
        appId: "org.old.App",
        name: "Old",
        updatedAt: 100,
        addedAt: 100,
      }],
    });
    const ingestor = new Ingestor(config, client as never, repos);

    await ingestor.poll();

    assertEquals((await repos.releases.listRecentPosts("new-app")).length, 0);
    assertEquals(
      (await repos.state.getRecentlyAddedState())?.watermarkAddedAt,
      100,
    );

    client.addedPages.set(1, {
      page: 1,
      hitsPerPage: 2,
      totalPages: 1,
      totalHits: 2,
      hits: [
        {
          appId: "org.new.App",
          name: "New",
          summary: "Officially recent",
          updatedAt: 200,
          addedAt: 200,
        },
        {
          appId: "org.old.App",
          name: "Old",
          updatedAt: 100,
          addedAt: 100,
        },
      ],
    });

    await ingestor.poll();

    const posts = await repos.releases.listRecentPosts("new-app");
    assertEquals(posts.length, 1);
    assertEquals(posts[0].appId, "org.new.App");
    assertEquals(posts[0].contentHtml.includes("was added to Flathub"), true);
    assertEquals(posts[0].contentHtml.includes("#NewOnFlathub"), true);
    assertEquals(posts[0].publishedAt, "1970-01-01T00:03:20.000Z");
    assertEquals(
      (await repos.state.getRecentlyAddedState())?.watermarkAddedAt,
      200,
    );
  } finally {
    kv.close();
  }
});

Deno.test("recently-added feed does not establish an empty zero baseline", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 0,
      totalPages: 1,
      totalHits: 0,
      hits: [],
    });
    const ingestor = new Ingestor(config, client as never, repos);

    await ingestor.poll();

    assertEquals(await repos.state.getRecentlyAddedState(), null);

    client.addedPages.set(1, {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{
        appId: "org.actual.Baseline",
        name: "Actual Baseline",
        updatedAt: 300,
        addedAt: 300,
      }],
    });

    await ingestor.poll();

    assertEquals((await repos.releases.listRecentPosts("new-app")).length, 0);
    assertEquals(
      (await repos.state.getRecentlyAddedState())?.watermarkAddedAt,
      300,
    );
  } finally {
    kv.close();
  }
});

Deno.test("poll stores app-list feed snapshots from Flathub collection APIs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    const client = new FakeFlathubClient();
    client.pages.set(1, {
      page: 1,
      hitsPerPage: 0,
      totalPages: 1,
      totalHits: 0,
      hits: [],
    });
    client.collectionPages.set("trending:1", {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{
        appId: "org.trending.App",
        name: "Trending",
        updatedAt: 300,
      }],
    });
    client.collectionPages.set("popular:1", {
      page: 1,
      hitsPerPage: 1,
      totalPages: 1,
      totalHits: 1,
      hits: [{
        appId: "org.popular.App",
        name: "Popular",
        updatedAt: 200,
      }],
    });

    await new Ingestor(config, client as never, repos).poll();

    const trending = await repos.feeds.listAppProfiles("trending-apps");
    const popular = await repos.feeds.listAppProfiles("popular-apps");
    assertEquals(trending.map((app) => app.appId), ["org.trending.App"]);
    assertEquals(popular.map((app) => app.appId), ["org.popular.App"]);
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
