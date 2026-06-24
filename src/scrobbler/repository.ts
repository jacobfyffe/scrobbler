import { query, withTransaction } from '../db/pool.js';
import type { SpotifyPlayHistoryItem } from '../spotify/types.js';

/**
 * Data-access layer. All SQL lives here so the rest of the app talks to the
 * database through typed functions rather than raw queries. Every query is
 * parameterized.
 */

export interface SpotifyAccount {
  id: string;
  user_id: string;
  spotify_user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  last_played_after_ms: string | null; // bigint comes back as string from pg
  last_polled_at: Date | null;
}

/** Accounts due for polling: those never polled, or polled longest ago. */
export async function getAccountsToPoll(limit: number): Promise<SpotifyAccount[]> {
  const { rows } = await query<SpotifyAccount>(
    `SELECT id, user_id, spotify_user_id, access_token, refresh_token,
            token_expires_at, last_played_after_ms, last_polled_at
       FROM spotify_accounts
   ORDER BY last_polled_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function updateAccountTokens(
  accountId: string,
  accessToken: string,
  expiresAt: Date,
  refreshToken?: string,
): Promise<void> {
  if (refreshToken !== undefined) {
    await query(
      `UPDATE spotify_accounts
          SET access_token = $2, token_expires_at = $3, refresh_token = $4
        WHERE id = $1`,
      [accountId, accessToken, expiresAt, refreshToken],
    );
  } else {
    await query(
      `UPDATE spotify_accounts
          SET access_token = $2, token_expires_at = $3
        WHERE id = $1`,
      [accountId, accessToken, expiresAt],
    );
  }
}

/**
 * Persist a page of plays and advance the account's cursor, atomically.
 *
 * Returns the number of NEW plays inserted (duplicates are silently ignored via
 * ON CONFLICT, thanks to the uq_play constraint). The cursor is advanced to the
 * newest played_at we saw so the next poll only fetches newer plays.
 */
export async function insertPlaysAndAdvanceCursor(
  accountId: string,
  items: SpotifyPlayHistoryItem[],
): Promise<number> {
  if (items.length === 0) return 0;

  return withTransaction(async (client) => {
    let inserted = 0;
    let maxPlayedAtMs = 0;

    for (const item of items) {
      const { track, played_at } = item;
      const playedAtMs = Date.parse(played_at);
      if (playedAtMs > maxPlayedAtMs) maxPlayedAtMs = playedAtMs;

      const artistName = track.artists.map((a) => a.name).join(', ');

      const result = await client.query(
        `INSERT INTO plays
           (spotify_account_id, track_id, track_name, artist_name, album_name,
            isrc, duration_ms, played_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT ON CONSTRAINT uq_play DO NOTHING`,
        [
          accountId,
          track.id,
          track.name,
          artistName,
          track.album?.name ?? null,
          track.external_ids?.isrc ?? null,
          track.duration_ms ?? null,
          new Date(playedAtMs),
          JSON.stringify(item),
        ],
      );
      inserted += result.rowCount ?? 0;
    }

    // Advance cursor only forward, and always stamp last_polled_at.
    await client.query(
      `UPDATE spotify_accounts
          SET last_played_after_ms = GREATEST(COALESCE(last_played_after_ms, 0), $2),
              last_polled_at = now()
        WHERE id = $1`,
      [accountId, maxPlayedAtMs],
    );

    return inserted;
  });
}

/** Stamp last_polled_at even when a poll returned no new plays. */
export async function touchPolled(accountId: string): Promise<void> {
  await query('UPDATE spotify_accounts SET last_polled_at = now() WHERE id = $1', [accountId]);
}
