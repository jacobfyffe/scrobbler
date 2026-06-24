import 'dotenv/config';

/**
 * Centralized, validated configuration.
 *
 * We read process.env exactly once, here, and fail loudly at startup if
 * something required is missing or malformed. The rest of the codebase imports
 * the typed `config` object and never touches process.env directly. This keeps
 * env access in one place and means a misconfigured deploy crashes immediately
 * with a clear message instead of producing confusing runtime errors later.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function asInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: asInt(optional('PORT', '3000'), 'PORT'),

  database: {
    url: required('DATABASE_URL'),
  },

  spotify: {
    clientId: required('SPOTIFY_CLIENT_ID'),
    clientSecret: required('SPOTIFY_CLIENT_SECRET'),
    // Must exactly match a redirect URI registered in the Spotify dashboard.
    redirectUri: required('SPOTIFY_REDIRECT_URI'),
    // Scope needed to read the Recently Played feed.
    scopes: ['user-read-recently-played'] as const,
  },

  worker: {
    // How often each user's Recently Played feed is polled, in seconds.
    pollIntervalSeconds: asInt(optional('POLL_INTERVAL_SECONDS', '60'), 'POLL_INTERVAL_SECONDS'),
    // Max users processed per polling tick before yielding.
    batchSize: asInt(optional('POLL_BATCH_SIZE', '25'), 'POLL_BATCH_SIZE'),
  },
} as const;

export type Config = typeof config;
