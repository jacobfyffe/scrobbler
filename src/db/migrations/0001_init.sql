-- 0001_init.sql
-- Initial schema for the Spotify scrobbler.
--
-- Design notes:
--   * We store raw Spotify identifiers and metadata here. Canonical cross-service
--     track resolution (the Phase 2 matching layer) lives in a separate concern;
--     this schema deliberately keeps the raw play log intact so it can be
--     reprocessed later without re-fetching from Spotify.
--   * Plays are only ever recorded from the point of account connection forward.
--     There is no historical backfill, by design.

CREATE TABLE IF NOT EXISTS users (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per connected Spotify account.
CREATE TABLE IF NOT EXISTS spotify_accounts (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    spotify_user_id      TEXT NOT NULL UNIQUE,
    access_token         TEXT NOT NULL,
    refresh_token        TEXT NOT NULL,
    -- When the current access token expires. The worker refreshes proactively.
    token_expires_at     TIMESTAMPTZ NOT NULL,
    -- Cursor for the Recently Played feed: the timestamp (ms) of the most recent
    -- play we have already ingested. We pass this as the `after` param so Spotify
    -- only returns newer plays. NULL means "first poll, fetch the latest page".
    last_played_after_ms BIGINT,
    -- When this account was most recently polled (for scheduling/observability).
    last_polled_at       TIMESTAMPTZ,
    connected_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spotify_accounts_user_id ON spotify_accounts(user_id);

-- One row per individual track play (scrobble).
CREATE TABLE IF NOT EXISTS plays (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    spotify_account_id  BIGINT NOT NULL REFERENCES spotify_accounts(id) ON DELETE CASCADE,
    -- Spotify's track ID (base-62). Kept raw; canonical resolution happens later.
    track_id            TEXT NOT NULL,
    track_name          TEXT NOT NULL,
    artist_name         TEXT NOT NULL,
    album_name          TEXT,
    -- ISRC when Spotify provides it: the primary key for future cross-service
    -- matching (Phase 2). Nullable because it is not always present.
    isrc                TEXT,
    duration_ms         INTEGER,
    -- The exact instant Spotify reports the track was played.
    played_at           TIMESTAMPTZ NOT NULL,
    -- The untouched Spotify item payload, for future reprocessing.
    raw                 JSONB NOT NULL,
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Spotify's Recently Played feed can return the same play across overlapping
    -- polls. (account, track, played_at) uniquely identifies a play, so this
    -- constraint makes ingestion idempotent.
    CONSTRAINT uq_play UNIQUE (spotify_account_id, track_id, played_at)
);

CREATE INDEX IF NOT EXISTS idx_plays_account_played_at
    ON plays(spotify_account_id, played_at DESC);

CREATE INDEX IF NOT EXISTS idx_plays_isrc ON plays(isrc) WHERE isrc IS NOT NULL;
