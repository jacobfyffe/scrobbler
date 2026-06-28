import { getTrack, ENRICH_TRACKS_PER_TICK } from '../spotify/client.js';
import { getTrackIdsMissingIsrc, setIsrcForTrack } from './repository.js';
import { sleep } from '../lib/retry.js';
import { log } from '../lib/logger.js';

/**
 * ISRC enrichment.
 *
 * The recently-played feed gives us track IDs but no ISRC. ISRC is the primary
 * cross-service identity key (it's how the same recording is matched across
 * Spotify and Apple Music later), so we backfill it here from the full Track
 * objects returned by GET /v1/tracks/{id}.
 *
 * Why single-track calls instead of the batch endpoint: Spotify's Feb/Mar 2026
 * API migration made the batch endpoint (GET /v1/tracks?ids=...) return 403 for
 * Development Mode apps. The single-track endpoint still works, so we resolve
 * one track per request, capped per tick. Verified against this app's own data.
 *
 * This runs right after ingestion (and on quiet ticks, to chip away at any
 * backlog of plays that predate enrichment). It's deliberately tolerant: a
 * track that can't be resolved simply stays null and is retried later. The
 * caller (ingest) wraps this so a failure never disrupts already-stored plays.
 */

// Small pause between calls so a backlog sweep doesn't hammer the API. The
// retry layer already handles 429s, but politeness keeps us well clear of them.
const INTER_CALL_DELAY_MS = 100;

export async function enrichAccountIsrcs(accountId: string, accessToken: string): Promise<number> {
  const trackIds = await getTrackIdsMissingIsrc(accountId, ENRICH_TRACKS_PER_TICK);
  if (trackIds.length === 0) {
    return 0;
  }

  let updatedPlays = 0;
  let resolvedTracks = 0;

  for (let i = 0; i < trackIds.length; i++) {
    const trackId = trackIds[i];
    if (trackId === undefined) continue; // satisfies noUncheckedIndexedAccess

    const track = await getTrack(accessToken, trackId);
    const isrc = track?.external_ids?.isrc;
    if (isrc) {
      updatedPlays += await setIsrcForTrack(accountId, trackId, isrc);
      resolvedTracks++;
    }

    // Don't sleep after the last call.
    if (i < trackIds.length - 1) {
      await sleep(INTER_CALL_DELAY_MS);
    }
  }

  if (resolvedTracks > 0) {
    log.info('Enriched ISRCs', {
      accountId,
      tracksRequested: trackIds.length,
      tracksResolved: resolvedTracks,
      playsUpdated: updatedPlays,
    });
  }
  return updatedPlays;
}
