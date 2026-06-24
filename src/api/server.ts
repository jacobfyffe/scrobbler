import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from '../config/index.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../spotify/oauth.js';
import { issueState, consumeState } from './oauthState.js';
import { query } from '../db/pool.js';
import { log } from '../lib/logger.js';

/**
 * The API server.
 *
 * Responsibilities are deliberately narrow: it handles the OAuth handshake that
 * connects a Spotify account, and exposes a health check. Actual ingestion is
 * the worker's job — the server only needs to get tokens into the database.
 */

const app = express();

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/**
 * Step 1 of OAuth: redirect the user to Spotify's consent screen.
 */
app.get('/connect/spotify', (_req: Request, res: Response) => {
  const state = issueState();
  res.redirect(buildAuthorizeUrl(state));
});

/**
 * Step 2: Spotify redirects back here with ?code & ?state. We verify state,
 * exchange the code for tokens, fetch the Spotify user id, and persist the
 * account (creating a local user on first connect).
 */
app.get('/callback/spotify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state, error } = req.query;

    if (typeof error === 'string') {
      res.status(400).send(`Spotify authorization failed: ${error}`);
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send('Missing code or state.');
      return;
    }
    if (!consumeState(state)) {
      res.status(400).send('Invalid or expired state.');
      return;
    }

    const tokens = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1_000);

    // Identify the Spotify user so we can de-duplicate accounts.
    const profileResp = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResp.ok) {
      throw new Error(`Failed to fetch Spotify profile: ${profileResp.status}`);
    }
    const profile = (await profileResp.json()) as { id: string };

    if (tokens.refresh_token === undefined) {
      throw new Error('Spotify did not return a refresh token.');
    }

    // Upsert: create a user + account on first connect; refresh tokens on
    // reconnect. last_played_after_ms stays NULL so the first poll establishes
    // the connection-time cursor — no historical backfill, by design.
    await query(
      `WITH new_user AS (
         INSERT INTO users DEFAULT VALUES RETURNING id
       )
       INSERT INTO spotify_accounts
         (user_id, spotify_user_id, access_token, refresh_token, token_expires_at)
       VALUES ((SELECT id FROM new_user), $1, $2, $3, $4)
       ON CONFLICT (spotify_user_id) DO UPDATE
         SET access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             token_expires_at = EXCLUDED.token_expires_at`,
      [profile.id, tokens.access_token, tokens.refresh_token, expiresAt],
    );

    log.info('Spotify account connected', { spotifyUserId: profile.id });
    res.send('Spotify connected. You can close this window — your plays will start tracking shortly.');
  } catch (err) {
    next(err);
  }
});

// Centralized error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error('Request failed', { error: err instanceof Error ? err.message : String(err) });
  res.status(500).send('Internal error.');
});

app.listen(config.port, () => {
  log.info('API server listening', { port: config.port });
});
