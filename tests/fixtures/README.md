# Live federation validation peer

`validation_peer.ts` is a separate test Worker, not part of the application bundle.
It exposes a public actor and inbox, signs Follow/Undo requests, verifies incoming
HTTP signatures, and records delivery attempts in a SQLite-backed Durable Object.

Deploy it only with a disposable identity and these bindings:

- `PEER`: Durable Object namespace for the exported `ValidationPeer` class, with
  a `new_sqlite_classes` migration.
- `ORIGIN`: the peer's public HTTPS origin.
- `TARGET_ORIGIN`: an isolated deployment of this application's public origin.
- `VALIDATION_TOKEN`: a secret protecting the `/internal/*` control routes.

Enable `nodejs_compat` and `global_fetch_strictly_public` on both Workers. Do not
use the production origin, signing keys, followers, or database for this test.

Authenticated control routes:

- `POST /internal/status` with `{"status":503}`, `202`, or `410`: choose the inbox response.
- `POST /internal/follow` and `/internal/undo`: send signed activities targeting
  the application's `new-apps` actor; return its immediate HTTP response status.
- `POST /internal/wait` with `{"after":0,"status":202}`: wait for a matching
  recorded delivery, using event-driven notification rather than polling.
- `GET /internal/state`: read the last 30 delivery attempts.

Use `Authorization: Bearer <VALIDATION_TOKEN>` for these control requests. Set the
inbox to `503`, send a Follow, verify failed deliveries' signatures, then change
the response to `202` and wait for Cloudflare's native queue retry. The recovered
Accept must retain the same activity ID. After Undo, the application's follower
count must return to zero. Remove the disposable resources when finished with them.
