# Flathub ActivityPub Changelog Server

A Cloudflare Workers service that watches Flathub's recently-updated API and creates
ActivityPub posts for app releases with non-empty AppStream descriptions, plus
recently-added app announcements from Flathub's API after the initial baseline.

TypeScript and Fedify provide the HTTP and ActivityPub endpoints. D1 stores app
data, crawl checkpoints, followers, signing keys, and Fedify cache entries.
Cloudflare Queues handle ingestion and federation tasks; a Cron Trigger requests
a poll every five minutes. No Deno runtime or Workers KV namespace is required.

## Run Locally

Use Node.js 24 and pnpm (the version is pinned in `package.json`):

```sh
pnpm install
pnpm db:migrate:local
pnpm dev
```

Open `http://localhost:8787`. Local D1 and queues run in Wrangler/Miniflare;
Cloudflare credentials are not needed. To use the internal ingestion routes,
put `INTERNAL_API_TOKEN` in an ignored `.dev.vars` file. Crawls make real requests
to Flathub, even during local development. Local federation is not publicly reachable.

```sh
pnpm check
pnpm test
```

Tests use isolated local D1 databases and include a bundled Worker smoke test in
workerd. `pnpm build` bundles with Wrangler's dry-run mode and does not deploy.

Routes:

- `GET /healthz`
- `GET /readyz`
- `GET /status`
- `GET /sitemap.xml`
- `POST /internal/ingest/bootstrap`
- `POST /internal/ingest/poll`
- `GET /.well-known/webfinger?resource=acct:<actor_id>@<host>`
- `GET /apps/{appId}`
- `GET /apps/{appId}/followers`
- `GET /apps/{appId}/outbox`
- `GET /apps/{appId}/releases/{releaseFingerprint}`
- `GET /apps/{appId}/posts/new-app`

Built-in feed actors are exposed as pseudo-app actors:

- `@recent-releases@<host>` announces release posts sourced from
  `/collection/recently-updated`.
- `@new-apps@<host>` announces app posts sourced from
  `/collection/recently-added`; the first poll establishes a baseline and does
  not backfill historical additions.
- `@trending-apps@<host>` exposes a snapshot sourced from
  `/collection/trending`.
- `@popular-apps@<host>` exposes a snapshot sourced from `/collection/popular`.

## Crawlers

Run crawlers through the internal ingestion routes:

```sh
curl -X POST -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  "$ORIGIN/internal/ingest/bootstrap"
curl -X POST -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  "$ORIGIN/internal/ingest/poll"
```

- `bootstrap` walks Flathub's `recently-updated` collection and stores observed
  release fingerprints. It publishes the latest described release per app.
- `poll` runs the incremental crawlers: `recently-updated`, `recently-added`,
  `trending`, and `popular`.
- Both internal routes return `202` after enqueueing work, not after completing it.
- Each ingestion message fetches a page, processes one app, or advances a phase.
  The cursor (including the fetched page) is persisted in D1 between invocations.
  Watermarks advance only after all relevant pages have been processed.
  A run keeps its original page size even if configuration changes during a deploy.
- The ingestion consumer deliberately uses `max_concurrency: 1`; keep this setting
  to serialize checkpoint updates. Repeated scheduled polls resume an active run.
- AppStream `404`/`410` responses skip removed apps without blocking the saved
  crawl. Transient failures (including `429`/`5xx`) retain the cursor for retry.
- Federation delivery is at-least-once, with retries and a dead-letter queue.
  Activity IDs remain stable across retries. The stored `delivered` state means
  handed to the federation queue, not confirmed by every remote inbox.
- Inspect `/status`, Worker logs, D1's `state` table (`job:poll` / `job:bootstrap`),
  and queue backlog/dead-letter metrics for progress and failures. Retry a stalled
  bootstrap through its internal route after correcting the underlying failure.

Watermarks are the stored high-water marks that make poll crawlers incremental:

- `recently-updated` stores the highest Flathub `updated_at` seen. Polling uses
  `RECENTLY_UPDATED_OVERLAP_SECONDS` to re-scan a small overlap and avoid
  missing updates near the boundary.
- `recently-added` stores the highest Flathub `added_at` seen. The first poll
  only establishes this baseline; later polls publish apps with newer `added_at`
  values.
- `trending` and `popular` are snapshot crawlers, not watermark crawlers. Each
  poll replaces the stored snapshot with the latest Flathub collection page.

## Configuration

- `ORIGIN`: canonical public origin, default `http://localhost:8787`. Set the
  permanent HTTPS origin before a public deployment. Actor and post URLs depend on it.
- `FLATHUB_API_BASE`: default `https://flathub.org/api/v2`.
- `RECENTLY_UPDATED_PER_PAGE`: default `10`.
- `RECENTLY_UPDATED_OVERLAP_SECONDS`: default `3600`.
- `INGESTION_QUEUE_NAME` / `FEDERATION_QUEUE_NAME`: consumer queue names, default
  `flathub-ingestion` / `flathub-federation`. Override these alongside Wrangler's
  queue names for isolated staging deployments.
- Edit `triggers.crons` in `wrangler.jsonc` to change or disable scheduled polls.
- `INTERNAL_API_TOKEN`: bearer token required for `POST /internal/ingest/*`;
  when unset, internal ingestion routes return 404.

## Production releases

Pushes to `main` run type-checking and all tests, then wait for approval in the
GitHub **production** environment before applying D1 migrations and deploying the
exact tested commit. Pull requests never deploy or receive deployment credentials.
Production deployments are serialized without canceling an active migration;
superseded commits are rejected immediately before migration/deployment. A newer
push does not cancel an already-started release. Health and readiness checks run
after deployment; failure does not automatically roll back code or database.

### One-time production setup

Use Workers Paid: signing-key generation and Fedify processing can exceed the
Free plan's 10 ms CPU allowance.

1. Create a **new production** D1 database named `flathub-activitypub` and queues
   `flathub-dead-letter`, `flathub-federation`, and `flathub-ingestion` (dead-letter
   first). Keep production resources separate from test instances.
2. Select the permanent HTTPS origin. For a custom domain, its zone must be in
   the Cloudflare account and permit a Worker Custom Domain; deployment configures
   that domain automatically and disables `workers.dev`. Alternatively explicitly
   select `https://flathub-activitypub.<account-subdomain>.workers.dev`.
   The origin has no trailing slash. Changing it later changes federation identity.
3. In repository **Settings → Environments → production**, configure:

   | Kind     | Name                        | Value                                     |
   | -------- | --------------------------- | ----------------------------------------- |
   | Variable | `CLOUDFLARE_ACCOUNT_ID`     | Production account ID                     |
   | Variable | `PRODUCTION_D1_DATABASE_ID` | UUID returned when creating production D1 |
   | Variable | `PRODUCTION_ORIGIN`         | Permanent public HTTPS origin             |
   | Secret   | `CLOUDFLARE_API_TOKEN`      | Dedicated deployment API token            |

   Restrict the environment to the `main` **branch**, require `razzeee` approval,
   and disallow administrator bypass. Self-review is allowed so the repository
   owner can approve their own releases. These protections are repository settings,
   not enforced by the workflow file: preserve them when changing settings.

   Use a dedicated, account-scoped Cloudflare token with Workers Scripts, D1, and
   Queues permissions. Custom Domains also require the appropriate zone/Workers
   Routes permissions.

4. After a push to `main` passes CI, approve the pending production deployment
   in Actions. Missing/placeholder settings fail before remote changes.

The workflow generates ignored `.data/wrangler.production.json` from the checked-in
Wrangler configuration. Local development keeps its localhost origin and placeholder
database ID. The first production deploy enables the five-minute cron and starts
ingestion.

`INTERNAL_API_TOKEN` is optional and is **not** synchronized by CI. If manual
ingestion endpoints are needed, set it once with `wrangler secret put` for the
production Worker; otherwise those routes remain disabled. Subsequent deploys
preserve Worker secrets.

Schema migrations run before code is deployed: keep them backward compatible with
the currently running Worker. For a rollback, revert via a new `main` commit and
run CI/approval again; do not rerun an old workflow or assume D1 changes are undone.

## Deploy a test instance

Start with a **separate database, queues, and test origin**, not the existing
federation identity. Budget for Workers Paid: signing-key generation and Fedify
processing can exceed the Free plan's 10 ms CPU allowance.

The following commands create remote resources and deploy; they are manual setup
steps, not part of `pnpm install`, tests, or the dry-run build:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create flathub-activitypub
pnpm exec wrangler queues create flathub-federation
pnpm exec wrangler queues create flathub-ingestion
pnpm exec wrangler queues create flathub-dead-letter
```

Replace the placeholder `database_id` and localhost `ORIGIN` in `wrangler.jsonc`
with the returned database ID and your test Worker's public HTTPS origin. Set
`INGESTION_QUEUE_NAME` and `FEDERATION_QUEUE_NAME` if you rename the queues for a test instance.
Then:

```sh
pnpm db:migrate:remote
pnpm exec wrangler secret put INTERNAL_API_TOKEN
pnpm run deploy
```

Validate WebFinger, following from a real remote server, publishing, delivery
retries, and dead-letter handling before using the production identity. Do not
put federation routes behind a CAPTCHA or managed bot challenge. Back up D1,
especially `actor_keys`, and monitor dead-letter messages rather than assuming
queued activities were received.

Keep `global_fetch_strictly_public` enabled: federation must reach other public
Workers rather than Cloudflare's private-origin routing (which can return 1042).
