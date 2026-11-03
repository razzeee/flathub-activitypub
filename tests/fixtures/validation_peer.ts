// Isolated live-validation peer. Never bind this fixture to a production identity.
import { DurableObject } from "cloudflare:workers";
import {
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  signRequest,
  verifyRequest,
} from "@fedify/fedify";

interface PeerEnv {
  PEER: DurableObjectNamespace<ValidationPeer>;
  ORIGIN: string;
  TARGET_ORIGIN: string;
  VALIDATION_TOKEN: string;
}

interface Attempt {
  sequence: number;
  at: string;
  status: number;
  verified: boolean;
  activity: Record<string, unknown>;
}

interface Condition {
  after: number;
  status: number;
}
interface Waiter {
  condition: Condition;
  resolve: (response: Response) => void;
}

export class ValidationPeer extends DurableObject<PeerEnv> {
  private waiters = new Set<Waiter>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/actor" && request.method === "GET") {
      const keys = await this.keys();
      const publicKey = await importJwk(keys.publicKey, "public");
      const bytes = new Uint8Array(
        await crypto.subtle.exportKey("spki", publicKey),
      );
      const encoded = btoa(String.fromCharCode(...bytes));
      const pem = `-----BEGIN PUBLIC KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
      return Response.json(
        {
          "@context": [
            "https://www.w3.org/ns/activitystreams",
            "https://w3id.org/security/v1",
          ],
          id: `${this.env.ORIGIN}/actor`,
          type: "Person",
          preferredUsername: "validation",
          inbox: `${this.env.ORIGIN}/inbox`,
          publicKey: {
            id: `${this.env.ORIGIN}/actor#key`,
            owner: `${this.env.ORIGIN}/actor`,
            publicKeyPem: pem,
          },
        },
        { headers: { "content-type": "application/activity+json" } },
      );
    }
    if (url.pathname === "/inbox" && request.method === "POST") {
      const body = await request.text();
      const verificationRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      });
      const key = await verifyRequest(verificationRequest, {
        spec: request.headers.has("signature-input")
          ? "rfc9421"
          : "draft-cavage-http-signatures-12",
      });
      const attempts =
        (await this.ctx.storage.get<Attempt[]>("attempts")) ?? [];
      const status =
        key == null
          ? 401
          : ((await this.ctx.storage.get<number>("inboxStatus")) ?? 202);
      const attempt: Attempt = {
        sequence: (attempts.at(-1)?.sequence ?? 0) + 1,
        at: new Date().toISOString(),
        status,
        verified: key != null,
        activity: JSON.parse(body),
      };
      await this.ctx.storage.put("attempts", [...attempts, attempt].slice(-30));
      for (const waiter of this.waiters) {
        if (this.matches(attempt, waiter.condition)) {
          this.waiters.delete(waiter);
          waiter.resolve(Response.json(attempt));
        }
      }
      return new Response(null, { status });
    }
    if (!this.env.VALIDATION_TOKEN)
      return new Response("Validation token is not configured", {
        status: 503,
      });
    if (
      request.headers.get("authorization") !==
      `Bearer ${this.env.VALIDATION_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/internal/state")
      return Response.json({
        attempts: (await this.ctx.storage.get("attempts")) ?? [],
      });
    if (url.pathname === "/internal/status" && request.method === "POST") {
      const { status } = await request.json<{ status: number }>();
      if (![202, 410, 503].includes(status))
        return new Response("Invalid status", { status: 400 });
      await this.ctx.storage.put("inboxStatus", status);
      return Response.json({ status });
    }
    if (url.pathname === "/internal/wait" && request.method === "POST") {
      const condition = await request.json<Condition>();
      const attempts =
        (await this.ctx.storage.get<Attempt[]>("attempts")) ?? [];
      const match = attempts.find((attempt) =>
        this.matches(attempt, condition),
      );
      if (match) return Response.json(match);
      // Event-driven wait: no polling loops or sleeps while Cloudflare delivers/retries.
      return new Promise<Response>((resolve) => {
        const waiter = { condition, resolve };
        this.waiters.add(waiter);
        const timeout = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(
            new Response("No matching delivery within 60 seconds", {
              status: 504,
            }),
          );
        }, 60_000);
        waiter.resolve = (response) => {
          clearTimeout(timeout);
          resolve(response);
        };
      });
    }
    if (
      (url.pathname === "/internal/follow" ||
        url.pathname === "/internal/undo") &&
      request.method === "POST"
    ) {
      const actor = `${this.env.ORIGIN}/actor`;
      const object = `${this.env.TARGET_ORIGIN}/apps/new-apps`;
      let activity: Record<string, unknown>;
      if (url.pathname.endsWith("/follow")) {
        activity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${this.env.ORIGIN}/follows/${crypto.randomUUID()}`,
          type: "Follow",
          actor,
          object,
        };
        await this.ctx.storage.put("follow", activity);
      } else {
        const follow = await this.ctx.storage.get("follow");
        if (!follow) return new Response("No Follow to undo", { status: 409 });
        activity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${this.env.ORIGIN}/undo/${crypto.randomUUID()}`,
          type: "Undo",
          actor,
          object: follow,
        };
      }
      const keys = await this.keys();
      const signed = await signRequest(
        new Request(`${object}/inbox`, {
          method: "POST",
          headers: { "content-type": "application/activity+json" },
          body: JSON.stringify(activity),
        }),
        await importJwk(keys.privateKey, "private"),
        new URL(`${actor}#key`),
      );
      const response = await fetch(signed);
      return Response.json({
        status: response.status,
        body: await response.text(),
        activityId: activity.id,
      });
    }
    return new Response("Not found", { status: 404 });
  }

  private matches(attempt: Attempt, condition: Condition): boolean {
    return (
      attempt.sequence > condition.after && attempt.status === condition.status
    );
  }

  private async keys(): Promise<{
    privateKey: JsonWebKey;
    publicKey: JsonWebKey;
  }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<{
        privateKey: JsonWebKey;
        publicKey: JsonWebKey;
      }>("keys");
      if (existing) return existing;
      const pair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
      const keys = {
        privateKey: await exportJwk(pair.privateKey),
        publicKey: await exportJwk(pair.publicKey),
      };
      await this.ctx.storage.put("keys", keys);
      return keys;
    });
  }
}

export default {
  fetch(request: Request, env: PeerEnv): Promise<Response> {
    return env.PEER.get(env.PEER.idFromName("validation")).fetch(request);
  },
} satisfies ExportedHandler<PeerEnv>;
