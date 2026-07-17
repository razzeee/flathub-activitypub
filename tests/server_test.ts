import { assertEquals } from "@std/assert";
import type { Config } from "../src/config.ts";
import { createRepositories } from "../src/store/kv_store.ts";
import { handler } from "../src/server.ts";
import { Ingestor } from "../src/ingestion/ingestor.ts";
import { FakeFlathubClient } from "../src/testing/fake_client.ts";
import { createFedifyFederation } from "../src/federation/fedify.ts";

const config: Config = {
  origin: "https://example.org",
  port: 8000,
  flathubApiBase: "https://flathub.org/api/v2",
  recentlyUpdatedPerPage: 2,
  recentlyUpdatedOverlapSeconds: 3600,
  crawlIntervalSeconds: 300,
  bootstrapThrottleMs: 0,
};

Deno.test("actor and WebFinger routes expose ingested app", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repos = createRepositories(kv);
    await repos.apps.upsertFromHit({
      appId: "org.mozilla.firefox",
      name: "Firefox",
      updatedAt: 1,
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
    const actor = await actorResponse.json();
    assertEquals(actor.type, "Service");
    assertEquals(actor.preferredUsername, "org.mozilla.firefox");
    assertEquals(actor.name, "Firefox");
    assertEquals(typeof actor.publicKey.id, "string");
    assertEquals(actor.endpoints.sharedInbox, "https://example.org/inbox");

    const wfResponse = await serve(
      new Request(
        "https://example.org/.well-known/webfinger?resource=acct:org.mozilla.firefox@example.org",
      ),
    );
    const wf = await wfResponse.json();
    assertEquals(wf.subject, "acct:org.mozilla.firefox@example.org");
  } finally {
    kv.close();
  }
});

Deno.test("internal ingestion routes require configured bearer token", async () => {
  const kv = await Deno.openKv(":memory:");
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
    kv.close();
  }
});

Deno.test("internal ingestion routes are hidden when token is unset", async () => {
  const kv = await Deno.openKv(":memory:");
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
    kv.close();
  }
});
