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
import type { AppProfile, PostRecord } from "./store/types.ts";
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
      if (request.method === "GET" && url.pathname === "/") {
        return await handleLandingPage(context);
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
    if (url.searchParams.has("follow")) {
      return handleRemoteFollow(context, profile, url);
    }
    if (acceptsActivityJson(request)) {
      return json({ error: "not found" }, 404);
    }
    const posts = await context.repos.releases.listPosts(appId);
    return html(renderAppPage(context, profile, posts));
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
    return redirect(`${actorPath(appId)}#release-${fingerprint}`);
  }

  return json({ error: "not found" }, 404);
}

async function handleLandingPage(context: AppContext): Promise<Response> {
  const apps = await context.repos.apps.listRecent(50);
  return html(renderLandingPage(context, apps));
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

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location },
  });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html>${body}`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function renderLandingPage(
  context: AppContext,
  apps: AppProfile[],
): string {
  const host = new URL(context.config.origin).host;
  const appCards = apps.length === 0
    ? `<p class="empty">This node has not indexed any apps in its current KV store yet. Trigger ingestion, then reload this page.</p>`
    : apps.map((app) => appCard(context, app)).join("");

  return pageShell({
    title: "Flathub ActivityPub",
    body: `
      <div class="landing-page">
      <section class="hero">
        <p class="eyebrow">Flathub ActivityPub relay</p>
        <h1>Release notes with Fediverse addresses.</h1>
        <p class="lede">This node turns observed Flathub apps into followable actors. Search the handle in Mastodon, follow the app, and future changelogs arrive as posts.</p>
        <div class="hero-actions">
          <code>@app.id@${escapeHtml(host)}</code>
          <a href="#recent-apps">Pick an app</a>
          <a class="secondary" href="https://flathub.org" rel="noreferrer">Browse Flathub</a>
        </div>
      </section>

      <section class="panel instructions" aria-labelledby="how-to-follow">
        <h2 id="how-to-follow">How to follow</h2>
        <ol>
          <li>Pick an indexed app below.</li>
          <li>Paste its handle into Mastodon search.</li>
          <li>Follow it. New release notes will be delivered after the follow is accepted.</li>
        </ol>
      </section>

      <section class="app-grid" aria-labelledby="recent-apps">
        <div class="section-heading">
          <h2 id="recent-apps">Recently observed apps</h2>
          <p>${apps.length} shown from this server's local ingestion store.</p>
        </div>
        ${appCards}
      </section>
      </div>
    `,
  });
}

function renderAppPage(
  context: AppContext,
  profile: AppProfile,
  posts: PostRecord[],
): string {
  const handle = fediverseHandle(context, profile.appId);
  const releaseItems = posts.length === 0
    ? `<p class="empty">No described releases have been published for this app yet.</p>`
    : posts.map((post) => releaseSection(post)).join("");

  return pageShell({
    title: `${profile.name} - Flathub ActivityPub`,
    body: `
      <div class="app-page">
      <nav class="crumb"><a href="/">All apps</a></nav>
      <section class="app-hero panel">
        ${
      profile.iconUrl
        ? `<img class="app-icon" src="${
          escapeAttribute(profile.iconUrl)
        }" alt="">`
        : ""
    }
        <div>
          <p class="eyebrow">Flathub app actor</p>
          <h1>${escapeHtml(profile.name)}</h1>
          <p class="lede">${
      escapeHtml(profile.summary ?? "Flathub changelog actor")
    }</p>
          <dl class="facts">
            <div><dt>Fediverse handle</dt><dd><code>${
      escapeHtml(handle)
    }</code></dd></div>
            <div><dt>App ID</dt><dd><code>${
      escapeHtml(profile.appId)
    }</code></dd></div>
            <div><dt>Last observed</dt><dd>${
      formatUpdatedAt(profile.lastSeenUpdatedAt)
    }</dd></div>
          </dl>
          <div class="hero-actions">
            <a href="${
      escapeAttribute(profile.flathubUrl)
    }" rel="noreferrer">View on Flathub</a>
          </div>
        </div>
        <aside class="actor-card" aria-label="Follow this app">
          <span>Follow address</span>
          <code>${escapeHtml(handle)}</code>
          <p>Paste this handle into Mastodon or another Fediverse search box.</p>
          <form class="follow-form" method="get" action="${
      actorPath(profile.appId)
    }">
            <input type="hidden" name="follow" value="1">
            <label for="follow-server">Your server</label>
            <div>
              <input id="follow-server" name="server" placeholder="mastodon.social" autocomplete="off" required>
              <button type="submit">Follow</button>
            </div>
          </form>
        </aside>
      </section>

      <section class="release-list" aria-labelledby="release-notes">
        <div class="section-heading">
          <h2 id="release-notes">Release notes</h2>
          <p>${posts.length} ActivityPub ${
      posts.length === 1 ? "note" : "notes"
    } published by this actor.</p>
        </div>
        ${releaseItems}
      </section>
      </div>
    `,
  });
}

function appCard(context: AppContext, app: AppProfile): string {
  return `
    <a class="app-card" href="${actorPath(app.appId)}">
      ${
    app.iconUrl
      ? `<img class="app-icon small" src="${
        escapeAttribute(app.iconUrl)
      }" alt="">`
      : ""
  }
      <div>
        <h3>${escapeHtml(app.name)}</h3>
        <p>${escapeHtml(app.summary ?? "Flathub changelog actor")}</p>
        <code title="${escapeAttribute(fediverseHandle(context, app.appId))}">${
    escapeHtml(fediverseHandle(context, app.appId))
  }</code>
      </div>
    </a>
  `;
}

function handleRemoteFollow(
  context: AppContext,
  profile: AppProfile,
  url: URL,
): Response {
  const server = normalizeFollowServer(url.searchParams.get("server") ?? "");
  if (!server) {
    return html(
      pageShell({
        title: "Invalid follow server - Flathub ActivityPub",
        body:
          `<section class="panel error-page"><h1>Invalid follow server</h1><p>Enter a Mastodon or Fediverse server host, for example <code>mastodon.social</code>.</p><p><a href="${
            actorPath(profile.appId)
          }">Back to ${escapeHtml(profile.name)}</a></p></section>`,
      }),
      400,
    );
  }

  const followUrl = new URL("/authorize_interaction", server);
  followUrl.searchParams.set("uri", acctUri(context, profile.appId));
  return redirect(followUrl.href);
}

function normalizeFollowServer(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    url.username = "";
    url.password = "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

function releaseSection(
  post: PostRecord,
): string {
  return `
    <article id="release-${
    escapeAttribute(post.releaseFingerprint)
  }" class="release panel">
      <a class="release-anchor" href="#release-${
    escapeAttribute(post.releaseFingerprint)
  }" aria-label="Link to this release">#</a>
      <time datetime="${escapeAttribute(post.publishedAt)}">${
    formatDate(post.publishedAt)
  }</time>
      <div class="release-content">${post.contentHtml}</div>
    </article>
  `;
}

function pageShell(input: { title: string; body: string }): string {
  return `<html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(input.title)}</title>
      <style>
        :root {
          color-scheme: light;
          --paper: #eef8fb;
          --ink: #10202a;
          --muted: #55707c;
          --line: #b7dce4;
          --rail: #40dca5;
          --flathub: #2378d5;
          --violet: #4d49b8;
          --card: #fbfeff;
          --shadow: rgba(20, 78, 105, .12);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          color: var(--ink);
          background:
            radial-gradient(circle at 18% 12%, rgba(64, 220, 165, .35), transparent 26rem),
            radial-gradient(circle at 82% 0%, rgba(35, 120, 213, .20), transparent 24rem),
            linear-gradient(90deg, rgba(16, 32, 42, .05) 1px, transparent 1px),
            linear-gradient(rgba(16, 32, 42, .05) 1px, transparent 1px),
            var(--paper);
          background-size: auto, auto, 28px 28px, 28px 28px;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          line-height: 1.5;
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0 auto 0 0;
          width: 12px;
          background: repeating-linear-gradient(180deg, var(--rail) 0 18px, var(--flathub) 18px 36px, var(--violet) 36px 54px);
          pointer-events: none;
        }
        a { color: var(--flathub); text-decoration-thickness: .09em; text-underline-offset: .2em; }
        a:focus-visible { outline: 3px solid var(--rail); outline-offset: 3px; }
        code {
          display: inline-block;
          max-width: 100%;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .86em;
          line-height: 1.35;
          background: #e1f8f2;
          border: 1px solid #a7e8d5;
          border-radius: 8px;
          color: #0d5f48;
          padding: .22rem .5rem;
          overflow-wrap: anywhere;
        }
        main { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 44px 0 72px; }
        .landing-page, .app-page { width: 100%; }
        .app-page { max-width: 1080px; margin: 0 auto; }
        h1, h2, h3 { line-height: 1.05; margin: 0; }
        h1 { font-size: clamp(3rem, 8vw, 6.4rem); letter-spacing: -.075em; max-width: 980px; font-weight: 900; }
        h2 { font-size: clamp(1.6rem, 3vw, 2.6rem); letter-spacing: -.045em; font-weight: 850; }
        h3 { font-size: 1.15rem; letter-spacing: -.025em; }
        .hero { position: relative; padding: 72px 0 44px; }
        .hero::after {
          content: "AP://RELEASES";
          position: absolute;
          right: 0;
          top: 64px;
          color: rgba(35, 120, 213, .14);
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: clamp(2rem, 7vw, 5.8rem);
          font-weight: 900;
          letter-spacing: -.08em;
          pointer-events: none;
          writing-mode: vertical-rl;
        }
        .eyebrow {
          margin: 0 0 14px;
          color: #0d7456;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .78rem;
          font-weight: 700;
          letter-spacing: .16em;
          text-transform: uppercase;
        }
        .lede { color: var(--muted); font-size: clamp(1.06rem, 2vw, 1.35rem); max-width: 710px; margin: 18px 0 0; }
        .hero-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 22px; }
        .hero .hero-actions code {
          background: rgba(251, 254, 255, .78);
          border-color: rgba(35, 120, 213, .18);
          color: var(--muted);
          padding: .42rem .65rem;
        }
        .hero-actions a {
          display: inline-flex;
          min-height: 38px;
          align-items: center;
          border: 1px solid var(--flathub);
          border-radius: 10px;
          padding: .46rem .78rem;
          background: var(--flathub);
          color: white;
          font-size: .94rem;
          text-decoration: none;
          font-weight: 750;
        }
        .hero-actions a.secondary { background: transparent; color: var(--flathub); }
        button {
          border: 1px solid var(--flathub);
          border-radius: 10px;
          background: var(--flathub);
          color: white;
          cursor: pointer;
          font: inherit;
          font-weight: 750;
          padding: .55rem .75rem;
        }
        input {
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: white;
          color: var(--ink);
          font: inherit;
          padding: .55rem .65rem;
        }
        input:focus-visible, button:focus-visible { outline: 3px solid var(--rail); outline-offset: 3px; }
        .panel, .app-card {
          background: color-mix(in srgb, var(--card) 94%, transparent);
          border: 1px solid var(--line);
          border-radius: 18px;
          box-shadow: 0 24px 70px var(--shadow);
        }
        .instructions { padding: 22px; margin: 18px 0 42px; border-left: 8px solid var(--rail); }
        .instructions ol { display: grid; gap: 8px; margin-bottom: 0; padding-left: 1.3rem; }
        .section-heading { display: flex; justify-content: space-between; gap: 20px; align-items: end; margin: 0 0 18px; }
        .section-heading p { color: var(--muted); margin: 0; max-width: 360px; }
        .app-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
        .app-grid .section-heading { grid-column: 1 / -1; }
        .app-card { position: relative; display: flex; gap: 16px; padding: 16px; min-height: 164px; overflow: hidden; color: inherit; text-decoration: none; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
        .app-card::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 4px;
          background: linear-gradient(90deg, var(--rail), var(--flathub));
          opacity: .75;
        }
        .app-card > div { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; }
        .app-card p { color: var(--muted); margin: 8px 0 12px; }
        .app-card code { margin-top: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .app-card:hover { transform: translateY(-2px); border-color: #73bff0; box-shadow: 0 30px 80px rgba(20, 78, 105, .18); }
        .app-card:hover h3 { color: var(--flathub); text-decoration: underline; text-decoration-thickness: .08em; text-underline-offset: .18em; }
        .app-icon { width: 96px; height: 96px; border-radius: 22px; flex: 0 0 auto; box-shadow: inset 0 0 0 1px rgba(16, 32, 42, .08); }
        .app-icon.small { width: 54px; height: 54px; border-radius: 14px; }
        .crumb { margin-bottom: 20px; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
        .app-hero { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(250px, 320px); gap: 24px; padding: 28px; align-items: flex-start; }
        .actor-card {
          align-self: stretch;
          display: grid;
          align-content: start;
          gap: 12px;
          padding: 18px;
          border-radius: 14px;
          background: linear-gradient(180deg, #e5f7ff, #e7fbf4);
          border: 1px solid var(--line);
        }
        .actor-card span {
          color: #0d7456;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .72rem;
          font-weight: 800;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        .actor-card p { color: var(--muted); margin: 0; }
        .follow-form { display: grid; gap: 8px; margin-top: 8px; }
        .follow-form label {
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .72rem;
          font-weight: 800;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        .follow-form div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
        .follow-form input { width: 100%; }
        .error-page { padding: 28px; margin-top: 48px; }
        .facts { display: grid; gap: 12px; margin: 24px 0 0; }
        .facts div { display: grid; gap: 4px; }
        .facts dt { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .12em; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
        .facts dd { margin: 0; }
        .release-list { margin-top: 42px; }
        .release { position: relative; padding: 28px 30px; margin: 0 0 18px; border-left: 8px solid var(--rail); }
        .release-anchor { position: absolute; top: 22px; right: 22px; text-decoration: none; color: var(--muted); }
        .release time { color: #0d7456; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .88rem; }
        .release-content { max-width: 860px; font-size: 1.02rem; }
        .release-content > p:first-child { font-size: 1.08rem; }
        .release-content h1, .release-content h2, .release-content h3, .release-content p { max-width: 760px; }
        .release-content section { margin-top: 12px; }
        .release-content li { margin: .26rem 0; }
        .release-content ul { padding-left: 1.25rem; }
        .empty { color: var(--muted); padding: 20px; border: 1px dashed var(--line); border-radius: 16px; background: rgba(251, 254, 255, .66); }
        @media (max-width: 720px) {
          body::before { width: 6px; }
          main { width: min(100% - 24px, 1120px); padding-top: 28px; }
          .hero { padding-top: 40px; }
          .hero::after { display: none; }
          .section-heading, .app-hero { display: block; }
          .app-icon { margin-bottom: 16px; }
          .app-card { align-items: flex-start; }
          .actor-card { margin-top: 18px; }
        }
      </style>
    </head>
    <body><main>${input.body}</main></body>
  </html>`;
}

function actorPath(appId: string): string {
  return `/apps/${encodeURIComponent(appId)}`;
}

function fediverseHandle(context: AppContext, appId: string): string {
  return `@${appId}@${new URL(context.config.origin).host}`;
}

function acctUri(context: AppContext, appId: string): string {
  return `acct:${appId}@${new URL(context.config.origin).host}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Unknown";
  return formatDate(new Date(value * 1000).toISOString());
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}
