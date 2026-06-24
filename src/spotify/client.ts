import type { SpotifyRecentlyPlayedResponse } from './types.js';
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

/** Thrown on a 401 so the worker knows to refresh the token and retry once. */
export class TokenExpiredError extends Error {
  constructor() {
    super('Spotify access token expired');
    this.name = 'TokenExpiredError';
  }
}
