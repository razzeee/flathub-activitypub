import type { Config } from "./config.ts";
import { FlathubClient } from "./flathub/client.ts";
import {
  createActivity,
  noteDocument,
  webfinger,
} from "./federation/activity.ts";
import {
  createFedifyFederation,
  type FederationData,
} from "./federation/fedify.ts";
import { Ingestor } from "./ingestion/ingestor.ts";
import { createRepositories, type Repositories } from "./store/kv_store.ts";
import type { Federation } from "@fedify/fedify";

const ACTIVITY_JSON = "application/activity+json; charset=utf-8";

export interface AppContext {
  config: Config;
  repos: Repositories;
  ingestor: Ingestor;
  federation: Federation<FederationData>;
}

export function createApp(
  config: Config,
  kv: Deno.Kv,
): AppContext {
  const repos = createRepositories(kv);
  const client = new FlathubClient(config.flathubApiBase);
  const federation = createFedifyFederation(config, kv);
  return {
    config,
    repos,
    ingestor: new Ingestor(config, client, repos, federation),
    federation,
  };
}

export function handler(
  context: AppContext,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        return json({ ok: true });
      }
      if (
        request.method === "GET" && url.pathname === "/.well-known/webfinger"
      ) {
        return await handleWebfinger(context, url);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/ingest/bootstrap"
      ) {
        const unauthorized = authorizeInternalRequest(context, request);
        if (unauthorized) return unauthorized;
        await context.ingestor.bootstrap();
        return json({ ok: true });
      }
      if (
        request.method === "POST" && url.pathname === "/internal/ingest/poll"
      ) {
        const unauthorized = authorizeInternalRequest(context, request);
        if (unauthorized) return unauthorized;
        await context.ingestor.poll();
        return json({ ok: true });
      }
      if (url.pathname.startsWith("/apps/")) {
        const appResponse = await handleApps(context, request, url);
        if (appResponse.status !== 404) return appResponse;
      }
      const fedifyResponse = await context.federation.fetch(request, {
        contextData: { repos: context.repos },
        onNotFound: () => json({ error: "not found" }, 404),
      });
      return fedifyResponse;
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  };
}

async function handleWebfinger(
  context: AppContext,
  url: URL,
): Promise<Response> {
  const resource = url.searchParams.get("resource") ?? "";
  const host = new URL(context.config.origin).host;
  const prefix = "acct:";
  if (!resource.startsWith(prefix) || !resource.endsWith(`@${host}`)) {
    return json({ error: "unsupported resource" }, 400);
  }
  const appId = resource.slice(prefix.length, -host.length - 1);
  const profile = await context.repos.apps.get(appId);
  if (!profile) return json({ error: "unknown app" }, 404);
  return json(
    webfinger(context.config.origin, appId),
    200,
    "application/jrd+json; charset=utf-8",
  );
}

async function handleApps(
  context: AppContext,
  request: Request,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const appId = decodeURIComponent(parts[1] ?? "");
  const profile = await context.repos.apps.get(appId);
  if (!profile) return json({ error: "unknown app" }, 404);

  if (parts.length === 2 && request.method === "GET") {
    if (acceptsActivityJson(request)) {
      return json({ error: "not found" }, 404);
    }
    return html(
      `<h1>${escapeHtml(profile.name)}</h1><p>${
        escapeHtml(profile.summary ?? "Flathub changelog actor")
      }</p><p><a href="${profile.flathubUrl}">View on Flathub</a></p>`,
    );
  }

  if (
    parts.length === 3 && parts[2] === "followers" && request.method === "GET"
  ) {
    const followers = await context.repos.followers.list(appId);
    return json(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${context.config.origin}${url.pathname}`,
        type: "Collection",
        totalItems: followers.length,
      },
      200,
      ACTIVITY_JSON,
    );
  }

  if (parts.length === 3 && parts[2] === "outbox" && request.method === "GET") {
    const posts = await context.repos.releases.listPosts(appId);
    return json(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${context.config.origin}${url.pathname}`,
        type: "OrderedCollection",
        totalItems: posts.length,
        orderedItems: posts.map((post) =>
          createActivity(context.config.origin, post)
        ),
      },
      200,
      ACTIVITY_JSON,
    );
  }

  if (
    parts.length === 4 && parts[2] === "releases" && request.method === "GET"
  ) {
    const fingerprint = parts[3];
    const post = await context.repos.releases.getPost(appId, fingerprint);
    if (!post) return json({ error: "unknown release" }, 404);
    if (acceptsActivityJson(request)) {
      return json(
        noteDocument(context.config.origin, post),
        200,
        ACTIVITY_JSON,
      );
    }
    return html(post.contentHtml);
  }

  return json({ error: "not found" }, 404);
}

function authorizeInternalRequest(
  context: AppContext,
  request: Request,
): Response | null {
  const token = context.config.internalApiToken;
  if (!token) return json({ error: "not found" }, 404);
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${token}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function acceptsActivityJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/activity+json") ||
    accept.includes("application/ld+json");
}

function json(
  body: unknown,
  status = 200,
  contentType = "application/json; charset=utf-8",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body>${body}</body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}
