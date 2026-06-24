import { randomBytes } from 'node:crypto';

/**
 * Short-lived store for OAuth `state` values (CSRF protection).
 *
 * When we send a user to Spotify we mint a random state and remember it; when
 * Spotify redirects back we verify the returned state was one we issued and
 * hasn't expired. In-memory is fine for a single API instance; if you run
 * multiple instances, back this with Redis or a DB table instead.
 */

const STATE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

const issued = new Map<string, number>(); // state -> expiry epoch ms

export function issueState(): string {
  const state = randomBytes(16).toString('hex');
  issued.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

export function consumeState(state: string): boolean {
  const expiry = issued.get(state);
  if (expiry === undefined) return false;
  issued.delete(state);
  return expiry > Date.now();
}

// Periodically evict expired states so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of issued) {
    if (expiry <= now) issued.delete(state);
  }
}, STATE_TTL_MS).unref();
