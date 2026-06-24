import { config } from '../config/index.js';
import type { SpotifyTokenResponse } from './types.js';
import { RetryableError } from '../lib/retry.js';

/**
 * Spotify OAuth (Authorization Code flow) helpers.
 *
 * Flow recap:
 *   1. Send the user to buildAuthorizeUrl(state). They approve scopes.
 *   2. Spotify redirects back to our redirect URI with ?code=...&state=...
 *   3. We exchange that code for tokens via exchangeCodeForTokens().
 *   4. Access tokens expire (~1h); refreshAccessToken() gets a fresh one using
 *      the long-lived refresh token.
 */

const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

/** HTTP Basic credential for the token endpoint: base64(client_id:client_secret). */
function basicAuthHeader(): string {
  const raw = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/**
 * Build the URL to redirect a user to in order to begin authorization.
 * `state` is an opaque value we generate and later verify on the callback to
 * defend against CSRF.
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    scope: config.spotify.scopes.join(' '),
    redirect_uri: config.spotify.redirectUri,
    state,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

async function requestToken(body: URLSearchParams): Promise<SpotifyTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    // 5xx and 429 are worth retrying; 4xx (bad code, etc.) are not.
    if (response.status >= 500 || response.status === 429) {
      throw new RetryableError(`Spotify token endpoint ${response.status}: ${text}`);
    }
    throw new Error(`Spotify token endpoint ${response.status}: ${text}`);
  }

  return (await response.json()) as SpotifyTokenResponse;
}

export function exchangeCodeForTokens(code: string): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.spotify.redirectUri,
  });
  return requestToken(body);
}

export function refreshAccessToken(refreshToken: string): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return requestToken(body);
}
