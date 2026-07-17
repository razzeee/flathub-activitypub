# Flathub ActivityPub Changelog Server

A Deno 2.x service that watches Flathub's recently-updated API and creates
ActivityPub posts for app releases with non-empty AppStream descriptions, plus
recently-added app announcements from Flathub's API after the initial baseline.

This first implementation provides the ingestion, persistence, operational HTTP
routes, and ActivityPub-shaped documents needed to run locally. Fedify can be
wired into the `federation` module boundary without changing ingestion or
storage.

## Run Locally

```sh
ORIGIN=http://localhost:8000 DENO_KV_PATH=.data/kv deno task dev
```

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
- The scheduled crawler calls `poll` every `CRAWL_INTERVAL_SECONDS`; set it to
  `0` to disable scheduling and trigger crawls manually.

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

- `ORIGIN`: canonical public origin, default `http://localhost:8000`.
- `PORT`: local HTTP port, default `8000`.
- `DENO_KV_PATH`: optional local Deno KV path.
- `FLATHUB_API_BASE`: default `https://flathub.org/api/v2`.
- `RECENTLY_UPDATED_PER_PAGE`: default `50`.
- `RECENTLY_UPDATED_OVERLAP_SECONDS`: default `3600`.
- `CRAWL_INTERVAL_SECONDS`: default `300`.
- `BOOTSTRAP_THROTTLE_MS`: default `1000`.
- `INTERNAL_API_TOKEN`: bearer token required for `POST /internal/ingest/*`;
  when unset, internal ingestion routes return 404.
