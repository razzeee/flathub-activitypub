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
import { createRepositories, type Repositories } from "./store/kv_store.ts";
import type { AppProfile, PostKind, PostRecord } from "./store/types.ts";
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
  const apps = await context.repos.apps.listRecent(50);
  return html(renderLandingPage(context, apps));
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
    crawlScheduler: context.config.crawlIntervalSeconds > 0
      ? context.config.crawlScheduler
      : "disabled",
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

function renderLandingPage(
  context: AppContext,
  apps: AppProfile[],
): string {
  const host = new URL(context.config.origin).host;
  const collectionCards = COLLECTION_ACTORS.map((actor) =>
    collectionCard(actor)
  )
    .join("");
  const appCards = apps.length === 0
    ? `<p class="empty">No apps are available yet. Check back after this server syncs with Flathub</p>`
    : apps.map((app) => appCard(app)).join("");

  return pageShell({
    title: "Flathub App Updates",
    body: `
      <div class="landing-page">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Release relay for the Fediverse</p>
          <h1>Flathub apps can post now</h1>
          <p class="lede">A tiny ActivityPub dispatch desk that turns app releases into followable posts.</p>
          <div class="route-strip" aria-label="Release delivery path">
            <span>Flathub</span>
            <span>@app@${escapeHtml(host)}</span>
            <span>Your timeline</span>
          </div>
          <div class="hero-actions">
            <a href="#recent-apps">Choose an app</a>
            <a class="secondary" href="https://flathub.org" rel="noreferrer">Visit Flathub</a>
          </div>
        </div>
        <aside class="timeline-preview" aria-label="Example Mastodon release post">
          <div class="manifest-top">
            <span>Dispatch manifest</span>
            <strong>ActivityPub</strong>
          </div>
          <div class="route-map" aria-hidden="true">
            <span>Flathub</span>
            <i></i>
            <span>Actor</span>
            <i></i>
            <span>Timeline</span>
          </div>
          <div class="preview-header">
            <span>Addressed as</span>
            <code>@org.gnome.Builder@${escapeHtml(host)}</code>
          </div>
          <article class="status-post">
            <div class="post-avatar">F</div>
            <div>
              <p class="post-meta"><strong>Builder</strong><span>@org.gnome.Builder@${
      escapeHtml(host)
    }</span></p>
              <p class="post-copy">Version 47.2 is out with faster project indexing and improved terminal handling</p>
              <a href="#recent-apps">Follow release notes</a>
            </div>
          </article>
          <div class="preview-footer">
            <span>source: flathub</span>
            <span>destination: fediverse</span>
          </div>
        </aside>
      </section>

      <section class="panel instructions" aria-labelledby="how-to-follow">
        <p class="eyebrow">Three-stop route</p>
        <h2 id="how-to-follow">Follow an app</h2>
        <ol>
          <li>Choose an app or update feed from the manifest</li>
          <li>Search its handle from Mastodon or another Fediverse server</li>
          <li>Follow once; future release notes arrive as posts</li>
        </ol>
      </section>

      <section class="feed-grid" aria-labelledby="feed-actors">
        <div class="section-heading">
          <h2 id="feed-actors">Update feeds</h2>
        </div>
        ${collectionCards}
      </section>

      <section class="app-grid" aria-labelledby="recent-apps">
        <div class="section-heading">
          <h2 id="recent-apps">Apps you can follow</h2>
          <p>${apps.length} apps ready to follow</p>
        </div>
        ${appCards}
      </section>

      <footer class="site-footer">
        <a href="/status">Status</a>
        <a href="/sitemap.xml">Sitemap</a>
      </footer>
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
    ? `<p class="empty">No updates for this app yet</p>`
    : posts.map((post) => releaseSection(post)).join("");

  return pageShell({
    title: `${profile.name} - Flathub App Updates`,
    body: `
      <div class="app-page">
      <nav class="crumb"><a href="/">App directory</a></nav>
      <section class="app-hero panel">
        ${
      profile.iconUrl
        ? `<img class="app-icon" src="${
          escapeAttribute(profile.iconUrl)
        }" alt="">`
        : ""
    }
        <div>
          <p class="eyebrow">App updates</p>
          <h1>${escapeHtml(profile.name)}</h1>
          <p class="lede">${
      escapeHtml(profile.summary ?? "Flathub release updates")
    }</p>
          <dl class="facts">
            <div><dt>Last update found</dt><dd>${
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
          <span>Mastodon handle</span>
          <code>${escapeHtml(handle)}</code>
          <p>Search this in Mastodon to follow future updates</p>
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
          <h2 id="release-notes">Updates</h2>
          <p>${posts.length} ${
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
    ? `<p class="empty">No updates in this feed yet</p>`
    : posts.map((post) => releaseSection(post, profilesByAppId.get(post.appId)))
      .join("");

  return pageShell({
    title: `${collection.name} - Flathub App Updates`,
    body: `
      <div class="app-page">
      <nav class="crumb"><a href="/">App directory</a></nav>
      <section class="app-hero panel">
        ${feedIcon(collection, "large")}
        <div>
          <p class="eyebrow">Update feed</p>
          <h1>${escapeHtml(collection.name)}</h1>
          <p class="lede">${escapeHtml(collection.summary)}</p>
        </div>
        <aside class="actor-card" aria-label="Follow this feed">
          <span>Mastodon handle</span>
          <code>${escapeHtml(handle)}</code>
          <p>Search this in Mastodon to follow this feed</p>
          <form class="follow-form" method="get" action="${
      actorPath(collection.id)
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

      <section class="release-list" aria-labelledby="announced-posts">
        <div class="section-heading">
          <h2 id="announced-posts">Updates</h2>
          <p>${posts.length} ${
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
    ? `<p class="empty">This feed has not loaded any apps yet</p>`
    : apps.map((app) => appCard(app)).join("");

  return pageShell({
    title: `${collection.name} - Flathub App Updates`,
    body: `
      <div class="app-page">
      <nav class="crumb"><a href="/">App directory</a></nav>
      <section class="app-hero panel">
        ${feedIcon(collection, "large")}
        <div>
          <p class="eyebrow">Update feed</p>
          <h1>${escapeHtml(collection.name)}</h1>
          <p class="lede">${escapeHtml(collection.summary)}</p>
        </div>
        <aside class="actor-card" aria-label="Follow this feed">
          <span>Mastodon handle</span>
          <code>${escapeHtml(handle)}</code>
          <p>Search this in Mastodon to follow this feed</p>
          <form class="follow-form" method="get" action="${
      actorPath(collection.id)
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

      <section class="app-grid" aria-labelledby="feed-apps">
        <div class="section-heading">
          <h2 id="feed-apps">Apps in this feed</h2>
          <p>${apps.length} apps in this feed right now</p>
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
      <div class="app-page">
      <nav class="crumb"><a href="/">App directory</a></nav>
      <section class="hero compact">
        <p class="eyebrow">Node status</p>
        <h1>Ingestion and federation state</h1>
        <p class="lede">Read-only operational snapshot for ${
      escapeHtml(new URL(context.config.origin).host)
    }</p>
      </section>

      <section class="status-grid" aria-label="Status metrics">
        ${metricCard("Indexed apps", status.appCount)}
        ${metricCard("Total posts", status.postCount)}
        ${metricCard("Release posts", status.releasePostCount)}
        ${metricCard("New-app posts", status.newAppPostCount)}
        ${metricCard("Followers", status.followerCount)}
      </section>

      <section class="panel status-panel" aria-labelledby="crawl-state">
        <h2 id="crawl-state">Crawler state</h2>
        <dl class="facts">
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

      <section class="panel status-panel" aria-labelledby="recent-posts">
        <div class="section-heading">
          <h2 id="recent-posts">Recent posts</h2>
          <p>Latest indexed ActivityPub notes across apps</p>
        </div>
        <div class="table-wrap">
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

function appCard(app: AppProfile): string {
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
        <p>${escapeHtml(app.summary ?? "Flathub release updates")}</p>
        <span class="card-cta">View updates</span>
      </div>
    </a>
  `;
}

function collectionCard(actor: CollectionActorProfile): string {
  return `
    <a class="feed-card feed-card-${escapeAttribute(actor.id)}" href="${
    actorPath(actor.id)
  }">
      <div class="feed-card-top">
        ${feedIcon(actor, "small")}
        <h3>${escapeHtml(actor.name)}</h3>
      </div>
      <div>
        <p>${escapeHtml(actor.summary)}</p>
        <span class="card-cta">Open feed</span>
      </div>
    </a>
  `;
}

function feedIcon(
  actor: CollectionActorProfile,
  size: "large" | "small",
): string {
  const sizeClass = size === "small" ? " small" : "";
  return `<div class="feed-mark${sizeClass} feed-mark-${
    escapeAttribute(actor.id)
  }" aria-hidden="true">${feedIconSvg(actor.id)}</div>`;
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
    <div class="metric panel">
      <span>${escapeHtml(label)}</span>
      <strong>${value.toLocaleString("en")}</strong>
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

function handleRemoteFollow(
  context: AppContext,
  actor: { id: string; name: string },
  url: URL,
): Response {
  const server = normalizeFollowServer(url.searchParams.get("server") ?? "");
  if (!server) {
    return html(
      pageShell({
        title: "Invalid follow server - Flathub ActivityPub",
        body:
          `<section class="panel error-page"><h1>Invalid follow server</h1><p>Enter a Mastodon or Fediverse server host, for example <code>mastodon.social</code></p><p><a href="${
            actorPath(actor.id)
          }">Back to ${escapeHtml(actor.name)}</a></p></section>`,
      }),
      400,
    );
  }

  const followUrl = new URL("/authorize_interaction", server);
  followUrl.searchParams.set("uri", acctUri(context, actor.id));
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
  profile?: AppProfile,
): string {
  const anchorId = postAnchorId(post);
  const icon = profile?.iconUrl
    ? `<img class="release-icon" src="${
      escapeAttribute(profile.iconUrl)
    }" alt="">`
    : "";
  return `
    <article id="${escapeAttribute(anchorId)}" class="release panel">
      <a class="release-anchor" href="#${
    escapeAttribute(anchorId)
  }" aria-label="Link to this post">#</a>
      <div class="release-head">
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
  return `<html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(input.title)}</title>
      <style>
        :root {
          color-scheme: light;
          --paper: #e8f2ed;
          --paper-deep: #d7ebe7;
          --ink: #102430;
          --muted: #556d73;
          --line: #9fc8c2;
          --rail: #35bf8d;
          --flathub: #1c71d8;
          --violet: #6552d0;
          --parcel: #d69a2d;
          --route: #09222d;
          --card: #fbfffd;
          --shadow: rgba(12, 48, 61, .16);
        }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body {
          margin: 0;
          color: var(--ink);
          background:
            radial-gradient(circle at 18% 8%, rgba(53, 191, 141, .28), transparent 27rem),
            radial-gradient(circle at 84% 0%, rgba(28, 113, 216, .18), transparent 26rem),
            linear-gradient(135deg, rgba(214, 154, 45, .13) 0 14%, transparent 14% 100%),
            linear-gradient(90deg, rgba(16, 36, 48, .052) 1px, transparent 1px),
            linear-gradient(rgba(16, 36, 48, .052) 1px, transparent 1px),
            var(--paper);
          background-size: auto, auto, auto, 32px 32px, 32px 32px;
          font-family: "Atkinson Hyperlegible", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          line-height: 1.5;
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0 auto 0 0;
          width: 14px;
          background: repeating-linear-gradient(180deg, var(--flathub) 0 18px, var(--rail) 18px 36px, var(--parcel) 36px 54px, var(--violet) 54px 72px);
          box-shadow: 8px 0 30px rgba(28, 113, 216, .14);
          pointer-events: none;
          z-index: 3;
        }
        a { color: var(--flathub); text-decoration-thickness: .09em; text-underline-offset: .2em; }
        a:hover { color: #0f5fb7; }
        a:focus-visible { outline: 3px solid var(--parcel); outline-offset: 4px; }
        code {
          display: inline-block;
          max-width: 100%;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .84em;
          line-height: 1.35;
          background: #e3f7ef;
          border: 1px solid #9bdec9;
          border-radius: 999px;
          color: #0b5c48;
          padding: .24rem .56rem;
          overflow-wrap: anywhere;
        }
        main { width: min(1220px, calc(100% - 44px)); margin: 0 auto; padding: 48px 0 76px; }
        .landing-page, .app-page { width: 100%; }
        .app-page { max-width: 1080px; margin: 0 auto; }
        h1, h2, h3 { line-height: 1.03; margin: 0; }
        h1 {
          max-width: 760px;
          font-family: "Aptos Display", "Arial Narrow", "Helvetica Neue", sans-serif;
          font-size: clamp(4rem, 9vw, 8.8rem);
          font-stretch: condensed;
          font-weight: 950;
          letter-spacing: -.08em;
          line-height: .88;
          text-transform: uppercase;
        }
        h2 { font-size: clamp(1.55rem, 3vw, 2.55rem); letter-spacing: -.045em; font-weight: 850; }
        h3 { font-size: 1.12rem; letter-spacing: -.025em; }
        .hero {
          position: relative;
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(320px, 430px);
          gap: clamp(28px, 5vw, 68px);
          align-items: end;
          padding: 76px 0 52px;
        }
        .hero.compact { display: block; padding: 40px 0 30px; }
        .hero-copy { position: relative; z-index: 1; }
        .eyebrow {
          margin: 0 0 18px;
          color: #0b6b52;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .76rem;
          font-weight: 800;
          letter-spacing: .18em;
          text-transform: uppercase;
        }
        .lede { color: var(--muted); font-size: clamp(1.08rem, 2vw, 1.4rem); max-width: 680px; margin: 22px 0 0; }
        .timeline-preview {
          position: relative;
          display: grid;
          gap: 16px;
          align-self: end;
          padding: 18px;
          overflow: hidden;
          background:
            linear-gradient(90deg, rgba(28, 113, 216, .07) 0 1px, transparent 1px) 0 0 / 18px 100%,
            rgba(251, 255, 253, .92);
          border: 1px solid var(--line);
          border-radius: 28px 28px 10px 28px;
          box-shadow: 0 28px 80px var(--shadow);
        }
        .timeline-preview::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 8px;
          background: linear-gradient(90deg, var(--rail), var(--flathub), var(--parcel));
        }
        .preview-header, .preview-footer {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          justify-content: space-between;
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .74rem;
          font-weight: 800;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .preview-header code {
          max-width: 100%;
          letter-spacing: 0;
          text-transform: none;
        }
        .status-post {
          display: grid;
          grid-template-columns: 52px minmax(0, 1fr);
          gap: 14px;
          padding: 18px;
          background: white;
          border: 1px solid rgba(159, 200, 194, .8);
          border-radius: 22px 22px 8px 22px;
          box-shadow: 0 16px 42px rgba(12, 48, 61, .11);
        }
        .post-avatar {
          display: grid;
          place-items: center;
          width: 52px;
          height: 52px;
          border-radius: 16px 16px 6px 16px;
          background:
            radial-gradient(circle at 28% 24%, rgba(255, 255, 255, .7), transparent 22%),
            conic-gradient(from 210deg, var(--flathub), var(--rail), var(--violet), var(--flathub));
          color: white;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-weight: 900;
        }
        .post-meta { display: grid; gap: 2px; margin: 0; }
        .post-meta strong { color: var(--ink); font-size: 1.08rem; }
        .post-meta span {
          display: block;
          max-width: 100%;
          overflow: hidden;
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .78rem;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .post-copy { color: var(--ink); font-size: 1.04rem; margin: 14px 0 16px; }
        .status-post a { font-weight: 800; }
        .hero-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 24px; }
        .hero .hero-actions code {
          background: rgba(251, 255, 253, .84);
          border-color: rgba(28, 113, 216, .2);
          color: var(--muted);
          padding: .46rem .72rem;
        }
        .hero-actions a {
          display: inline-flex;
          min-height: 42px;
          align-items: center;
          border: 1px solid var(--flathub);
          border-radius: 999px;
          padding: .52rem .92rem;
          background: var(--flathub);
          color: white;
          font-size: .94rem;
          text-decoration: none;
          font-weight: 800;
          box-shadow: 0 12px 30px rgba(28, 113, 216, .18);
        }
        .hero-actions a.secondary { background: rgba(251, 255, 253, .64); color: var(--flathub); box-shadow: none; }
        button {
          border: 1px solid var(--flathub);
          border-radius: 999px;
          background: var(--flathub);
          color: white;
          cursor: pointer;
          font: inherit;
          font-weight: 800;
          padding: .58rem .82rem;
        }
        input {
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 999px;
          background: white;
          color: var(--ink);
          font: inherit;
          padding: .58rem .72rem;
        }
        input:focus-visible, button:focus-visible { outline: 3px solid var(--parcel); outline-offset: 4px; }
        .panel {
          background: rgba(251, 255, 253, .9);
          border: 1px solid var(--line);
          border-radius: 24px 24px 10px 24px;
          box-shadow: 0 24px 70px var(--shadow);
        }
        .instructions {
          padding: clamp(20px, 3vw, 28px);
          margin: 18px 0 44px;
          border-left: 10px solid var(--rail);
        }
        .instructions ol {
          counter-reset: follow-step;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin: 18px 0 0;
          padding: 0;
          list-style: none;
        }
        .instructions li {
          counter-increment: follow-step;
          position: relative;
          min-height: 104px;
          padding: 44px 14px 14px;
          border: 1px dashed rgba(28, 113, 216, .28);
          border-radius: 18px 18px 6px 18px;
          background: rgba(232, 242, 237, .64);
          color: var(--ink);
        }
        .instructions li::before {
          content: counter(follow-step);
          position: absolute;
          top: 12px;
          left: 14px;
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--route);
          color: white;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: .78rem;
          font-weight: 800;
        }
        .section-heading {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          align-items: end;
          margin: 0 0 18px;
        }
        .section-heading p { color: var(--muted); margin: 0; max-width: 400px; }
        .feed-grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          margin-top: 34px;
        }
        .feed-grid .section-heading { grid-column: 1 / -1; margin-bottom: 2px; }
        .feed-card {
          position: relative;
          display: grid;
          align-content: start;
          gap: 14px;
          min-height: 158px;
          padding: 18px;
          color: inherit;
          text-decoration: none;
          background: rgba(251, 255, 253, .94);
          border: 1px solid var(--line);
          border-radius: 22px 22px 8px 22px;
          box-shadow: 0 18px 48px rgba(12, 48, 61, .12);
          transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
        }
        .feed-card::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 6px;
          border-radius: inherit;
          border-bottom-left-radius: 0;
          border-bottom-right-radius: 0;
          background: linear-gradient(90deg, var(--rail), var(--flathub), var(--parcel));
        }
        .feed-card-top { display: flex; gap: 12px; align-items: center; }
        .feed-card h3 { font-size: 1.14rem; }
        .feed-card p { color: var(--muted); margin: 0; max-width: 13rem; }
        .feed-card .card-cta { margin-top: 6px; }
        .feed-card:hover { transform: translateY(-3px); border-color: #68b8d8; box-shadow: 0 30px 74px rgba(12, 48, 61, .18); }
        .feed-card:hover h3 { color: var(--flathub); text-decoration: underline; text-decoration-thickness: .08em; text-underline-offset: .18em; }
        .app-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-top: 34px; }
        .app-grid .section-heading { grid-column: 1 / -1; }
        .app-card {
          position: relative;
          display: flex;
          gap: 16px;
          min-height: 168px;
          padding: 18px;
          overflow: hidden;
          color: inherit;
          text-decoration: none;
          background:
            linear-gradient(90deg, rgba(28, 113, 216, .055) 0 1px, transparent 1px) 0 0 / 16px 100%,
            rgba(251, 255, 253, .93);
          border: 1px solid var(--line);
          border-radius: 22px 22px 8px 22px;
          box-shadow: 0 20px 54px var(--shadow);
          transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
        }
        .app-card::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 6px;
          background: linear-gradient(90deg, var(--rail), var(--flathub), var(--parcel));
        }
        .app-card > div { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; padding-right: 34px; }
        .app-card p { color: var(--muted); margin: 8px 0 12px; }
        .card-cta {
          margin-top: auto;
          color: var(--flathub);
          font-size: .9rem;
          font-weight: 800;
        }
        .app-card:hover { transform: translateY(-3px); border-color: #68b8d8; box-shadow: 0 30px 74px rgba(12, 48, 61, .2); }
        .app-card:hover h3 { color: var(--flathub); text-decoration: underline; text-decoration-thickness: .08em; text-underline-offset: .18em; }
        .app-icon {
          width: 96px;
          height: 96px;
          padding: 6px;
          object-fit: contain;
          background: rgba(255, 255, 255, .78);
          border: 1px solid rgba(16, 36, 48, .08);
          border-radius: 24px 24px 8px 24px;
          flex: 0 0 auto;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .55);
        }
        .app-icon.small { width: 56px; height: 56px; padding: 4px; border-radius: 16px 16px 6px 16px; }
        .feed-mark {
          display: grid;
          place-items: center;
          width: 96px;
          height: 96px;
          border-radius: 24px 24px 8px 24px;
          flex: 0 0 auto;
          background:
            radial-gradient(circle at 20% 20%, rgba(255, 255, 255, .42), transparent 20%),
            linear-gradient(135deg, var(--flathub), var(--rail));
          color: white;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35);
        }
        .feed-mark.small { width: 56px; height: 56px; border-radius: 16px 16px 6px 16px; font-size: .9rem; }
        .feed-card .feed-mark.small { width: 46px; height: 46px; border-radius: 14px 14px 5px 14px; }
        .feed-mark-recent-releases { background: linear-gradient(135deg, #1c71d8, #35bf8d); }
        .feed-mark-new-apps { background: linear-gradient(135deg, #24a575, #64c85d); }
        .feed-mark-trending-apps { background: linear-gradient(135deg, #d69a2d, #dc5f35); }
        .feed-mark-popular-apps { background: linear-gradient(135deg, #6552d0, #1c71d8); }
        .feed-mark svg {
          width: 52px;
          height: 52px;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 3.4;
        }
        .feed-mark .icon-fill { fill: rgba(255, 255, 255, .2); }
        .feed-mark.small svg { width: 31px; height: 31px; stroke-width: 3.8; }
        .feed-card .feed-mark.small svg { width: 27px; height: 27px; }
        .crumb { margin-bottom: 20px; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .9rem; }
        .app-hero { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(250px, 330px); gap: 24px; padding: 30px; align-items: flex-start; }
        .app-hero h1 {
          max-width: 720px;
          font-size: clamp(2.1rem, 4.8vw, 4rem);
          letter-spacing: -.055em;
          line-height: 1;
          text-transform: none;
          overflow-wrap: anywhere;
        }
        .app-hero .lede { max-width: 620px; margin-top: 14px; }
        .actor-card code {
          display: block;
          width: 100%;
          border-radius: 12px;
          font-size: .78rem;
          overflow-wrap: anywhere;
          white-space: normal;
        }
        .actor-card {
          align-self: start;
          display: grid;
          align-content: start;
          gap: 12px;
          padding: 20px;
          border-radius: 20px 20px 8px 20px;
          background:
            linear-gradient(180deg, rgba(28, 113, 216, .08), rgba(53, 191, 141, .12)),
            rgba(251, 255, 253, .78);
          border: 1px solid var(--line);
        }
        .actor-card span {
          color: #0b6b52;
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
        .release { position: relative; padding: 28px 30px; margin: 0 0 18px; border-left: 10px solid var(--rail); }
        .release-anchor { position: absolute; top: 22px; right: 22px; text-decoration: none; color: var(--muted); }
        .release-head { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
        .release-icon {
          width: 42px;
          height: 42px;
          padding: 4px;
          object-fit: contain;
          background: rgba(255, 255, 255, .84);
          border: 1px solid rgba(16, 36, 48, .08);
          border-radius: 13px 13px 5px 13px;
        }
        .release time { color: #0b6b52; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .88rem; }
        .release-content { max-width: 860px; font-size: 1.02rem; }
        .release-content > p:first-child { font-size: 1.08rem; }
        .release-content h1, .release-content h2, .release-content h3, .release-content p { max-width: 760px; }
        .release-content section { margin-top: 12px; }
        .release-content li { margin: .26rem 0; }
        .release-content ul { padding-left: 1.25rem; }
        .status-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin: 0 0 24px; }
        .metric { padding: 20px; }
        .metric span { color: var(--muted); display: block; font-size: .78rem; text-transform: uppercase; letter-spacing: .12em; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
        .metric strong { display: block; margin-top: 8px; font-size: clamp(1.8rem, 4vw, 3rem); line-height: 1; }
        .status-panel { padding: 24px; margin: 0 0 18px; }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; min-width: 680px; }
        th, td { border-bottom: 1px solid var(--line); padding: 12px 10px; text-align: left; vertical-align: top; }
        th { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .76rem; letter-spacing: .12em; text-transform: uppercase; }
        .site-footer { display: flex; justify-content: flex-end; gap: 16px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .88rem; }
        .empty { color: var(--muted); padding: 20px; border: 1px dashed var(--line); border-radius: 18px 18px 6px 18px; background: rgba(251, 255, 253, .72); }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
        }
        @media (max-width: 900px) {
          .hero { grid-template-columns: 1fr; align-items: start; }
        }
        @media (max-width: 720px) {
          body::before { width: 7px; }
          main { width: min(100% - 24px, 1120px); padding-top: 28px; }
          h1 { font-size: clamp(3.1rem, 17vw, 5.2rem); }
          .hero { padding-top: 36px; }
          .status-post { grid-template-columns: 44px minmax(0, 1fr); padding: 14px; }
          .post-avatar { width: 44px; height: 44px; }
          .instructions ol { grid-template-columns: 1fr; }
          .section-heading, .app-hero { display: block; }
          .section-heading p { margin-top: 8px; }
          .app-icon, .feed-mark { margin-bottom: 16px; }
          .app-card { align-items: flex-start; }
          .actor-card { margin-top: 18px; }
          .follow-form div { grid-template-columns: 1fr; }
        }
        :root {
          --paper: #eef5ed;
          --paper-deep: #dbeae2;
          --card: #fffdf6;
          --ink: #10202a;
          --muted: #5a6e73;
          --line: #8fb6ae;
          --route: #126fc9;
          --relay: #19a77d;
          --stamp: #6847c7;
          --priority: #d47a23;
          --shadow: rgba(16, 32, 42, .14);
          --display-font: "Bahnschrift", "DIN Condensed", "Aptos Display", "Arial Narrow", system-ui, sans-serif;
          --body-font: "Atkinson Hyperlegible", "Noto Sans", "Segoe UI", system-ui, sans-serif;
          --utility-font: "IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        body {
          background:
            radial-gradient(circle at 15% 10%, rgba(25, 167, 125, .24), transparent 24rem),
            radial-gradient(circle at 88% 6%, rgba(18, 111, 201, .17), transparent 30rem),
            linear-gradient(132deg, rgba(212, 122, 35, .14) 0 19%, transparent 19.2% 100%),
            linear-gradient(90deg, rgba(16, 32, 42, .052) 1px, transparent 1px),
            linear-gradient(rgba(16, 32, 42, .052) 1px, transparent 1px),
            var(--paper);
          background-size: auto, auto, auto, 28px 28px, 28px 28px;
          font-family: var(--body-font);
        }
        body::before {
          width: 18px;
          background:
            repeating-linear-gradient(180deg, var(--route) 0 16px, var(--relay) 16px 32px, var(--priority) 32px 48px, var(--stamp) 48px 64px),
            var(--ink);
          box-shadow: 10px 0 0 rgba(255, 253, 246, .42), 20px 0 48px rgba(16, 32, 42, .12);
        }
        main {
          width: min(1240px, calc(100% - 48px));
          padding: 52px 0 80px;
        }
        a {
          color: var(--route);
          text-decoration-thickness: .08em;
          text-underline-offset: .22em;
        }
        a:hover { color: #0c579f; }
        a:focus-visible, button:focus-visible, input:focus-visible {
          outline: 3px solid var(--priority);
          outline-offset: 4px;
        }
        code {
          background: #eef8f2;
          border-color: #9bd2c0;
          border-radius: 10px;
          color: #0a5b45;
          font-family: var(--utility-font);
        }
        h1, h2, h3 { color: var(--ink); }
        h1 {
          font-family: var(--display-font);
          font-size: clamp(4rem, 8.8vw, 8.4rem);
          font-weight: 900;
          letter-spacing: -.082em;
          line-height: .84;
          max-width: 730px;
          text-transform: none;
          text-wrap: balance;
        }
        h2 {
          font-family: var(--display-font);
          font-size: clamp(1.9rem, 3.3vw, 3rem);
          font-weight: 850;
          letter-spacing: -.052em;
        }
        h3 { font-weight: 850; }
        .eyebrow,
        .preview-header,
        .preview-footer,
        .actor-card span,
        .follow-form label,
        .facts dt,
        .metric span,
        th,
        .crumb,
        .route-strip,
        .manifest-top,
        .route-map {
          font-family: var(--utility-font);
        }
        .eyebrow {
          color: #09664f;
          letter-spacing: .2em;
        }
        .hero {
          isolation: isolate;
          grid-template-columns: minmax(0, 1fr) minmax(340px, 430px);
          min-height: 560px;
          padding: 84px 0 58px;
        }
        .hero-copy::before {
          content: "";
          display: block;
          width: 84px;
          height: 12px;
          margin: 0 0 24px;
          background: repeating-linear-gradient(90deg, var(--route) 0 14px, var(--relay) 14px 28px, var(--priority) 28px 42px, var(--stamp) 42px 56px);
          border-radius: 999px;
        }
        .lede {
          color: var(--muted);
          font-size: clamp(1.12rem, 2vw, 1.45rem);
          max-width: 620px;
        }
        .route-strip {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 22px;
          color: var(--ink);
          font-size: .78rem;
          font-weight: 850;
          letter-spacing: .1em;
          text-transform: uppercase;
        }
        .route-strip span {
          position: relative;
          display: inline-flex;
          align-items: center;
          min-height: 30px;
          border: 1px solid rgba(143, 182, 174, .9);
          border-radius: 999px;
          background: rgba(255, 253, 246, .74);
          padding: .32rem .7rem;
        }
        .route-strip span:not(:last-child)::after {
          content: "";
          position: absolute;
          right: -10px;
          width: 12px;
          height: 2px;
          background: var(--route);
        }
        .hero-actions a,
        button {
          border-color: var(--ink);
          border-radius: 12px 12px 4px 12px;
          background: var(--ink);
          color: white;
          box-shadow: 6px 6px 0 rgba(18, 111, 201, .22);
        }
        .hero-actions a.secondary {
          background: rgba(255, 253, 246, .82);
          color: var(--ink);
          box-shadow: none;
        }
        input {
          border-radius: 12px 12px 4px 12px;
          background: rgba(255, 253, 246, .92);
        }
        .timeline-preview {
          align-self: center;
          gap: 14px;
          padding: 22px 22px 20px 30px;
          background:
            linear-gradient(90deg, rgba(18, 111, 201, .07) 0 1px, transparent 1px) 0 0 / 18px 100%,
            linear-gradient(180deg, rgba(255, 253, 246, .98), rgba(246, 252, 247, .94));
          border: 1px solid var(--ink);
          border-radius: 18px 18px 4px 18px;
          box-shadow: 12px 12px 0 rgba(16, 32, 42, .08), 0 28px 80px var(--shadow);
        }
        .timeline-preview::before {
          inset: 0 0 auto;
          height: 7px;
          background: linear-gradient(90deg, var(--relay), var(--route), var(--priority));
        }
        .timeline-preview::after {
          content: "";
          position: absolute;
          inset: 22px auto 22px -8px;
          width: 16px;
          background: radial-gradient(circle, var(--paper) 0 4px, transparent 4.6px) 0 0 / 16px 25px;
        }
        .manifest-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: var(--muted);
          font-size: .72rem;
          font-weight: 900;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        .manifest-top strong {
          border: 2px solid rgba(104, 71, 199, .52);
          border-radius: 999px;
          color: var(--stamp);
          padding: .16rem .42rem;
          transform: rotate(-4deg);
        }
        .route-map {
          display: grid;
          grid-template-columns: auto 1fr auto 1fr auto;
          gap: 8px;
          align-items: center;
          color: var(--ink);
          font-size: .68rem;
          font-weight: 900;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .route-map span {
          display: inline-grid;
          place-items: center;
          min-height: 28px;
          border: 1px solid rgba(143, 182, 174, .9);
          border-radius: 999px;
          background: rgba(238, 248, 242, .9);
          padding: .22rem .46rem;
        }
        .route-map i {
          display: block;
          height: 2px;
          background: repeating-linear-gradient(90deg, var(--route) 0 9px, transparent 9px 14px);
        }
        .preview-header,
        .preview-footer {
          color: var(--muted);
          font-size: .68rem;
          letter-spacing: .14em;
        }
        .preview-header code { border-radius: 8px; }
        .status-post {
          background: white;
          border-color: rgba(16, 32, 42, .22);
          border-radius: 16px 16px 4px 16px;
          box-shadow: none;
        }
        .post-avatar {
          border-radius: 14px 14px 4px 14px;
          background:
            radial-gradient(circle at 30% 25%, rgba(255, 255, 255, .74), transparent 24%),
            conic-gradient(from 220deg, var(--route), var(--relay), var(--stamp), var(--route));
        }
        .panel,
        .feed-card,
        .app-card,
        .actor-card,
        .release,
        .metric {
          background: rgba(255, 253, 246, .9);
          border: 1px solid rgba(16, 32, 42, .2);
          border-radius: 18px 18px 4px 18px;
          box-shadow: 8px 8px 0 rgba(16, 32, 42, .06);
        }
        .instructions {
          position: relative;
          padding: clamp(22px, 3vw, 30px);
          border-left: 0;
        }
        .instructions::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 7px;
          border-radius: inherit;
          border-bottom-left-radius: 0;
          border-bottom-right-radius: 0;
          background: linear-gradient(90deg, var(--relay), var(--route), var(--priority));
        }
        .instructions .eyebrow { margin-bottom: 8px; }
        .instructions li {
          background: rgba(238, 248, 242, .64);
          border-color: rgba(18, 111, 201, .28);
          border-radius: 14px 14px 4px 14px;
          min-height: 118px;
          padding-top: 48px;
        }
        .instructions li::before {
          background: var(--ink);
          border-radius: 8px 8px 3px 8px;
          font-family: var(--utility-font);
        }
        .section-heading { align-items: center; }
        .section-heading p { color: var(--muted); font-family: var(--utility-font); font-size: .8rem; }
        .feed-card,
        .app-card {
          min-height: 172px;
          background:
            linear-gradient(90deg, rgba(18, 111, 201, .055) 0 1px, transparent 1px) 0 0 / 18px 100%,
            rgba(255, 253, 246, .94);
        }
        .feed-card::before,
        .app-card::before {
          height: 7px;
          background: linear-gradient(90deg, var(--relay), var(--route) 56%, var(--priority));
        }
        .feed-card::after,
        .app-card::after {
          content: "";
          position: absolute;
          inset: 18px 12px 18px auto;
          width: 1px;
          background: repeating-linear-gradient(180deg, rgba(16, 32, 42, .18) 0 6px, transparent 6px 12px);
        }
        .feed-card:hover,
        .app-card:hover {
          border-color: var(--ink);
          box-shadow: 10px 10px 0 rgba(18, 111, 201, .16);
          transform: translate(-2px, -2px);
        }
        .feed-card p,
        .app-card p,
        .actor-card p { color: var(--muted); }
        .card-cta {
          color: var(--route);
          font-family: var(--utility-font);
          font-size: .75rem;
          letter-spacing: .02em;
        }
        .app-icon,
        .feed-mark,
        .release-icon {
          border-color: rgba(16, 32, 42, .18);
          border-radius: 14px 14px 4px 14px;
          background-color: rgba(255, 255, 255, .82);
        }
        .feed-mark-recent-releases { background: linear-gradient(135deg, var(--route), var(--relay)); }
        .feed-mark-new-apps { background: linear-gradient(135deg, #15956f, #62c85e); }
        .feed-mark-trending-apps { background: linear-gradient(135deg, var(--priority), #ce4f2e); }
        .feed-mark-popular-apps { background: linear-gradient(135deg, var(--stamp), var(--route)); }
        .crumb {
          font-weight: 800;
          letter-spacing: .04em;
        }
        .app-hero {
          position: relative;
          overflow: hidden;
          padding: clamp(24px, 4vw, 38px);
        }
        .app-hero::before {
          content: "";
          position: absolute;
          inset: 0 0 auto;
          height: 7px;
          background: linear-gradient(90deg, var(--relay), var(--route), var(--priority));
        }
        .app-hero::after {
          content: "FOLLOWABLE ACTOR";
          position: absolute;
          right: 30px;
          bottom: 24px;
          color: rgba(104, 71, 199, .14);
          font-family: var(--utility-font);
          font-size: clamp(1.6rem, 5vw, 4.4rem);
          font-weight: 900;
          letter-spacing: .12em;
          pointer-events: none;
          transform: rotate(-7deg);
          white-space: nowrap;
        }
        .app-hero > * { position: relative; z-index: 1; }
        .app-hero h1 {
          font-family: var(--display-font);
          font-weight: 850;
          letter-spacing: -.055em;
        }
        .actor-card {
          background:
            linear-gradient(180deg, rgba(104, 71, 199, .09), rgba(25, 167, 125, .11)),
            rgba(255, 253, 246, .84);
        }
        .actor-card code { border-radius: 10px; }
        .facts dd { font-weight: 700; }
        .release {
          border-left: 0;
          overflow: hidden;
          padding: 30px 32px;
        }
        .release::before {
          content: "";
          position: absolute;
          inset: 0 auto 0 0;
          width: 8px;
          background: linear-gradient(180deg, var(--relay), var(--route), var(--priority));
        }
        .release-anchor { font-family: var(--utility-font); font-weight: 900; }
        .release time {
          color: #09664f;
          font-family: var(--utility-font);
          font-weight: 800;
        }
        .release-content > p:first-child { font-size: 1.1rem; }
        .metric strong { font-family: var(--display-font); letter-spacing: -.04em; }
        .status-panel { overflow: hidden; }
        th, td { border-bottom-color: rgba(143, 182, 174, .72); }
        .site-footer {
          border-top-color: rgba(143, 182, 174, .75);
          font-family: var(--utility-font);
        }
        .empty {
          background: rgba(255, 253, 246, .72);
          border-color: rgba(143, 182, 174, .88);
          border-radius: 14px 14px 4px 14px;
        }
        @media (max-width: 900px) {
          .hero { grid-template-columns: 1fr; min-height: 0; align-items: start; }
        }
        @media (max-width: 720px) {
          body::before { width: 9px; }
          main { width: min(100% - 28px, 1120px); }
          h1 { font-size: clamp(3rem, 15vw, 4.7rem); letter-spacing: -.072em; }
          .hero { padding-top: 44px; gap: 28px; }
          .hero-copy::before { width: 68px; height: 10px; margin-bottom: 18px; }
          .route-strip { display: grid; align-items: start; }
          .route-strip span:not(:last-child)::after { display: none; }
          .timeline-preview { width: 100%; max-width: none; }
          .route-map { grid-template-columns: 1fr; }
          .route-map i { height: 16px; width: 2px; justify-self: center; }
          .timeline-preview { padding-left: 24px; }
          .app-card::after,
          .feed-card::after,
          .app-hero::after { display: none; }
          .app-card { min-height: 148px; }
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

function escapeXml(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
