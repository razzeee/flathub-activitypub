import { test } from "vitest";
import { assertEquals, assertStringIncludes, openDatabase } from "./helpers.ts";
import type { Config } from "../src/config.ts";
import { createRepositories } from "../src/store/d1_store.ts";
import { handler } from "../src/server.ts";
import { Ingestor } from "../src/ingestion/ingestor.ts";
import { FakeFlathubClient } from "../src/testing/fake_client.ts";
import { createFedifyFederation } from "../src/federation/fedify.ts";

interface ActorDocument {
  type: string; preferredUsername: string; name: string; summary: string;
  publicKey: { id: string }; endpoints: { sharedInbox: string };
  attachment: { type: string; name: string; value: string }[];
}
interface OutboxDocument {
  totalItems: number;
  orderedItems: { type: string; actor: string; object: string }[];
}

const config: Config = {
  origin: "https://example.org",
  fedifyQueue: "none",
  flathubApiBase: "https://flathub.org/api/v2",
  recentlyUpdatedPerPage: 2,
  recentlyUpdatedOverlapSeconds: 3600,
  crawlScheduler: "cron",
};

test("actor and WebFinger routes expose ingested app", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: 'A <web> browser & "more"',
      updatedAt: 1,
    });
    await repos.apps.upsertFromHit({
      appId: "org.gnome.TextEditor",
      name: "Text Editor",
      summary: "Plain summary",
      descriptionHtml: "<p>Long <strong>description</strong></p>",
      updatedAt: 2,
    });
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
    };
    const serve = handler(app);

    const actorResponse = await serve(
      new Request("https://example.org/apps/org.mozilla.firefox", {
        headers: { accept: "application/activity+json" },
      }),
    );
    const actor = await actorResponse.json<ActorDocument>();
    assertEquals(actor.type, "Service");
    assertEquals(actor.preferredUsername, "org.mozilla.firefox");
    assertEquals(actor.name, "Firefox");
    assertStringIncludes(actor.summary, "A &lt;web&gt; browser &amp; &quot;more&quot;");
    assertEquals(actor.summary.includes('A <web> browser & "more"'), false);
    assertStringIncludes(actor.summary, "Unofficial release feed from Flathub");
    assertStringIncludes(actor.summary, "Not affiliated with the app developers");
    assertEquals(actor.attachment, [{
      type: "PropertyValue",
      name: "Flathub",
      value: '<a href="https://flathub.org/apps/org.mozilla.firefox" rel="me">org.mozilla.firefox</a>',
    }]);
    assertEquals(typeof actor.publicKey.id, "string");
    assertEquals(actor.endpoints.sharedInbox, "https://example.org/inbox");

    const ldResponse = await serve(
      new Request("https://example.org/apps/org.mozilla.firefox", {
        headers: { accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
      }),
    );
    const ldActor = await ldResponse.json<ActorDocument>();
    assertEquals(ldActor.attachment, actor.attachment);

    const describedActorResponse = await serve(
      new Request("https://example.org/apps/org.gnome.TextEditor", {
        headers: { accept: "application/activity+json" },
      }),
    );
    const describedActor = await describedActorResponse.json<ActorDocument>();
    assertStringIncludes(
      describedActor.summary,
      "<p>Plain summary</p>",
    );
    assertEquals(describedActor.summary.includes("Long"), false);

    const wfResponse = await serve(
      new Request(
        "https://example.org/.well-known/webfinger?resource=acct:org.mozilla.firefox@example.org",
      ),
    );
    const wf = await wfResponse.json<{ subject: string }>();
    assertEquals(wf.subject, "acct:org.mozilla.firefox@example.org");

    const feedActorResponse = await serve(
      new Request("https://example.org/apps/recent-releases", {
        headers: { accept: "application/activity+json" },
      }),
    );
    const feedActor = await feedActorResponse.json<ActorDocument>();
    assertEquals(feedActor.type, "Service");
    assertEquals(feedActor.preferredUsername, "recent-releases");
    assertEquals(feedActor.attachment, undefined);

    const feedWfResponse = await serve(
      new Request(
        "https://example.org/.well-known/webfinger?resource=acct:recent-releases@example.org",
      ),
    );
    const feedWf = await feedWfResponse.json<{ subject: string }>();
    assertEquals(feedWf.subject, "acct:recent-releases@example.org");

    const landing = await (await serve(new Request(config.origin))).text();
    assertStringIncludes(landing, "Release notes in your timeline");
    assertStringIncludes(
      landing,
      'data-app-search="Firefox org.mozilla.firefox A &lt;web&gt; browser &amp; &quot;more&quot;"',
    );
    const profilePage = await (await serve(
      new Request(`${config.origin}/apps/org.mozilla.firefox`),
    )).text();
    assertStringIncludes(
      profilePage,
      'data-copy-handle="@org.mozilla.firefox@example.org"',
    );
  } finally {
    await close();
  }
});

test("an empty directory offers feeds without an unusable app filter", async () => {
  const { db, close } = await openDatabase();
  try {
    const repos = createRepositories(db);
    const serve = handler({
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, db),
    });
    const response = await serve(new Request(config.origin));
    const page = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(page, "No apps indexed yet");
    assertStringIncludes(page, 'href="#feed-actors">Browse the feeds</a>');
    assertStringIncludes(page, 'href="/apps/recent-releases"');
    assertStringIncludes(page, 'href="/apps/new-apps"');
    assertEquals(page.includes('id="app-search"'), false);
  } finally {
    await close();
  }
});

test("browser pages list apps and inline releases", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: "A web browser",
      updatedAt: 100,
    });
    await repos.apps.upsertFromHit({
      appId: "org.gnome.Calculator",
      name: "Calculator",
      summary: "A calculator",
      updatedAt: 101,
    });
    await repos.releases.createPostIfAbsent({
      appId: "org.mozilla.firefox",
      fingerprint: "abc123",
      version: "1.0.0",
      timestamp: "100",
      date: "1970-01-01",
      type: "stable",
      urgency: "medium",
      descriptionHtml: "<p>Release notes</p>",
      firstSeenAt: "1970-01-01T00:00:00.000Z",
    }, {
      appId: "org.mozilla.firefox",
      releaseFingerprint: "abc123",
      noteId: "https://example.org/apps/org.mozilla.firefox/releases/abc123",
      createActivityId:
        "https://example.org/apps/org.mozilla.firefox/releases/abc123#create",
      contentHtml: "<p><strong>Firefox 1.0.0</strong> was released.</p>",
      publishedAt: "1970-01-01T00:01:40.000Z",
      deliveryState: "queued",
    });
    await repos.releases.createStandalonePostIfAbsent({
      appId: "org.mozilla.firefox",
      releaseFingerprint: "new-app",
      kind: "new-app",
      noteId: "https://example.org/apps/org.mozilla.firefox/posts/new-app",
      createActivityId:
        "https://example.org/apps/org.mozilla.firefox/posts/new-app#create",
      contentHtml: "<p>Firefox was added to Flathub.</p>",
      publishedAt: "1970-01-01T00:01:41.000Z",
      deliveryState: "queued",
    });
    await repos.releases.createStandalonePostIfAbsent({
      appId: "org.gnome.Calculator",
      releaseFingerprint: "new-app",
      kind: "new-app",
      noteId: "https://example.org/apps/org.gnome.Calculator/posts/new-app",
      createActivityId:
        "https://example.org/apps/org.gnome.Calculator/posts/new-app#create",
      contentHtml: "<p>Calculator was added to Flathub.</p><p>For &lt;simple&gt; &amp; everyday maths.</p>",
      publishedAt: "1970-01-01T00:01:42.000Z",
      deliveryState: "queued",
    });
    await repos.feeds.replaceAppSnapshot("trending-apps", [
      "org.mozilla.firefox",
    ]);
    await repos.feeds.replaceAppSnapshot("popular-apps", [
      "org.gnome.Calculator",
    ]);
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
      fetcher: () => Promise.resolve(new Response(null, { status: 404 })),
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    };
    const serve = handler(app);

    const landingResponse = await serve(new Request("https://example.org/"));
    const landing = await landingResponse.text();
    assertEquals(landingResponse.status, 200);
    assertStringIncludes(landing, ">Follow app updates</h1>");
    assertStringIncludes(landing, '<link rel="stylesheet" href="/styles.css">');
    assertStringIncludes(landing, '<script type="module" src="/ui.js"></script>');
    assertEquals(landing.includes("<style>"), false);
    assertStringIncludes(landing, 'id="app-search"');
    assertStringIncludes(landing, "Latest from Flathub");
    assertStringIncludes(landing, "Calculator was added to Flathub.");
    assertStringIncludes(
      landing,
      '>Calculator was added to Flathub. For &lt;simple&gt; &amp; everyday maths.</p>',
    );
    assertStringIncludes(
      landing,
      'href="/apps/org.gnome.Calculator#post-org.gnome.Calculator-new-app"',
    );
    assertEquals(landing.includes("Firefox 1.0.0"), false);
    assertStringIncludes(landing, 'href="/apps/recent-releases"');
    assertStringIncludes(landing, 'href="/apps/new-apps"');
    assertStringIncludes(landing, 'href="/apps/trending-apps"');
    assertStringIncludes(landing, 'href="/apps/popular-apps"');
    assertStringIncludes(landing, 'href="/apps/org.mozilla.firefox"');
    assertEquals(landing.includes("Recent posts"), false);
    assertEquals(landing.includes("#release-abc123"), false);
    assertEquals(landing.includes("@recent-releases@example.org"), false);
    assertEquals(landing.includes("@new-apps@example.org"), false);
    assertEquals(landing.includes("@trending-apps@example.org"), false);
    assertEquals(landing.includes("@popular-apps@example.org"), false);
    assertEquals(landing.includes("@org.mozilla.firefox@example.org"), false);
    assertStringIncludes(landing, 'href="/status"');
    assertStringIncludes(landing, 'href="/sitemap.xml"');

    const appResponse = await serve(
      new Request("https://example.org/apps/org.mozilla.firefox"),
    );
    const appHtml = await appResponse.text();
    assertEquals(appResponse.status, 200);
    assertStringIncludes(appHtml, "A web browser");
    assertStringIncludes(appHtml, 'id="release-abc123"');
    assertStringIncludes(appHtml, "Firefox 1.0.0");
    assertStringIncludes(appHtml, "@org.mozilla.firefox@example.org");
    assertEquals(appHtml.includes("<dt>App ID</dt>"), false);
    assertEquals(appHtml.includes("<dt>Fediverse handle</dt>"), false);

    const releaseResponse = await serve(
      new Request(
        "https://example.org/apps/org.mozilla.firefox/releases/abc123",
      ),
    );
    assertEquals(releaseResponse.status, 303);
    assertEquals(
      releaseResponse.headers.get("location"),
      "/apps/org.mozilla.firefox#release-abc123",
    );

    const noteResponse = await serve(
      new Request(
        "https://example.org/apps/org.mozilla.firefox/releases/abc123",
        {
          headers: { accept: "application/activity+json" },
        },
      ),
    );
    const note = await noteResponse.json<{ type: string; tag: { name: string }[] }>();
    assertEquals(noteResponse.status, 200);
    assertEquals(note.type, "Note");
    assertEquals(note.tag[0].name, "#Flathub");

    const releaseViaPostsResponse = await serve(
      new Request("https://example.org/apps/org.mozilla.firefox/posts/abc123"),
    );
    assertEquals(releaseViaPostsResponse.status, 404);

    const newAppViaReleasesResponse = await serve(
      new Request(
        "https://example.org/apps/org.mozilla.firefox/releases/new-app",
      ),
    );
    assertEquals(newAppViaReleasesResponse.status, 404);

    const feedOutboxResponse = await serve(
      new Request("https://example.org/apps/recent-releases/outbox"),
    );
    const feedOutbox = await feedOutboxResponse.json<OutboxDocument>();
    assertEquals(feedOutbox.totalItems, 1);
    assertEquals(feedOutbox.orderedItems[0].type, "Announce");
    assertEquals(
      feedOutbox.orderedItems[0].actor,
      "https://example.org/apps/recent-releases",
    );
    assertEquals(
      feedOutbox.orderedItems[0].object,
      "https://example.org/apps/org.mozilla.firefox/releases/abc123",
    );

    const newAppsResponse = await serve(
      new Request("https://example.org/apps/new-apps"),
    );
    const newAppsHtml = await newAppsResponse.text();
    assertEquals(newAppsResponse.status, 200);
    assertEquals(newAppsHtml.includes("Flathub API"), false);
    assertEquals(newAppsHtml.includes("/collection/recently-added"), false);
    assertStringIncludes(newAppsHtml, 'id="post-org.mozilla.firefox-new-app"');
    assertStringIncludes(
      newAppsHtml,
      'id="post-org.gnome.Calculator-new-app"',
    );
    assertEquals(newAppsHtml.includes('id="post-new-app"'), false);

    const trendingResponse = await serve(
      new Request("https://example.org/apps/trending-apps"),
    );
    const trendingHtml = await trendingResponse.text();
    assertEquals(trendingResponse.status, 200);
    assertEquals(trendingHtml.includes("Flathub API"), false);
    assertEquals(trendingHtml.includes("/collection/trending"), false);
    assertStringIncludes(trendingHtml, "Firefox");

    const trendingOutboxResponse = await serve(
      new Request("https://example.org/apps/trending-apps/outbox"),
    );
    const trendingOutbox = await trendingOutboxResponse.json<OutboxDocument>();
    assertEquals(trendingOutbox.totalItems, 1);
    assertEquals(trendingOutbox.orderedItems[0].type, "Announce");
    assertEquals(
      trendingOutbox.orderedItems[0].object,
      "https://example.org/apps/org.mozilla.firefox",
    );

    const followResponse = await serve(
      new Request(
        "https://example.org/apps/org.mozilla.firefox?follow=1&server=https%3A%2F%2Fmastodon.social%2Fexplore",
      ),
    );
    assertEquals(followResponse.status, 303);
    assertEquals(
      followResponse.headers.get("location"),
      "https://mastodon.social/authorize_interaction?uri=https%3A%2F%2Fexample.org%2Fapps%2Forg.mozilla.firefox",
    );

    const statusResponse = await serve(
      new Request("https://example.org/status"),
    );
    const statusHtml = await statusResponse.text();
    assertEquals(statusResponse.status, 200);
    assertStringIncludes(statusHtml, "Ingestion and federation state");
    assertStringIncludes(statusHtml, "Release posts");
    assertStringIncludes(statusHtml, "Fedify queue");
    assertStringIncludes(statusHtml, "Crawler scheduling");
    assertStringIncludes(statusHtml, "<dd>none</dd>");
    assertStringIncludes(statusHtml, "<dd>cron</dd>");
    assertStringIncludes(statusHtml, "Recently added watermark");

    const sitemapResponse = await serve(
      new Request("https://example.org/sitemap.xml"),
    );
    const sitemap = await sitemapResponse.text();
    assertEquals(sitemapResponse.status, 200);
    assertEquals(
      sitemapResponse.headers.get("content-type"),
      "application/xml; charset=utf-8",
    );
    assertStringIncludes(
      sitemap,
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    assertStringIncludes(sitemap, "<loc>https://example.org/</loc>");
    assertStringIncludes(
      sitemap,
      "<loc>https://example.org/apps/recent-releases</loc>",
    );
    assertStringIncludes(
      sitemap,
      "<loc>https://example.org/apps/new-apps</loc>",
    );
    assertStringIncludes(
      sitemap,
      "<loc>https://example.org/apps/trending-apps</loc>",
    );
    assertStringIncludes(
      sitemap,
      "<loc>https://example.org/apps/popular-apps</loc>",
    );
    assertStringIncludes(
      sitemap,
      "<loc>https://example.org/apps/org.mozilla.firefox</loc>",
    );
    assertStringIncludes(sitemap, "<lastmod>");
    assertStringIncludes(sitemap, "<changefreq>");
    assertStringIncludes(sitemap, "<priority>");
  } finally {
    await close();
  }
});

test("remote follow uses discovered interaction template", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: "A web browser",
      updatedAt: 100,
    });
    const discoveryRequests: string[] = [];
    const fetchOptions: RequestInit[] = [];
    const fetcher: typeof fetch = (input, init) => {
      discoveryRequests.push(String(input));
      fetchOptions.push(init ?? {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            links: [
              {
                rel: "http://ostatus.org/schema/1.0/subscribe",
                template: "https://mastodon.social/legacy?uri={uri}",
              },
              {
                rel: "https://w3id.org/fep/3b86/Follow",
                template: "https://mastodon.social/follow?object={object}",
              },
            ],
          }),
          { headers: { "content-type": "application/jrd+json" } },
        ),
      );
    };
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
      fetcher,
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    };

    const response = await handler(app)(
      new Request(
        "https://example.org/apps/org.mozilla.firefox?follow=1&server=https%3A%2F%2Fmastodon.social%2Fexplore",
      ),
    );

    assertEquals(discoveryRequests, [
      "https://mastodon.social/.well-known/webfinger?resource=https%3A%2F%2Fmastodon.social",
    ]);
    assertEquals(fetchOptions[0].redirect, "manual");
    assertEquals(response.status, 303);
    assertEquals(
      response.headers.get("location"),
      "https://mastodon.social/follow?object=https%3A%2F%2Fexample.org%2Fapps%2Forg.mozilla.firefox",
    );
  } finally {
    await close();
  }
});

test("remote follow falls back when interaction discovery fails", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: "A web browser",
      updatedAt: 100,
    });
    let discoveryRequests = 0;
    const fetcher: typeof fetch = () => {
      discoveryRequests += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
      fetcher,
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    };

    const response = await handler(app)(
      new Request(
        "https://example.org/apps/org.mozilla.firefox?follow=1&server=mastodon.social",
      ),
    );

    assertEquals(discoveryRequests, 1);
    assertEquals(response.status, 303);
    assertEquals(
      response.headers.get("location"),
      "https://mastodon.social/authorize_interaction?uri=https%3A%2F%2Fexample.org%2Fapps%2Forg.mozilla.firefox",
    );
  } finally {
    await close();
  }
});

test("remote follow does not discover unsafe literal hosts", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: "A web browser",
      updatedAt: 100,
    });
    let discoveryRequests = 0;
    let dnsRequests = 0;
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
      fetcher: () => {
        discoveryRequests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      resolveHostAddresses: () => {
        dnsRequests += 1;
        return Promise.resolve(["93.184.216.34"]);
      },
    };
    const serve = handler(app);

    for (
      const server of [
        "https://localhost.",
        "https://[::1]",
        "https://[fd00::1]",
        "https://10.0.0.1",
      ]
    ) {
      const url = new URL("https://example.org/apps/org.mozilla.firefox");
      url.searchParams.set("follow", "1");
      url.searchParams.set("server", server);
      const response = await serve(new Request(url));
      assertEquals(response.status, 303);
    }

    assertEquals(dnsRequests, 0);
    assertEquals(discoveryRequests, 0);
  } finally {
    await close();
  }
});

test("remote follow does not fetch domains resolving to private addresses", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      summary: "A web browser",
      updatedAt: 100,
    });
    let discoveryRequests = 0;
    const resolvedHosts: string[] = [];
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
      fetcher: () => {
        discoveryRequests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      resolveHostAddresses: (hostname: string) => {
        resolvedHosts.push(hostname);
        return Promise.resolve(["10.0.0.2"]);
      },
    };

    const response = await handler(app)(
      new Request(
        "https://example.org/apps/org.mozilla.firefox?follow=1&server=attacker.example",
      ),
    );

    assertEquals(resolvedHosts, ["attacker.example"]);
    assertEquals(discoveryRequests, 0);
    assertEquals(response.status, 303);
    assertEquals(
      response.headers.get("location"),
      "https://attacker.example/authorize_interaction?uri=https%3A%2F%2Fexample.org%2Fapps%2Forg.mozilla.firefox",
    );
  } finally {
    await close();
  }
});

test("internal ingestion routes require configured bearer token", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    let polled = false;
    const app = {
      config: { ...config, internalApiToken: "secret" },
      repos,
      ingestor: {
        bootstrap: () => Promise.resolve(),
        poll: () => {
          polled = true;
          return Promise.resolve();
        },
      } as Ingestor,
      federation: createFedifyFederation(config, kv),
    };
    const serve = handler(app);

    const unauthorized = await serve(
      new Request("https://example.org/internal/ingest/poll", {
        method: "POST",
      }),
    );
    assertEquals(unauthorized.status, 401);

    const authorized = await serve(
      new Request("https://example.org/internal/ingest/poll", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
    );
    assertEquals(authorized.status, 200);
    assertEquals(polled, true);
  } finally {
    await close();
  }
});

test("internal ingestion routes are hidden when token is unset", async () => {
  const { db: kv, close } = await openDatabase();
  try {
    const repos = createRepositories(kv);
    const app = {
      config,
      repos,
      ingestor: new Ingestor(config, new FakeFlathubClient() as never, repos),
      federation: createFedifyFederation(config, kv),
    };
    const response = await handler(app)(
      new Request("https://example.org/internal/ingest/poll", {
        method: "POST",
      }),
    );
    assertEquals(response.status, 404);
  } finally {
    await close();
  }
});
