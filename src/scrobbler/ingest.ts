import { getRecentlyPlayed, TokenExpiredError } from '../spotify/client.js';
import { refreshAccessToken } from '../spotify/oauth.js';
import {
  insertPlaysAndAdvanceCursor,
  touchPolled,
  updateAccountTokens,
  type SpotifyAccount,
} from './repository.js';
import { enrichAccountIsrcs } from './enrich.js';
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

/**
 * Run ISRC enrichment, isolated so its failure cannot disrupt ingestion.
 * Plays are already durably stored by the time this runs, so any error here is
 * logged and swallowed — the affected tracks are simply retried on a later tick.
 */
async function runEnrichment(accountId: string, accessToken: string): Promise<void> {
  try {
    await enrichAccountIsrcs(accountId, accessToken);
  } catch (error) {
    log.warn('ISRC enrichment failed (plays are stored; will retry next tick)', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    // Even with no new plays, there may be a backlog of stored plays still
    // missing ISRCs (e.g. plays captured before enrichment existed). Quiet
    // ticks are a good time to chip away at that backlog.
    await runEnrichment(account.id, accessToken);
    return 0;
  }

  const inserted = await insertPlaysAndAdvanceCursor(account.id, page.items);
  log.info('Ingested plays', {
    accountId: account.id,
    fetched: page.items.length,
    inserted,
  });

  await runEnrichment(account.id, accessToken);

  return inserted;
}
