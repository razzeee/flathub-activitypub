import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import {
  Miniflare,
  Response as MockResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import {
  generateCryptoKeyPair,
  signRequest,
  verifyRequest,
} from "@fedify/fedify";

/** Observe real Queue producer messages without automatically acknowledging the application's consumer. */
function mailbox<T>() {
  const pending: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    put(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else pending.push(value);
    },
    next(): Promise<T> {
      const value = pending.shift();
      return value === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(value);
    },
  };
}

async function federationHarness(actorName = "new-apps") {
  const tasks = mailbox<unknown>();
  const ingestionTasks = mailbox<unknown>();
  const delivered: Request[] = [];
  const requests: string[] = [];
  let inboxStatus = 202;
  // A public literal address avoids real DNS; all HTTP traffic is intercepted below.
  const remoteOrigin = "https://93.184.215.14";
  const remoteActorId = `${remoteOrigin}/users/alice`;
  const keys = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const spki = Buffer.from(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  ).toString("base64");
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  const remoteActor = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: remoteActorId,
    type: "Person",
    preferredUsername: "alice",
    inbox: `${remoteOrigin}/inbox`,
    publicKey: {
      id: `${remoteActorId}#key`,
      owner: remoteActorId,
      publicKeyPem,
    },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "gateway",
          modules: true,
          compatibilityDate: "2026-11-03",
          // Miniflare's Node HTTP bridge rewrites Host to its loopback listener.
          // Restore the original authority inside workerd, before the real app
          // verifies the request; never bypass signature verification in the app.
          script: `export default { fetch(request, env) {
        const headers = new Headers(request.headers);
        headers.set("host", new URL(request.url).host);
        return env.APP.fetch(new Request(request, { headers }));
      } };`,
          serviceBindings: { APP: "app" },
        },
        {
          name: "app",
          modules: true,
          scriptPath: "dist/main.js",
          compatibilityDate: "2026-11-03",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "federation-e2e" },
          bindings: {
            ORIGIN: "https://local.example",
            INTERNAL_API_TOKEN: "test-only-token",
            FLATHUB_API_BASE: "https://flathub.test/api/v2",
          },
          queueProducers: {
            FEDERATION_QUEUE: "flathub-federation",
            INGESTION_QUEUE: "flathub-ingestion",
          },
          outboundService: async (request) => {
            requests.push(request.url);
            const url = new URL(request.url);
            if (url.origin === "https://flathub.test") {
              if (url.pathname.includes("/appstream/")) {
                return MockResponse.json({
                  name: "Example",
                  releases: [
                    {
                      version: "1.0",
                      timestamp: 100,
                      description: "<p>A production test release</p>",
                    },
                  ],
                });
              }
              return MockResponse.json({
                page: 1,
                totalPages: 1,
                hits: url.pathname.endsWith("/collection/recently-updated")
                  ? [{ app_id: actorName, name: "Example", updated_at: 100 }]
                  : [],
              });
            }
            if (
              url.origin === remoteOrigin &&
              url.pathname === "/users/alice"
            ) {
              return MockResponse.json(remoteActor, {
                headers: { "content-type": "application/activity+json" },
              });
            }
            if (
              url.origin === remoteOrigin &&
              url.pathname === "/inbox" &&
              request.method === "POST"
            ) {
              delivered.push(
                new Request(request.url, {
                  method: request.method,
                  headers: Object.fromEntries(request.headers),
                  body: await request.text(),
                }),
              );
              return new MockResponse(null, { status: inboxStatus });
            }
            throw new Error(
              `Unexpected external request: ${request.method} ${url}`,
            );
          },
        },
        {
          name: "capture",
          modules: true,
          script: `export default { async queue(batch, env) {
        for (const message of batch.messages) {
          await env.CAPTURE.fetch("https://capture.test/", { method: "POST", body: JSON.stringify({ queue: batch.queue, body: message.body }) });
          message.ack();
        }
      } };`,
          compatibilityDate: "2026-11-03",
          queueConsumers: {
            "flathub-federation": { maxBatchSize: 1, maxBatchTimeout: 0 },
            "flathub-ingestion": { maxBatchSize: 1, maxBatchTimeout: 0 },
          },
          serviceBindings: {
            CAPTURE: async (request) => {
              const message = (await request.json()) as {
                queue: string;
                body: unknown;
              };
              if (message.queue === "flathub-federation")
                tasks.put(message.body);
              else if (message.queue === "flathub-ingestion")
                ingestionTasks.put(message.body);
              else throw new Error(`Unexpected queue ${message.queue}`);
              return new MockResponse(null, { status: 204 });
            },
          },
        },
      ],
    }),
  );
  const db = await mf.getD1Database("DB", "app");
  await db.exec(
    await readFile(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const entrypoint = await mf.getWorker("app");
  const gateway = await mf.getWorker("gateway");
  const actorId = `https://local.example/apps/${actorName}`;
  if (actorName !== "new-apps") {
    await db
      .prepare("INSERT INTO apps VALUES (?, ?, ?)")
      .bind(
        actorName,
        100,
        JSON.stringify({
          appId: actorName,
          name: "Example",
          flathubUrl: `https://flathub.org/apps/${actorName}`,
          lastSeenUpdatedAt: 100,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      )
      .run();
  }
  const actorResponse = await mf.dispatchFetch(actorId, {
    headers: { accept: "application/activity+json" },
  });
  expect(actorResponse.status).toBe(200);
  const localActor = await actorResponse.json();
  return {
    mf,
    db,
    tasks,
    ingestionTasks,
    delivered,
    requests,
    actorId,
    remoteActorId,
    setInboxStatus(status: number) {
      inboxStatus = status;
    },
    async post(
      activity: Record<string, unknown>,
      signed = true,
      tampered = false,
    ) {
      const unsigned = new Request(`${actorId}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          "@context": "https://www.w3.org/ns/activitystreams",
          ...activity,
        }),
      });
      const request = signed
        ? await signRequest(
            unsigned,
            keys.privateKey,
            new URL(`${remoteActorId}#key`),
          )
        : unsigned;
      if (signed) {
        const check = new Request(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.clone().text(),
        });
        expect(
          await verifyRequest(check, {
            documentLoader: async (url) => ({
              document: remoteActor,
              documentUrl: url,
              contextUrl: null,
            }),
          }),
        ).not.toBeNull();
      }
      const body = await request.text();
      return gateway.fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: tampered ? body + " " : body,
      });
    },
    async process(body: unknown, attempts = 1, queue = "flathub-federation") {
      const id = crypto.randomUUID();
      const result = await entrypoint.queue(queue, [
        { id, timestamp: new Date(), attempts, body },
      ]);
      return { id, result };
    },
    async verifyDelivery(index: number) {
      const captured = delivered[index];
      const request = new Request(captured.url, {
        method: captured.method,
        headers: Object.fromEntries(captured.headers),
        body: await captured.clone().text(),
      });
      return verifyRequest(request, {
        spec: request.headers.has("signature-input")
          ? "rfc9421"
          : "draft-cavage-http-signatures-12",
        documentLoader: async (url) => ({
          document: localActor,
          documentUrl: url,
          contextUrl: null,
        }),
      });
    },
  };
}

test("signed Follow and Undo traverse the bundled Worker and federation queue", async () => {
  const h = await federationHarness();
  try {
    const follow = {
      id: `${h.remoteActorId}/follow/1`,
      type: "Follow",
      actor: h.remoteActorId,
      object: h.actorId,
    };
    const response = await h.post(follow);
    expect(
      response.status,
      `${await response.text()} ${JSON.stringify(h.requests)}`,
    ).toBe(202);
    const inbox = await h.tasks.next();
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
    const processed = await h.process(inbox);
    expect(processed.result.explicitAcks).toContain(processed.id);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(1);
    const accept = await h.process(await h.tasks.next());
    expect(accept.result.explicitAcks).toContain(accept.id);
    expect(h.delivered).toHaveLength(1);
    expect(await h.delivered[0].clone().json()).toMatchObject({
      type: "Accept",
      actor: h.actorId,
      object: { ...follow, actor: { id: h.remoteActorId } },
    });
    expect(await h.verifyDelivery(0)).not.toBeNull();
    const undo = await h.post({
      id: `${h.remoteActorId}/undo/1`,
      type: "Undo",
      actor: h.remoteActorId,
      object: follow,
    });
    expect(undo.status).toBe(202);
    const undone = await h.process(await h.tasks.next());
    expect(undone.result.explicitAcks).toContain(undone.id);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
  } finally {
    await h.mf.dispose();
  }
});

test("a failed federation delivery is retried, then acknowledged after successful signed delivery", async () => {
  const h = await federationHarness();
  try {
    const response = await h.post({
      id: `${h.remoteActorId}/follow/retry`,
      type: "Follow",
      actor: h.remoteActorId,
      object: h.actorId,
    });
    expect(response.status, await response.text()).toBe(202);
    await h.process(await h.tasks.next());
    const task = await h.tasks.next();
    h.setInboxStatus(503);
    const failed = await h.process(task);
    expect(failed.result.explicitAcks).not.toContain(failed.id);
    expect(failed.result.retryMessages).toContainEqual({
      msgId: failed.id,
      delaySeconds: 30,
    });
    const failedDeliveries = h.delivered.length;
    expect(failedDeliveries).toBeGreaterThan(0);
    h.setInboxStatus(202);
    const recovered = await h.process(task, 2);
    expect(recovered.result.explicitAcks).toContain(recovered.id);
    expect(recovered.result.retryMessages).toHaveLength(0);
    expect(h.delivered).toHaveLength(failedDeliveries + 1);
    for (let i = 0; i < h.delivered.length; i++)
      expect(await h.verifyDelivery(i)).not.toBeNull();
    const first = await h.delivered[0].clone().json();
    const second = await h.delivered[failedDeliveries].clone().json();
    expect(second).toEqual(first);
  } finally {
    await h.mf.dispose();
  }
});

test("an unsigned Follow cannot register a follower", async () => {
  const h = await federationHarness();
  try {
    const response = await h.post(
      {
        id: `${h.remoteActorId}/unsigned`,
        type: "Follow",
        actor: h.remoteActorId,
        object: h.actorId,
      },
      false,
    );
    expect(response.status).toBe(401);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
    expect(h.delivered).toHaveLength(0);
  } finally {
    await h.mf.dispose();
  }
});

test("ingestion publishes a release through real Queue bindings and signed federation delivery", async () => {
  const h = await federationHarness("org.example.App");
  try {
    const follow = await h.post({
      id: `${h.remoteActorId}/follow/app`,
      type: "Follow",
      actor: h.remoteActorId,
      object: h.actorId,
    });
    expect(follow.status).toBe(202);
    await h.process(await h.tasks.next());
    await h.process(await h.tasks.next());
    expect(h.delivered).toHaveLength(1);
    const poll = await h.mf.dispatchFetch(
      "https://local.example/internal/ingest/poll",
      { method: "POST", headers: { authorization: "Bearer test-only-token" } },
    );
    expect(poll.status).toBe(202);
    let completed = false;
    for (let i = 0; i < 50; i++) {
      const task = await h.process(
        await h.ingestionTasks.next(),
        1,
        "flathub-ingestion",
      );
      expect(task.result.explicitAcks).toContain(task.id);
      const row = await h.db
        .prepare("SELECT data FROM state WHERE id='job:poll'")
        .first<string>("data");
      if (row && JSON.parse(row).phase === "done") {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(
      await h.db.prepare("SELECT count(*) AS count FROM posts").first("count"),
    ).toBe(1);
    for (let i = 0; i < 10 && h.delivered.length < 2; i++) {
      const task = await h.process(await h.tasks.next());
      expect(task.result.explicitAcks).toContain(task.id);
    }
    expect(h.delivered).toHaveLength(2);
    expect(await h.delivered[1].clone().json()).toMatchObject({
      type: "Create",
      actor: h.actorId,
      object: {
        type: "Note",
        attributedTo: h.actorId,
        content: expect.stringContaining("A production test release"),
      },
    });
    expect(await h.verifyDelivery(1)).not.toBeNull();
  } finally {
    await h.mf.dispose();
  }
});

test("a body changed after signing cannot register a follower", async () => {
  const h = await federationHarness();
  try {
    const response = await h.post(
      {
        id: `${h.remoteActorId}/tampered`,
        type: "Follow",
        actor: h.remoteActorId,
        object: h.actorId,
      },
      true,
      true,
    );
    expect(response.status).toBe(401);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
    expect(h.delivered).toHaveLength(0);
  } finally {
    await h.mf.dispose();
  }
});

test("a signature from a different actor cannot authorize a Follow", async () => {
  const h = await federationHarness();
  try {
    const response = await h.post({
      id: `${h.remoteActorId}/forged`,
      type: "Follow",
      actor: "https://93.184.215.14/users/bob",
      object: h.actorId,
    });
    expect(response.status).toBe(401);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
    expect(h.delivered).toHaveLength(0);
  } finally {
    await h.mf.dispose();
  }
});

test("a permanent inbox failure removes the follower and acknowledges the task", async () => {
  const h = await federationHarness();
  try {
    const response = await h.post({
      id: `${h.remoteActorId}/follow/gone`,
      type: "Follow",
      actor: h.remoteActorId,
      object: h.actorId,
    });
    expect(response.status).toBe(202);
    await h.process(await h.tasks.next());
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(1);
    h.setInboxStatus(410);
    const task = await h.process(await h.tasks.next());
    expect(task.result.explicitAcks).toContain(task.id);
    expect(task.result.retryMessages).toHaveLength(0);
    expect(
      await h.db
        .prepare("SELECT count(*) AS count FROM followers")
        .first("count"),
    ).toBe(0);
  } finally {
    await h.mf.dispose();
  }
});
