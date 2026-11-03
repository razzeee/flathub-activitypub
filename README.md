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

## Migrating an existing Deno deployment

Do not point the production domain at a fresh database: that would generate new
signing keys and lose followers. Keep `ORIGIN`, actor URLs, post IDs, and stored
key pairs unchanged. Cutover and queue draining require a maintenance window.

1. Stop old ingestion and drain old federation queues. Pause writes while exporting.
2. In an environment with access to the **old Deno KV database**, export its
   entries as JSONL. For a local database or snapshot, set `DENO_KV_PATH` and run
   this one-time command with Deno; for hosted KV, export from the old environment:

   ```sh
   mkdir -p .data
   umask 077
   deno eval --unstable-kv '
   const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH"));
   try {
     for await (const {key, value} of kv.list({prefix: []})) {
       console.log(JSON.stringify({key, value}));
     }
   } finally { kv.close(); }
   ' > .data/deno-export.jsonl
   ```

3. Convert the export and import into a **fresh, migrated** D1 database:

   ```sh
   pnpm db:convert-deno .data/deno-export.jsonl .data/deno-import.sql
   pnpm exec wrangler d1 execute DB --local --file=.data/deno-import.sql
   # After validating locally, repeat against the fresh cutover database:
   pnpm exec wrangler d1 execute DB --remote --file=.data/deno-import.sql
   ```

   The converter preserves app/release/post records, followers, actor keys, crawl
   state, and feed ordering. It rebuilds SQL indexes and discards transient Fedify
   caches; it does **not** migrate in-flight queue tasks. Imports fail on duplicate
   rows instead of overwriting signing keys. The export and SQL contain private
   keys: keep them out of version control and protect them as credentials.
   An unfinished legacy bootstrap restarts from page one because its saved page
   has no page-size metadata; existing records prevent duplicate posts.

4. Verify record counts, signing keys, and IDs against the old database. Set the
   original `ORIGIN`, switch the domain to the Worker, and verify federation before
   resuming ingestion. Keep the old database backup for rollback; never run both
   writers against the same federation identity.
