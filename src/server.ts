import type { Config } from "./config.ts";
import { FlathubClient } from "./flathub/client.ts";
import {
  announceActivity,
  appAnnounceActivity,
  createActivity,
  noteDocument,
  webfinger,
} from "./federation/activity.ts";
import {
  type AppCollectionActorProfile,
  COLLECTION_ACTORS,
  type CollectionActorProfile,
  getCollectionActor,
  type PostCollectionActorProfile,
} from "./federation/collections.ts";
import {
  createFedifyFederation,
  type FederationData,
} from "./federation/fedify.ts";
import { Ingestor } from "./ingestion/ingestor.ts";
import { createRepositories, type Repositories } from "./store/d1_store.ts";
import type { AppProfile, PostKind, PostRecord } from "./store/types.ts";
import type { Federation, MessageQueue } from "@fedify/fedify";
import { resolve4, resolve6 } from "node:dns/promises";

const ACTIVITY_JSON = "application/activity+json; charset=utf-8";

type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

export interface AppContext {
  config: Config;
  repos: Repositories;
  ingestor: Ingestor;
  federation: Federation<FederationData>;
  fetcher?: typeof fetch;
  resolveHostAddresses?: ResolveHostAddresses;
  enqueueIngestion?: (kind: "bootstrap" | "poll") => Promise<void>;
}

export function createApp(
  config: Config,
  db: D1Database,
  queue?: MessageQueue,
): AppContext {
  const repos = createRepositories(db);
  const client = new FlathubClient(config.flathubApiBase);
  const federation = createFedifyFederation(config, db, queue);
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
        try {
          await context.repos.state.get("readiness");
        } catch {
          return json({ ok: false }, 503);
        }
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return await handleLandingPage(context);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return await handleStatusPage(context);
      }
      if (request.method === "GET" && url.pathname === "/sitemap.xml") {
        return await handleSitemap(context);
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
        if (context.enqueueIngestion) {
          await context.enqueueIngestion("bootstrap");
          return json({ queued: true }, 202);
        }
        await context.ingestor.bootstrap();
        return json({ ok: true });
      }
      if (
        request.method === "POST" && url.pathname === "/internal/ingest/poll"
      ) {
        const unauthorized = authorizeInternalRequest(context, request);
        if (unauthorized) return unauthorized;
        if (context.enqueueIngestion) {
          await context.enqueueIngestion("poll");
          return json({ queued: true }, 202);
        }
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
      if (
        request.method === "GET" &&
        /^\/apps\/[^/]+$/.test(url.pathname) &&
        fedifyResponse.ok &&
        fedifyResponse.headers.get("content-type")?.includes(
          "application/activity+json",
        )
      ) {
        const actor = await fedifyResponse.json<Record<string, unknown>>();
        // Mastodon ignores profile fields unless attachment is an array.
        if (actor.attachment != null && !Array.isArray(actor.attachment)) {
          actor.attachment = [actor.attachment];
        }
        return new Response(JSON.stringify(actor), {
          status: fedifyResponse.status,
          headers: fedifyResponse.headers,
        });
      }
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
  const collection = getCollectionActor(appId);
  if (!profile && !collection) return json({ error: "unknown app" }, 404);
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
  const collection = getCollectionActor(appId);
  if (!profile && !collection) return json({ error: "unknown app" }, 404);

  if (parts.length === 2 && request.method === "GET") {
    if (url.searchParams.has("follow")) {
      return handleRemoteFollow(context, {
        id: profile?.appId ?? collection!.id,
        name: profile?.name ?? collection!.name,
      }, url);
    }
    if (acceptsActivityJson(request)) {
      return json({ error: "not found" }, 404);
    }
    if (collection) {
      if (collection.type === "post") {
        const posts = await context.repos.releases.listRecentPosts(
          collection.postKind,
        );
        const profiles = await appProfilesForPosts(context, posts);
        return html(renderCollectionPage(context, collection, posts, profiles));
      }
      const apps = await context.repos.feeds.listAppProfiles(collection.id);
      return html(renderAppCollectionPage(context, collection, apps));
    }
    const posts = await context.repos.releases.listPosts(appId);
    return html(renderAppPage(context, profile!, posts));
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
    if (collection?.type === "app-list") {
      const apps = await context.repos.feeds.listAppProfiles(collection.id);
      const totalItems = await context.repos.feeds.countAppProfiles(
        collection.id,
      );
      return json(
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${context.config.origin}${url.pathname}`,
          type: "OrderedCollection",
          summary:
            `Latest ${apps.length} apps from Flathub's ${collection.flathubCollection} collection snapshot.`,
          totalItems,
          orderedItems: apps.map((app) =>
            appAnnounceActivity(context.config.origin, collection.id, app.appId)
          ),
        },
        200,
        ACTIVITY_JSON,
      );
    }

    const posts = collection?.type === "post"
      ? await context.repos.releases.listRecentPosts(collection.postKind)
      : await context.repos.releases.listPosts(appId);
    const totalItems = collection?.type === "post"
      ? await context.repos.releases.countPosts(collection.postKind)
      : posts.length;
    return json(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${context.config.origin}${url.pathname}`,
        type: "OrderedCollection",
        summary: collection
          ? `Latest ${posts.length} items from ${totalItems} total stored posts.`
          : undefined,
        totalItems,
        orderedItems: collection?.type === "post"
          ? posts.map((post) =>
            announceActivity(context.config.origin, collection.id, post)
          )
          : posts.map((post) => createActivity(context.config.origin, post)),
      },
      200,
      ACTIVITY_JSON,
    );
  }

  if (
    parts.length === 4 && parts[2] === "releases" && request.method === "GET"
  ) {
    if (!profile) return json({ error: "unknown app" }, 404);
    const fingerprint = parts[3];
    const post = await context.repos.releases.getPost(appId, fingerprint);
    if (!post) return json({ error: "unknown release" }, 404);
    if (post.kind === "new-app") return json({ error: "unknown release" }, 404);
    if (acceptsActivityJson(request)) {
      return json(
        noteDocument(context.config.origin, post),
        200,
        ACTIVITY_JSON,
      );
    }
    return redirect(`${actorPath(appId)}#${postAnchorId(post)}`);
  }

  if (
    parts.length === 4 && parts[2] === "posts" && request.method === "GET"
  ) {
    if (!profile) return json({ error: "unknown app" }, 404);
    const postId = parts[3];
    const post = await context.repos.releases.getPost(appId, postId);
    if (!post) return json({ error: "unknown post" }, 404);
    if (post.kind !== "new-app") return json({ error: "unknown post" }, 404);
    if (acceptsActivityJson(request)) {
      return json(
        noteDocument(context.config.origin, post),
        200,
        ACTIVITY_JSON,
      );
    }
    return redirect(`${actorPath(appId)}#${postAnchorId(post)}`);
  }

  return json({ error: "not found" }, 404);
}

async function handleLandingPage(context: AppContext): Promise<Response> {
  const [apps, posts] = await Promise.all([
    context.repos.apps.listRecent(50),
    context.repos.releases.listRecentPosts(undefined, 1),
  ]);
  const latestPost = posts[0];
  const latestApp = latestPost
    ? await context.repos.apps.get(latestPost.appId)
    : undefined;
  return html(renderLandingPage(apps, latestPost, latestApp ?? undefined));
}

async function handleStatusPage(context: AppContext): Promise<Response> {
  const [
    appCount,
    postCount,
    releasePostCount,
    newAppPostCount,
    followerCount,
    crawlState,
    recentlyAddedState,
    bootstrapState,
    recentPosts,
  ] = await Promise.all([
    context.repos.apps.count(),
    context.repos.releases.countPosts(),
    context.repos.releases.countPosts("release"),
    context.repos.releases.countPosts("new-app"),
    context.repos.followers.count(),
    context.repos.state.getCrawlState(),
    context.repos.state.getRecentlyAddedState(),
    context.repos.state.getBootstrapState(),
    context.repos.releases.listRecentPosts(undefined, 10),
  ]);
  return html(renderStatusPage(context, {
    appCount,
    postCount,
    releasePostCount,
    newAppPostCount,
    followerCount,
    queueMode: context.config.fedifyQueue,
    crawlScheduler: context.config.crawlScheduler,
    crawlState,
    recentlyAddedState,
    bootstrapState,
    recentPosts,
  }));
}

async function handleSitemap(context: AppContext): Promise<Response> {
  const [apps, releasePosts, newAppPosts] = await Promise.all([
    context.repos.apps.listAll(),
    context.repos.releases.listRecentPosts("release", 1),
    context.repos.releases.listRecentPosts("new-app", 1),
  ]);
  const now = new Date().toISOString();
  const entries: SitemapEntry[] = [
    {
      loc: `${context.config.origin}/`,
      lastmod: now,
      changefreq: "hourly",
      priority: "1.0",
    },
    {
      loc: `${context.config.origin}/status`,
      lastmod: now,
      changefreq: "hourly",
      priority: "0.3",
    },
  ];

  for (const collection of COLLECTION_ACTORS) {
    const recent = collection.type === "post"
      ? collection.postKind === "new-app" ? newAppPosts[0] : releasePosts[0]
      : undefined;
    entries.push({
      loc: `${context.config.origin}${actorPath(collection.id)}`,
      lastmod: recent?.publishedAt ?? now,
      changefreq: "hourly",
      priority: "0.8",
    });
  }

  for (const app of apps) {
    entries.push({
      loc: `${context.config.origin}${actorPath(app.appId)}`,
      lastmod: appLastModified(app),
      changefreq: "daily",
      priority: "0.6",
    });
  }

  return xml(renderSitemap(entries));
}

async function appProfilesForPosts(
  context: AppContext,
  posts: PostRecord[],
): Promise<Map<string, AppProfile>> {
  const appIds = [...new Set(posts.map((post) => post.appId))];
  const profiles = await Promise.all(
    appIds.map((appId) => context.repos.apps.get(appId)),
  );
  const byAppId = new Map<string, AppProfile>();
  for (let index = 0; index < appIds.length; index++) {
    const profile = profiles[index];
    if (profile) byAppId.set(appIds[index], profile);
  }
  return byAppId;
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

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

const sectionHeadingClasses = "flex items-center justify-between gap-6 mobile:flex-col mobile:items-start mobile:gap-[18px]";
const sectionCaptionClasses = "text-muted text-[14px] mt-[7px] mb-0";
const appPageClasses = "desktop:grid desktop:grid-cols-[88px_minmax(0,1fr)_340px] desktop:gap-x-7 desktop:items-start";
const appHeroClasses = "grid grid-cols-[72px_minmax(0,1fr)_310px] items-start gap-5 pt-5 pb-12 desktop:contents mobile:grid-cols-[72px_minmax(0,1fr)] mobile:pb-6";
const appTitleClasses = "text-[clamp(32px,4vw,48px)] wrap-anywhere mobile:text-[36px]";
const appSummaryClasses = "text-[17px] leading-[1.65] text-muted mt-4 mb-0 wrap-anywhere mobile:text-[15px]";
const appGridClasses = "grid grid-cols-2 gap-x-6 gap-y-0 phone:grid-cols-1";
const releaseListClasses = "max-w-[820px] mt-6 desktop:col-start-1 desktop:col-span-2 desktop:mt-12";
const emptyClasses = "col-span-full p-8 border border-dashed border-line rounded-xl text-muted max-w-none";
const secondaryButtonClasses = "inline-flex items-center justify-center min-h-[46px] px-5 py-2.5 rounded-[10px] font-[650] no-underline bg-surface text-action border border-solid border-line hover:bg-soft hover:border-action";
const fallbackIconClasses = "grid place-items-center bg-soft text-action rounded-[14px] font-display font-bold text-[26px] leading-none";
const statusPanelClasses = "p-7 mb-6 border border-solid border-line rounded-[14px] bg-surface mobile:p-5";

function directoryCrumb(): string {
  return `<nav class="my-8 text-[14px] col-span-full"><a class="text-muted" href="/">App directory</a></nav>`;
}

function renderLandingPage(
  apps: AppProfile[],
  latestPost?: PostRecord,
  latestApp?: AppProfile,
): string {
  const collectionCards = COLLECTION_ACTORS.map((actor) =>
    collectionCard(actor)
  )
    .join("");
  const appCards = apps.length === 0
    ? `<div class="${emptyClasses}"><h3 class="mb-2">No apps indexed yet</h3><p class="mt-0 mb-4">You can already follow a feed to receive future updates while this server syncs with Flathub.</p><a class="text-[14px] font-semibold" href="#feed-actors">Browse the feeds</a></div>`
    : apps.map((app) => appCard(app)).join("");

  return pageShell({
    title: "Flathub App Updates",
    body: `
      <div class="landing-page">
      <section class="grid grid-cols-[minmax(0,1fr)_320px] items-center gap-14 pt-12 pb-[50px] tablet:gap-8 mobile:grid-cols-1 mobile:gap-5 mobile:pt-8 mobile:pb-9">
        <h1 class="text-[clamp(42px,4.4vw,60px)] leading-[1.04] tracking-[-.025em] phone:text-[36px]">Follow app updates</h1>
        <div><p class="mt-0 mb-3 text-muted text-[15px] leading-[1.7]">Follow Flathub apps from Mastodon or another Fediverse server to get release notes in your timeline.</p><a class="text-[14px] font-semibold" href="#how-to-follow">How to follow an app</a></div>
      </section>
      <div class="grid items-start ${apps.length ? "grid-cols-[minmax(0,1fr)_320px] gap-14 tablet:grid-cols-1 tablet:gap-10" : "grid-cols-1 gap-8 tablet:gap-10"}">
      <section aria-labelledby="recent-apps">
        <div class="${sectionHeadingClasses} min-h-14 mb-5">
          <div><h2 class="text-[25px]" id="recent-apps">Apps to follow</h2>
          <p class="text-muted text-[12px] mt-[7px] mb-0" id="app-count" role="status">${apps.length} recently indexed ${apps.length === 1 ? "app" : "apps"}</p></div>
          ${
      apps.length > 0 ? `<div class="directory-search relative w-[min(100%,260px)] mobile:w-full" hidden>
            <label class="sr-only" for="app-search">Filter recently indexed apps</label>
            <svg class="absolute start-3.5 top-[15px] size-5 pointer-events-none text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
             <input class="w-full ps-[43px]" type="search" id="app-search" placeholder="Filter apps" autocomplete="off" aria-controls="directory-apps">
          </div>` : ""
    }
        </div>
        <div class="${appGridClasses}" id="directory-apps">${appCards}</div>
        <p class="${emptyClasses}" id="search-empty" hidden>No apps match your search. Try another name or browse the feeds.</p>
      </section>
      <div class="${apps.length ? "border-s border-solid border-line ps-7 desktop:sticky desktop:top-6 desktop:max-h-[calc(100vh-48px)] desktop:overflow-y-auto desktop:pe-1.5 desktop:[scrollbar-width:thin] tablet:grid tablet:grid-cols-2 tablet:gap-8 tablet:border-s-0 tablet:ps-0" : "grid grid-cols-2 gap-10"} mobile:grid-cols-1">
        ${updateSpotlight(latestPost, latestApp)}
        <section class="${apps.length ? "mt-9 tablet:mt-0" : "mt-0"}" aria-labelledby="feed-actors">
          <h2 class="text-[20px] tracking-[-.02em]" id="feed-actors">Follow a feed</h2>
          <p class="text-[13px] text-muted mt-2 mb-3.5">Get updates from several apps.</p>
          <div class="grid">${collectionCards}</div>
        </section>
      </div>
      </div>
      <section class="grid grid-cols-[.8fr_2fr] gap-12 mt-14 pt-9 border-t border-solid border-line tablet:grid-cols-1 tablet:gap-6 phone:pt-7 phone:mt-10" aria-labelledby="how-to-follow">
        <div><h2 class="text-[26px]" id="how-to-follow">How to follow</h2><p class="text-[14px] text-muted mb-0">Use your existing Fediverse account.</p></div>
        <ol class="grid grid-cols-3 gap-6 list-none p-0 m-0 phone:grid-cols-1 phone:gap-[22px]">
          ${followStep(1, "Choose an app", "Open an app or update feed to find its Fediverse handle.")}
          ${followStep(2, "Find it on your server", "Enter your server address, or paste the handle into the search on your server.")}
          ${followStep(3, "Follow the account", "Press Follow on your server to receive updates in your timeline.")}
        </ol>
      </section>
      </div>
    `,
  });
}

function followStep(number: number, title: string, description: string): string {
  return `<li class="text-[13px] text-muted phone:relative phone:ps-[42px]"><span aria-hidden="true" class="grid place-items-center size-7 mb-3 rounded-full bg-soft text-action font-bold phone:absolute phone:start-0 phone:top-0">${number}</span><strong class="block text-[14px] text-ink mb-[5px]">${escapeHtml(title)}</strong>${escapeHtml(description)}</li>`;
}

function renderAppPage(
  context: AppContext,
  profile: AppProfile,
  posts: PostRecord[],
): string {
  const handle = fediverseHandle(context, profile.appId);
  const releaseItems = posts.length === 0
    ? `<p class="${emptyClasses}">No updates for this app yet. Follow it to receive future release notes in your timeline.</p>`
    : posts.map((post) => releaseSection(post)).join("");

  return pageShell({
    title: `${profile.name} - Flathub App Updates`,
    body: `
      <div class="${appPageClasses}">
      ${directoryCrumb()}
      <section class="${appHeroClasses}">
        ${
      profile.iconUrl
        ? `<img class="shrink-0 size-22 object-contain tablet:size-18" src="${
          escapeAttribute(profile.iconUrl)
        }" alt="">`
        : `<span class="shrink-0 size-22 tablet:size-18 ${fallbackIconClasses}" aria-hidden="true">${
          escapeHtml(Array.from(profile.name)[0] ?? "?")
        }</span>`
    }
        <div>
          <p class="mt-0 mb-2 text-muted text-[13px]">App updates</p>
          <h1 class="${appTitleClasses}">${escapeHtml(profile.name)}</h1>
          <p class="${appSummaryClasses}">${
      escapeHtml(profile.summary ?? "Flathub release updates")
    }</p>
          <dl class="grid gap-5 mt-6 mb-0">
            <div><dt>Last update found</dt><dd>${
      formatUpdatedAt(profile.lastSeenUpdatedAt)
    }</dd></div>
          </dl>
          <div class="flex flex-wrap gap-3 mt-7">
            <a class="${secondaryButtonClasses}" href="${
      escapeAttribute(profile.flathubUrl)
    }" rel="noreferrer">View on Flathub</a>
          </div>
        </div>
        ${followCard(profile.appId, handle, "app")}
      </section>

      <section class="${releaseListClasses}" aria-labelledby="release-notes">
        <div class="${sectionHeadingClasses} mb-6">
          <h2 id="release-notes">Updates</h2>
          <p class="${sectionCaptionClasses}">${posts.length} ${
      posts.length === 1 ? "update" : "updates"
    } from this app</p>
        </div>
        ${releaseItems}
      </section>
      </div>
    `,
  });
}

function renderCollectionPage(
  context: AppContext,
  collection: PostCollectionActorProfile,
  posts: PostRecord[],
  profilesByAppId: Map<string, AppProfile>,
): string {
  const handle = fediverseHandle(context, collection.id);
  const postItems = posts.length === 0
    ? `<p class="${emptyClasses}">No updates in this feed yet. Follow it to receive new posts as they arrive.</p>`
    : posts.map((post) => releaseSection(post, profilesByAppId.get(post.appId)))
      .join("");

  return pageShell({
    title: `${collection.name} - Flathub App Updates`,
    body: `
      <div class="${appPageClasses}">
      ${directoryCrumb()}
      <section class="${appHeroClasses}">
        ${feedIcon(collection, "large")}
        <div>
          <p class="mt-0 mb-2 text-muted text-[13px]">Update feed</p>
          <h1 class="${appTitleClasses}">${escapeHtml(collection.name)}</h1>
          <p class="${appSummaryClasses}">${escapeHtml(collection.summary)}</p>
        </div>
        ${followCard(collection.id, handle, "feed")}
      </section>

      <section class="${releaseListClasses}" aria-labelledby="announced-posts">
        <div class="${sectionHeadingClasses} mb-6">
          <h2 id="announced-posts">Updates</h2>
          <p class="${sectionCaptionClasses}">${posts.length} ${
      posts.length === 1 ? "post" : "posts"
    } announced by this feed</p>
        </div>
        ${postItems}
      </section>
      </div>
    `,
  });
}

function renderAppCollectionPage(
  context: AppContext,
  collection: AppCollectionActorProfile,
  apps: AppProfile[],
): string {
  const handle = fediverseHandle(context, collection.id);
  const appItems = apps.length === 0
    ? `<p class="${emptyClasses}">There are no apps in this feed yet.</p>`
    : apps.map((app) => appCard(app)).join("");

  return pageShell({
    title: `${collection.name} - Flathub App Updates`,
    body: `
      <div class="${appPageClasses}">
      ${directoryCrumb()}
      <section class="${appHeroClasses}">
        ${feedIcon(collection, "large")}
        <div>
          <p class="mt-0 mb-2 text-muted text-[13px]">Update feed</p>
          <h1 class="${appTitleClasses}">${escapeHtml(collection.name)}</h1>
          <p class="${appSummaryClasses}">${escapeHtml(collection.summary)}</p>
        </div>
        ${followCard(collection.id, handle, "feed")}
      </section>

      <section class="${appGridClasses} desktop:col-start-1 desktop:col-span-2 desktop:mt-12" aria-labelledby="feed-apps">
        <div class="${sectionHeadingClasses} col-span-full mb-6">
          <h2 id="feed-apps">Apps in this feed</h2>
          <p class="${sectionCaptionClasses}">${apps.length} apps in this feed</p>
        </div>
        ${appItems}
      </section>
      </div>
    `,
  });
}

function renderStatusPage(
  context: AppContext,
  status: {
    appCount: number;
    postCount: number;
    releasePostCount: number;
    newAppPostCount: number;
    followerCount: number;
    queueMode: Config["fedifyQueue"];
    crawlScheduler: Config["crawlScheduler"] | "disabled";
    crawlState: Awaited<ReturnType<Repositories["state"]["getCrawlState"]>>;
    recentlyAddedState: Awaited<
      ReturnType<Repositories["state"]["getRecentlyAddedState"]>
    >;
    bootstrapState: Awaited<
      ReturnType<Repositories["state"]["getBootstrapState"]>
    >;
    recentPosts: PostRecord[];
  },
): string {
  const recentRows = status.recentPosts.length === 0
    ? `<tr><td colspan="4">No indexed posts yet</td></tr>`
    : status.recentPosts.map((post) => `
      <tr>
        <td><a href="${escapeAttribute(post.noteId)}">${
      escapeHtml(post.appId)
    }</a></td>
        <td>${escapeHtml(postKindLabel(post.kind ?? "release"))}</td>
        <td>${formatDate(post.publishedAt)}</td>
        <td><code>${escapeHtml(post.releaseFingerprint)}</code></td>
      </tr>
    `).join("");

  return pageShell({
    title: "Status - Flathub ActivityPub",
    body: `
      <div>
      ${directoryCrumb()}
      <section class="block pt-4 pb-10">
        <p class="mt-0 mb-2 text-muted text-[13px]">Node status</p>
        <h1 class="text-[clamp(32px,4vw,48px)]">Ingestion and federation state</h1>
        <p class="text-[18px] leading-[1.65] text-muted mt-6 mb-0 wrap-anywhere phone:text-[16px]">Current server status for ${
      escapeHtml(new URL(context.config.origin).host)
    }</p>
      </section>

      <section class="grid grid-cols-5 gap-3 mb-8 mobile:grid-cols-2" aria-label="Status metrics">
        ${metricCard("Indexed apps", status.appCount)}
        ${metricCard("Total posts", status.postCount)}
        ${metricCard("Release posts", status.releasePostCount)}
        ${metricCard("New-app posts", status.newAppPostCount)}
        ${metricCard("Followers", status.followerCount)}
      </section>

      <section class="${statusPanelClasses}" aria-labelledby="crawl-state">
        <h2 id="crawl-state">Crawler state</h2>
        <dl class="grid grid-cols-2 gap-5 mt-6 mb-0 mobile:grid-cols-1">
          <div><dt>Fedify queue</dt><dd>${
      escapeHtml(status.queueMode)
    }</dd></div>
          <div><dt>Crawler scheduling</dt><dd>${
      escapeHtml(status.crawlScheduler)
    }</dd></div>
          <div><dt>Recently updated watermark</dt><dd>${
      status.crawlState
        ? formatUpdatedAt(status.crawlState.watermarkUpdatedAt)
        : "Never crawled"
    }</dd></div>
          <div><dt>Recently updated completed</dt><dd>${
      status.crawlState ? formatDate(status.crawlState.completedAt) : "Never"
    }</dd></div>
          <div><dt>Recently added watermark</dt><dd>${
      status.recentlyAddedState
        ? formatUpdatedAt(status.recentlyAddedState.watermarkAddedAt)
        : "Never crawled"
    }</dd></div>
          <div><dt>Recently added completed</dt><dd>${
      status.recentlyAddedState
        ? formatDate(status.recentlyAddedState.completedAt)
        : "Never"
    }</dd></div>
          <div><dt>Bootstrap</dt><dd>${
      status.bootstrapState
        ? status.bootstrapState.completed ? "Completed" : "In progress"
        : "Not started"
    }</dd></div>
          <div><dt>Bootstrap page</dt><dd>${
      status.bootstrapState ? String(status.bootstrapState.currentPage) : "-"
    }</dd></div>
        </dl>
      </section>

      <section class="${statusPanelClasses}" aria-labelledby="recent-posts">
        <div class="${sectionHeadingClasses} mb-6">
          <h2 id="recent-posts">Recent posts</h2>
          <p class="${sectionCaptionClasses}">Latest indexed ActivityPub notes across apps</p>
        </div>
        <div class="overflow-x-auto">
          <table>
            <thead><tr><th>Actor</th><th>Kind</th><th>Published</th><th>Key</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </section>
      </div>
    `,
  });
}

function followCard(id: string, handle: string, kind: "app" | "feed"): string {
  return `<aside class="p-6 bg-surface border border-solid border-line rounded-2xl desktop:col-start-3 desktop:row-start-2 desktop:row-span-2 mobile:col-span-full mobile:mt-3" aria-label="Follow this ${kind}">
    <span class="font-display font-bold text-[20px] leading-[1.3]">Follow this ${kind}</span>
    <code class="block p-3 mt-4 bg-soft rounded-lg text-[12px] select-all">${escapeHtml(handle)}</code>
    <button class="inline-flex items-center justify-center rounded-[10px] font-[650] bg-surface text-action border border-solid border-line hover:bg-soft hover:border-action w-full min-h-[38px] px-3 py-1.5 mt-2 text-[12px]" type="button" data-copy-handle="${
    escapeAttribute(handle)
  }" hidden>Copy handle</button>
    <p class="text-[13px] text-muted mt-1.5 mb-0" role="status"></p>
    <p class="text-[13px] text-muted mt-3 mb-5">Paste this handle into the search on your Fediverse server, or enter your server address below.</p>
    <form class="grid gap-2 pt-5 border-t border-solid border-line" method="get" action="${actorPath(id)}">
      <input type="hidden" name="follow" value="1">
      <label class="text-[13px] font-semibold" for="follow-server">Your server</label>
      <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input class="w-full text-[14px]" id="follow-server" name="server" placeholder="mastodon.social" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="follow-hint" required>
        <button class="inline-flex items-center justify-center min-h-[46px] px-4 py-2.5 rounded-[10px] bg-action text-white font-[650] text-[14px] hover:bg-action-hover dark:text-[#152031]" type="submit">Follow</button>
      </div>
      <small class="text-muted text-[12px]" id="follow-hint">Confirm the follow on your server.</small>
    </form>
  </aside>`;
}

function appCard(app: AppProfile): string {
  return `
    <a class="group flex items-start gap-[18px] py-[26px] px-1 border-t border-solid border-line no-underline text-ink hover:bg-soft phone:py-5" href="${actorPath(app.appId)}" data-app-search="${
    escapeAttribute(`${app.name} ${app.appId} ${app.summary ?? ""}`)
  }">
      ${
    app.iconUrl
      ? `<img class="shrink-0 size-15 object-contain drop-shadow-[0_1px_1px_#17243b24]" loading="lazy" width="60" height="60" src="${
        escapeAttribute(app.iconUrl)
      }" alt="">`
      : `<span class="shrink-0 size-15 drop-shadow-[0_1px_1px_#17243b24] ${fallbackIconClasses}" aria-hidden="true">${
        escapeHtml(Array.from(app.name)[0] ?? "?")
      }</span>`
  }
      <div class="min-w-0 flex flex-col min-h-[86px] self-stretch">
        <h3 class="wrap-anywhere font-body text-[17px] tracking-[-.02em] group-hover:text-action group-hover:underline underline-offset-[.2em]">${escapeHtml(app.name)}</h3>
        <p class="line-clamp-2 text-muted text-[13px] leading-[1.5] wrap-anywhere mt-1.5 mb-3">${escapeHtml(app.summary ?? "Flathub release updates")}</p>
        <span class="block text-muted text-[12px] mt-auto">${app.lastSeenUpdatedAt > 0 ? `Updated ${formatUpdatedAt(app.lastSeenUpdatedAt)}` : "View updates"}</span>
      </div>
    </a>
  `;
}

function updateSpotlight(
  post?: PostRecord,
  profile?: AppProfile,
): string {
  const name = profile?.name ?? post?.appId ?? "Recent releases";
  const path = post ? actorPath(post.appId) : actorPath("recent-releases");
  const icon = profile?.iconUrl
    ? `<img class="shrink-0 size-12 object-contain tablet:size-14" src="${escapeAttribute(profile.iconUrl)}" width="48" height="48" alt="">`
    : post
    ? `<span class="shrink-0 size-12 tablet:size-14 ${fallbackIconClasses}" aria-hidden="true">${escapeHtml(Array.from(name)[0] ?? "?")}</span>`
    : feedIcon(COLLECTION_ACTORS[0], "spotlight");
  const excerpt = post
    ? post.contentHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;").trim()
    : "Follow an app for its release notes, or follow the recent releases feed for updates from apps on Flathub.";
  return `<aside aria-label="${post ? "Latest app update" : "Discover app updates"}">
    <h2 class="mb-5 text-[20px] tracking-[-.02em]">${post ? "Latest from Flathub" : "Release notes in your timeline"}</h2>
    <article class="p-[22px] bg-soft rounded-[14px] tablet:p-5 phone:p-[22px]">
      <div class="flex items-center gap-3 phone:gap-3.5">${icon}<div class="min-w-0"><p class="mt-0 mb-1 text-muted text-[12px]">${post ? escapeHtml(postKindLabel(post.kind ?? "release")) : "Follow a feed"}</p><h3 class="text-[20px] leading-[1.2] wrap-anywhere">${escapeHtml(name)}</h3></div></div>
      ${post ? `<time class="block text-[12px] text-muted mt-[18px]" datetime="${escapeAttribute(post.publishedAt)}">${formatDate(post.publishedAt)}</time>` : ""}
      <p class="line-clamp-5 text-[14px] leading-[1.7] wrap-anywhere mt-2.5 mb-[18px] phone:line-clamp-4">${excerpt}</p>
      <a class="flex items-center justify-between gap-3 pt-3.5 border-t border-solid border-line no-underline text-[14px] font-[650] hover:underline" href="${path}${post ? `#${escapeAttribute(postAnchorId(post))}` : ""}">${post ? "Read full update" : "View recent releases"}<svg class="size-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></a>
    </article>
  </aside>`;
}

function collectionCard(actor: CollectionActorProfile): string {
  return `
    <a class="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-[3px] py-4 px-1 border-b border-solid border-line no-underline text-ink hover:bg-soft" href="${
    actorPath(actor.id)
  }">
      <div class="contents">
        ${feedIcon(actor, "small")}
        <h3 class="text-[16px] self-end phone:text-[17px]">${escapeHtml(actor.name)}</h3>
      </div>
      <div class="col-start-2">
        <p class="text-muted text-[12px] m-0">${escapeHtml(actor.summary)}</p>
      </div>
    </a>
  `;
}

function feedIcon(
  actor: CollectionActorProfile,
  size: "large" | "small" | "spotlight",
): string {
  const sizeClass = size === "small"
    ? "row-span-2 size-11 rounded-xl [&>svg]:size-7"
    : size === "spotlight"
    ? "size-12 rounded-[22px] tablet:size-14 [&>svg]:size-7"
    : "size-22 rounded-[22px] tablet:size-18 [&>svg]:size-13";
  const colors = actor.id === "new-apps"
    ? "text-[#237549] bg-[#e4f3e9] dark:bg-[#244537] dark:text-[#9bdbb6]"
    : actor.id === "trending-apps"
    ? "text-[#a45515] bg-[#fff0df] dark:bg-[#493726] dark:text-[#f5bd86]"
    : actor.id === "popular-apps"
    ? "text-[#7951b0] bg-[#f0e9fb] dark:bg-[#3c3154] dark:text-[#d0b6f4]"
    : "bg-soft text-action";
  return `<div class="grid place-items-center shrink-0 ${sizeClass} ${colors} [&>svg]:fill-none [&>svg]:stroke-current [&>svg]:stroke-[2.5] [&>svg]:[stroke-linecap:round] [&>svg]:[stroke-linejoin:round] [&_.icon-fill]:fill-current [&_.icon-fill]:[fill-opacity:.08]" aria-hidden="true">${feedIconSvg(actor.id)}</div>`;
}

function feedIconSvg(id: string): string {
  switch (id) {
    case "new-apps":
      return `<svg viewBox="0 0 48 48" focusable="false"><path class="icon-fill" d="M13 16l11-6 11 6v16L24 38l-11-6z"></path><path d="M24 10v28M13 16l11 6 11-6"></path><path d="M18 27h12M24 21v12"></path></svg>`;
    case "trending-apps":
      return `<svg viewBox="0 0 48 48" focusable="false"><path class="icon-fill" d="M10 36h28v4H10z"></path><path d="M12 32l8-9 7 5 10-15"></path><path d="M31 13h6v6"></path><circle cx="20" cy="23" r="2.5"></circle><circle cx="27" cy="28" r="2.5"></circle></svg>`;
    case "popular-apps":
      return `<svg viewBox="0 0 48 48" focusable="false"><path class="icon-fill" d="M24 8l4.9 10 11 1.6-8 7.8 1.9 11L24 33.2l-9.8 5.2 1.9-11-8-7.8 11-1.6z"></path><path d="M24 8l4.9 10 11 1.6-8 7.8 1.9 11L24 33.2l-9.8 5.2 1.9-11-8-7.8 11-1.6z"></path></svg>`;
    default:
      return `<svg viewBox="0 0 48 48" focusable="false"><path class="icon-fill" d="M14 8h15l7 7v25H14z"></path><path d="M14 8h15l7 7v25H14z"></path><path d="M29 8v8h7"></path><path d="M20 25h12M20 31h9"></path><path d="M32 31l4 4 7-9"></path></svg>`;
  }
}

function metricCard(label: string, value: number): string {
  return `
    <div class="p-5 bg-surface border border-solid border-line rounded-xl">
      <span class="text-[13px] text-muted">${escapeHtml(label)}</span>
      <strong class="block font-display font-bold text-[36px] leading-[1.4] tabular-nums">${value.toLocaleString("en")}</strong>
    </div>
  `;
}

function postKindLabel(kind: PostKind): string {
  return kind === "new-app" ? "New app" : "Release";
}

interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq: "hourly" | "daily";
  priority: string;
}

function renderSitemap(entries: SitemapEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${
    entries.map((entry) =>
      `  <url>
    <loc>${escapeXml(entry.loc)}</loc>
    <lastmod>${escapeXml(entry.lastmod)}</lastmod>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`
    ).join("\n")
  }
</urlset>`;
}

function appLastModified(app: AppProfile): string {
  if (Number.isFinite(app.lastSeenUpdatedAt) && app.lastSeenUpdatedAt > 0) {
    return new Date(app.lastSeenUpdatedAt * 1000).toISOString();
  }
  return app.updatedAt;
}

async function handleRemoteFollow(
  context: AppContext,
  actor: { id: string; name: string },
  url: URL,
): Promise<Response> {
  const server = normalizeFollowServer(url.searchParams.get("server") ?? "");
  if (!server) {
    return html(
      pageShell({
        title: "Invalid follow server - Flathub ActivityPub",
        body:
          `<section class="max-w-[680px] my-18"><h1 class="text-[40px]">Invalid follow server</h1><p>Enter a Mastodon or Fediverse server host, for example <code>mastodon.social</code></p><p><a href="${
            actorPath(actor.id)
          }">Back to ${escapeHtml(actor.name)}</a></p></section>`,
      }),
      400,
    );
  }

  const actorUrl = `${context.config.origin}${actorPath(actor.id)}`;
  const followUrl = await remoteInteractionUrl(context, server, actorUrl);
  return redirect(followUrl.href);
}

async function remoteInteractionUrl(
  context: AppContext,
  server: string,
  actorUrl: string,
): Promise<URL> {
  const fallback = fallbackInteractionUrl(server, actorUrl);
  const template = await discoverInteractionTemplate(context, server);
  if (!template) return fallback;
  return interactionUrlFromTemplate(template, actorUrl) ?? fallback;
}

function fallbackInteractionUrl(server: string, actorUrl: string): URL {
  const url = new URL("/authorize_interaction", server);
  url.searchParams.set("uri", actorUrl);
  return url;
}

interface InteractionTemplate {
  template: string;
  param: "object" | "uri";
}

async function discoverInteractionTemplate(
  context: AppContext,
  server: string,
): Promise<InteractionTemplate | null> {
  if (!(await canDiscoverInteractionTemplate(context, server))) return null;
  const webfingerUrl = new URL("/.well-known/webfinger", server);
  webfingerUrl.searchParams.set("resource", server);
  try {
    const response = await (context.fetcher ?? fetch)(webfingerUrl, {
      headers: { accept: "application/jrd+json, application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return interactionTemplateFromJrd(await response.json());
  } catch {
    return null;
  }
}

async function canDiscoverInteractionTemplate(
  context: AppContext,
  server: string,
): Promise<boolean> {
  const url = new URL(server);
  if (url.protocol !== "https:") return false;
  const hostname = normalizeDiscoveryHostname(url.hostname);
  if (isUnsafeDiscoveryHostname(hostname)) return false;
  const addresses = await resolveHostAddresses(context, hostname);
  return addresses.length > 0 && !addresses.some(isUnsafeResolvedAddress);
}

function normalizeDiscoveryHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isUnsafeDiscoveryHostname(hostname: string): boolean {
  return hostname === "" || hostname === "localhost" ||
    hostname.endsWith(".localhost") || parseIPv4Address(hostname) !== null ||
    hostname.startsWith("[") || hostname.includes(":");
}

async function resolveHostAddresses(
  context: AppContext,
  hostname: string,
): Promise<string[]> {
  try {
    return await (context.resolveHostAddresses ?? defaultResolveHostAddresses)(
      hostname,
    );
  } catch {
    return [];
  }
}

async function defaultResolveHostAddresses(
  hostname: string,
): Promise<string[]> {
  const results = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}

function isUnsafeResolvedAddress(address: string): boolean {
  const ipv4 = parseIPv4Address(address);
  if (ipv4) return isUnsafeIPv4Address(ipv4);
  if (!address.includes(":")) return true;
  return isUnsafeIPv6Address(address);
}

function parseIPv4Address(
  hostname: string,
): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => part.trim() === "" ? NaN : Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isUnsafeIPv4Address(
  address: [number, number, number, number],
): boolean {
  const [a, b, c] = address;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function isUnsafeIPv6Address(address: string): boolean {
  const value = address.toLowerCase();
  const mappedIpv4 = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    const ipv4 = parseIPv4Address(mappedIpv4[1]);
    return !ipv4 || isUnsafeIPv4Address(ipv4);
  }
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") ||
    value.startsWith("fe9") || value.startsWith("fea") ||
    value.startsWith("feb") || value.startsWith("ff") ||
    value.startsWith("2001:db8:");
}

function interactionTemplateFromJrd(
  input: unknown,
): InteractionTemplate | null {
  const follow = findTemplateLink(input, "https://w3id.org/fep/3b86/Follow");
  if (follow) return { template: follow, param: "object" };
  const object = findTemplateLink(input, "https://w3id.org/fep/3b86/Object");
  if (object) return { template: object, param: "object" };
  const legacy = findTemplateLink(
    input,
    "http://ostatus.org/schema/1.0/subscribe",
  );
  if (legacy) return { template: legacy, param: "uri" };
  return null;
}

function findTemplateLink(input: unknown, rel: string): string | null {
  if (!isRecord(input) || !Array.isArray(input.links)) return null;
  for (const link of input.links) {
    if (!isRecord(link)) continue;
    if (link.rel === rel && typeof link.template === "string") {
      return link.template;
    }
  }
  return null;
}

function interactionUrlFromTemplate(
  input: InteractionTemplate,
  actorUrl: string,
): URL | null {
  const placeholder = `{${input.param}}`;
  if (!input.template.includes(placeholder)) return null;
  try {
    const url = new URL(
      input.template.replaceAll(placeholder, encodeURIComponent(actorUrl)),
    );
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  profile?: AppProfile,
): string {
  const anchorId = postAnchorId(post);
  const icon = profile?.iconUrl
    ? `<img class="size-9 object-contain" src="${
      escapeAttribute(profile.iconUrl)
    }" alt="">`
    : "";
  return `
    <article id="${escapeAttribute(anchorId)}" class="relative py-7 px-8 mb-5 border border-solid border-line rounded-[14px] bg-surface scroll-mt-6 target:border-action phone:py-6 phone:px-5">
      <a class="absolute end-4 top-4 grid place-items-center size-8 no-underline text-muted" href="#${
    escapeAttribute(anchorId)
  }" aria-label="Link to this post">#</a>
      <div class="flex items-center gap-3 pe-8 text-[13px] text-muted">
        ${icon}
        <time datetime="${escapeAttribute(post.publishedAt)}">${
    formatDate(post.publishedAt)
  }</time>
      </div>
      <div class="release-content">${post.contentHtml}</div>
    </article>
  `;
}

function postAnchorId(post: PostRecord): string {
  return post.kind === "new-app"
    ? `post-${post.appId}-${post.releaseFingerprint}`
    : `release-${post.releaseFingerprint}`;
}

function pageShell(input: { title: string; body: string }): string {
  const containerClasses = "w-[min(1160px,calc(100%-64px))] mx-auto mobile:w-[calc(100%-40px)]";
  const navLinkClasses = "text-muted no-underline text-[14px] font-semibold py-3 hover:text-action phone:text-[13px]";
  const brandMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="currentColor" color="#1764c0" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="4"/><circle cx="26" cy="9" r="7"/><path d="M2 27a7 7 0 0 1 14 0v7H2z"/><rect x="19" y="20" width="14" height="14" rx="4"/></svg>`;
  return `<html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(input.title)}</title>
      <link rel="preload" href="/fonts/bricolage-grotesque-latin-v9.woff2" as="font" type="font/woff2" crossorigin>
      <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(brandMark)}">
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body>
      <a class="absolute -top-20 start-5 px-5 py-3 bg-surface z-5 focus:top-3" href="#main">Skip to content</a>
      <header class="${containerClasses} flex justify-between items-center gap-6 min-h-[100px] border-b border-solid border-line mobile:min-h-[84px]">
        <a class="flex items-center gap-3 text-ink no-underline font-display font-bold text-[20px] leading-[1.2] phone:text-[17px] phone:gap-2 [&>svg]:size-9 [&>svg]:shrink-0 [&>svg]:text-action phone:[&>svg]:size-[30px]" href="/" aria-label="Flathub App Updates home">
          ${brandMark}
          <span>Flathub<small class="block mt-[3px] font-body font-normal text-[12px] leading-[1.3] text-muted">App Updates</small></span>
        </a>
        <nav class="flex gap-7 items-center mobile:gap-[18px] phone:gap-3.5" aria-label="Main navigation">
          <a class="${navLinkClasses}" href="/#recent-apps">Apps</a><a class="${navLinkClasses}" href="/#feed-actors">Feeds</a><a class="${navLinkClasses} mobile:hidden" href="/#how-to-follow">How to follow</a>
        </nav>
      </header>
      <main class="${containerClasses} pb-16" id="main" tabindex="-1">${input.body}</main>
      <footer class="${containerClasses} flex justify-between gap-6 pt-[26px] pb-10 border-t border-solid border-line text-muted text-[12px] mobile:flex-col mobile:gap-4">
        <p class="m-0">App updates for the Fediverse. An unofficial Flathub mirror.</p>
        <nav class="flex gap-6" aria-label="Footer"><a class="text-muted" href="https://flathub.org" rel="noreferrer">Visit Flathub</a><a class="text-muted" href="/status">Status</a><a class="text-muted" href="/sitemap.xml">Sitemap</a></nav>
      </footer>
      <script type="module" src="/ui.js"></script>
    </body>
  </html>`;
}

function actorPath(appId: string): string {
  return `/apps/${encodeURIComponent(appId)}`;
}

function fediverseHandle(context: AppContext, appId: string): string {
  return `@${appId}@${new URL(context.config.origin).host}`;
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

function escapeXml(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
