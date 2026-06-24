import { getRecentlyPlayed, TokenExpiredError } from '../spotify/client.js';
import { refreshAccessToken } from '../spotify/oauth.js';
import {
  insertPlaysAndAdvanceCursor,
  touchPolled,
  updateAccountTokens,
  type SpotifyAccount,
} from './repository.js';
import { log } from '../lib/logger.js';

/**
 * The unit of work: ingest new plays for a single connected account.
 *
 * Responsibilities, in order:
 *   1. Ensure we have a valid (non-expired) access token, refreshing if needed.
 *   2. Fetch recently-played strictly after our stored cursor.
 *   3. Persist new plays and advance the cursor atomically.
 *
 * A 401 mid-fetch (token expired between our check and the call) is handled by
 * refreshing once and retrying the fetch a single time.
 */

// Refresh a little before actual expiry to avoid races.
const EXPIRY_SKEW_MS = 60_000;

async function ensureFreshToken(account: SpotifyAccount): Promise<string> {
  const expiresSoon = account.token_expires_at.getTime() - EXPIRY_SKEW_MS <= Date.now();
  if (!expiresSoon) {
    return account.access_token;
  }

  log.info('Refreshing Spotify access token', { accountId: account.id });
  const token = await refreshAccessToken(account.refresh_token);
  const expiresAt = new Date(Date.now() + token.expires_in * 1_000);
  await updateAccountTokens(account.id, token.access_token, expiresAt, token.refresh_token);
  return token.access_token;
}

export async function ingestAccount(account: SpotifyAccount): Promise<number> {
  let accessToken = await ensureFreshToken(account);

  const afterMs =
    account.last_played_after_ms === null ? undefined : Number(account.last_played_after_ms);

  let page;
  try {
    page = await getRecentlyPlayed(accessToken, afterMs);
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      // Token died between check and use: refresh once, retry once.
      const token = await refreshAccessToken(account.refresh_token);
      const expiresAt = new Date(Date.now() + token.expires_in * 1_000);
      await updateAccountTokens(account.id, token.access_token, expiresAt, token.refresh_token);
      accessToken = token.access_token;
      page = await getRecentlyPlayed(accessToken, afterMs);
    } else {
      throw error;
    }
  }

  if (page.items.length === 0) {
    await touchPolled(account.id);
    return 0;
  }

  const inserted = await insertPlaysAndAdvanceCursor(account.id, page.items);
  log.info('Ingested plays', {
    accountId: account.id,
    fetched: page.items.length,
    inserted,
  });
  return inserted;
}
