# Scrobbler

A Spotify scrobbler: it polls each connected account's **Recently Played** feed on a schedule and persists every track play as a durable event. Built as the first standalone component of a larger music-tracking service.

This repo is intentionally small and readable. It demonstrates an async polling service in TypeScript: OAuth, token refresh, rate-limit handling, idempotent ingestion, and a clean separation between the web tier and the background worker.

## What it does

- Connects a Spotify account via OAuth 2.0 (Authorization Code flow).
- Runs a **background worker** that polls `GET /v1/me/player/recently-played` for each account.
- Stores plays in Postgres, **idempotently** — Spotify's feed can repeat items across overlapping polls, and a unique constraint makes re-ingestion a no-op.
- Tracks plays **from the moment of connection forward only**. There is no historical backfill, by design.
- Refreshes access tokens automatically before they expire, and recovers from a mid-request 401.
- Honors Spotify's `429 Retry-After` header with exponential-backoff retries.

## Architecture

Two processes share one database:

```
                +------------------+
   Browser ---> |   API server     |  OAuth handshake → writes tokens to DB
                |  (src/api)       |
                +------------------+
                          |
                          v
                +------------------+
                |    Postgres      |  users, spotify_accounts, plays
                +------------------+
                          ^
                          |
                +------------------+
                |  Polling worker  |  reads accounts, fetches plays, writes plays
                |  (src/worker)    |
                +------------------+
```

Splitting the worker from the API is the central design decision: the web tier only needs to get tokens into the database, and ingestion runs independently. The worker is sequential and single-instance for now; the account-selection query (least-recently-polled first) is written so multiple workers could be added later without changing the contract.

### Module layout

| Path | Responsibility |
| --- | --- |
| `src/config` | Typed, validated environment loading (fails fast at startup). |
| `src/lib` | Logger; `sleep` and `withRetry` (backoff honoring server hints). |
| `src/db` | Connection pool, transaction helper, SQL migration runner. |
| `src/spotify` | API types, OAuth helpers, and the rate-limit-aware client. |
| `src/scrobbler` | Data-access layer, per-account ingestion, and ISRC enrichment. |
| `src/api` | Express server: OAuth routes, health check. |
| `src/worker` | The polling loop with graceful shutdown. |

### Data model

`plays` stores raw Spotify identifiers and metadata, plus the untouched item payload in a `raw` JSONB column. Canonical cross-service track resolution is deliberately *not* done here — keeping the raw log intact means it can be reprocessed later without re-fetching from Spotify. The `(account, track, played_at)` unique constraint is what makes ingestion idempotent.

A per-account cursor (`last_played_after_ms`) is passed as the `after` query parameter so each poll fetches only plays newer than what we already have.

## Known API constraints

- The Recently Played feed returns at most **50 items** per page and only covers recent history — another reason polling must be frequent enough not to miss plays between ticks.
- **ISRC is not on the recently-played payload** — it lives on the full Track object (`GET /v1/tracks/{id}`). After ingesting a batch, the worker backfills ISRCs by resolving each un-enriched track and writing the code onto its stored plays. ISRC is the primary cross-service identity key for the downstream matching layer. Enrichment is best-effort and isolated from ingestion: an unresolved track stays null and is retried on a later tick. (The batch tracks endpoint returns 403 for Development Mode apps after Spotify's early-2026 API migration, so enrichment uses single-track requests.)
- Spotify's feed is known to occasionally return duplicate or slightly-off entries; the unique constraint absorbs duplicates.
- Public launch requires Spotify's **Extended Quota** review. In Development Mode, only users you explicitly add in the dashboard can connect.

## Setup

Prerequisites: Node 20+, PostgreSQL (via Docker, or a local install), and a Spotify Developer app.

```bash
# 1. Start Postgres (Docker). Or use a local Postgres install and point
#    DATABASE_URL in your .env at it instead.
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
#    then fill in SPOTIFY_CLIENT_ID / SECRET and confirm the redirect URI
#    matches one registered in your Spotify dashboard.

# 4. Run migrations
npm run migrate:dev

# 5. Run the API server and the worker (separate terminals)
npm run dev
npm run dev:worker
```

Then visit `http://127.0.0.1:3000/connect/spotify` to connect an account. Play something on Spotify, wait for the next poll tick, and rows will appear in the `plays` table.

> **Note:** Use `127.0.0.1`, not `localhost`. As of April 2025 Spotify rejects `localhost` as a redirect URI and requires the explicit loopback IP. The address you visit in the browser must match the registered redirect URI exactly.

### Spotify dashboard setup

1. Create an app at the Spotify Developer Dashboard.
2. Add `http://127.0.0.1:3000/callback/spotify` as a Redirect URI. (Spotify
   requires the explicit loopback IP — `localhost` is not accepted.)
3. While in Development Mode, add your own Spotify account under the app's user-management settings.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API server with hot reload. |
| `npm run dev:worker` | Polling worker with hot reload. |
| `npm run migrate:dev` | Apply pending migrations. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run typecheck` | Type-check without emitting. |
| `npm start` / `npm run start:worker` | Run the compiled server / worker. |

## Roadmap

This is Phase 1 of a larger system. Next components (separate concerns):

- **Canonical track-matching layer** — ISRC-first resolution with fuzzy fallback.
- **Charting engine** — weeks-on-chart and peak-position metrics over the play log.
- **Apple Music ingestion** — requires a native iOS client (MusicKit on-device capture).
