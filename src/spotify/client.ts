import type {
  SpotifyRecentlyPlayedResponse,
  SpotifyTrack,
} from './types.js';
import { RetryableError, withRetry } from '../lib/retry.js';

/**
 * Thin client for the Spotify Web API endpoints we use.
 *
 * Rate limiting: Spotify returns HTTP 429 with a `Retry-After` header (seconds)
 * when you exceed the rolling limit. We surface that as a RetryableError carrying
 * the hint, and withRetry() honors it. This is the single most important thing
 * to get right for a polling workload.
 */

const API_BASE = 'https://api.spotify.com/v1';

const RETRY_OPTIONS = {
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  shouldRetry: (error: unknown) => error instanceof RetryableError,
};

async function authedGet(path: string, accessToken: string): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 429) {
    const retryAfterSec = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
    throw new RetryableError('Spotify rate limit (429)', retryAfterSec * 1_000);
  }
  if (response.status >= 500) {
    throw new RetryableError(`Spotify server error ${response.status}`);
  }
  if (response.status === 401) {
    // Token expired/invalid. The caller is responsible for refreshing and
    // retrying; this is not a transient error we should blindly retry.
    throw new TokenExpiredError();
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify GET ${path} failed ${response.status}: ${text}`);
  }
  return response;
}

/**
 * Fetch a single page of the user's recently played tracks.
 *
 * @param afterMs Unix ms timestamp. Returns only plays strictly AFTER this
 *   instant. Pass the timestamp of the most recent play we've already stored so
 *   we don't re-fetch known history. Omit on the very first poll.
 */
export async function getRecentlyPlayed(
  accessToken: string,
  afterMs?: number,
  limit = 50,
): Promise<SpotifyRecentlyPlayedResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (afterMs !== undefined) {
    params.set('after', String(afterMs));
  }

  return withRetry(async () => {
    const response = await authedGet(`/me/player/recently-played?${params.toString()}`, accessToken);
    return (await response.json()) as SpotifyRecentlyPlayedResponse;
  }, RETRY_OPTIONS);
}

/**
 * How many track IDs we enrich per worker tick. The single-track endpoint takes
 * one ID per request, so this caps the number of sequential calls a tick makes
 * (and thus how fast we chew through a backlog of un-enriched plays).
 *
 * Note: the batch endpoint (GET /v1/tracks?ids=...) returns 403 for
 * Development Mode apps after Spotify's Feb/Mar 2026 API migration, so we use
 * the single-track endpoint, which remains accessible. If the app is later
 * granted Extended Quota, this could be revisited to batch again.
 */
export const ENRICH_TRACKS_PER_TICK = 50;

/**
 * Fetch one full Track object, primarily to read `external_ids.isrc` (absent
 * from the recently-played feed).
 *
 * Returns null if Spotify reports the track as not found (404) — the caller
 * treats that as "no ISRC available" and moves on, rather than failing.
 */
export async function getTrack(
  accessToken: string,
  trackId: string,
): Promise<SpotifyTrack | null> {
  return withRetry(async () => {
    const response = await fetch(`${API_BASE}/tracks/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 429) {
      const retryAfterSec = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
      throw new RetryableError('Spotify rate limit (429)', retryAfterSec * 1_000);
    }
    if (response.status >= 500) {
      throw new RetryableError(`Spotify server error ${response.status}`);
    }
    if (response.status === 401) {
      throw new TokenExpiredError();
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Spotify GET /tracks/${trackId} failed ${response.status}: ${text}`);
    }
    return (await response.json()) as SpotifyTrack;
  }, RETRY_OPTIONS);
}

/** Thrown on a 401 so the worker knows to refresh the token and retry once. */
export class TokenExpiredError extends Error {
  constructor() {
    super('Spotify access token expired');
    this.name = 'TokenExpiredError';
  }
}
