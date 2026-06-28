/**
 * Types describing the slices of Spotify's Web API responses we actually use.
 *
 * These are intentionally partial — Spotify returns far more than we model.
 * We type only what we read, and treat everything as the external, untrusted
 * shape it is. The raw payload is persisted verbatim (the `raw` column) so we
 * can extract more fields later without re-fetching.
 *
 * Note: the Recently Played endpoint does NOT include ISRC on the track object.
 * ISRC lives on the full Track object's `external_ids` (from GET /v1/tracks/{id}).
 * The ingestion path stores plays without ISRC first, then an enrichment step
 * (see getTrack / enrichAccountIsrcs) backfills it via that endpoint.
 */

export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
  refresh_token?: string; // omitted on refresh in some flows
  scope?: string;
}

export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
}

export interface SpotifyExternalIds {
  isrc?: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  external_ids?: SpotifyExternalIds; // present on full track objects, not on recently-played
}

export interface SpotifyPlayHistoryItem {
  track: SpotifyTrack;
  played_at: string; // ISO 8601 timestamp
}

export interface SpotifyCursors {
  after?: string;
  before?: string;
}

export interface SpotifyRecentlyPlayedResponse {
  items: SpotifyPlayHistoryItem[];
  next: string | null;
  cursors: SpotifyCursors;
  limit: number;
}
