# Flathub ActivityPub Changelog Server

A Deno 2.x service that watches Flathub's recently-updated API and creates one
changelog post per app release with a non-empty AppStream release description.

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
- `POST /internal/ingest/bootstrap`
- `POST /internal/ingest/poll`
- `GET /.well-known/webfinger?resource=acct:<app_id>@<host>`
- `GET /apps/{appId}`
- `GET /apps/{appId}/followers`
- `GET /apps/{appId}/outbox`
- `GET /apps/{appId}/releases/{releaseFingerprint}`

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
