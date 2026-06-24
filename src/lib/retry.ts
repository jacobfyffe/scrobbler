/**
 * Small async utilities used by the polling worker and Spotify client.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). */
  attempts: number;
  /** Base delay in ms; doubles each retry. */
  baseDelayMs: number;
  /** Optional cap on the computed delay. */
  maxDelayMs?: number;
  /**
   * Decide whether a thrown error is worth retrying. Defaults to retrying
   * everything. Return false to fail fast on, e.g., a 400 that will never
   * succeed on retry.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each backoff sleep, useful for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run `fn`, retrying with exponential backoff. If a function we call hands us
 * an explicit retry-after hint (see RetryableError), we honor it instead of the
 * computed backoff — this is how we respect Spotify's 429 Retry-After header.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = 30_000, shouldRetry = () => true, onRetry } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }

      // Honor an explicit server-provided delay if present.
      const hinted = error instanceof RetryableError ? error.retryAfterMs : undefined;
      const computed = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = hinted ?? computed;

      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Error type that carries an optional retry-after hint (in ms). Throw this from
 * an HTTP client when the server tells us how long to wait (e.g. 429s).
 */
export class RetryableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
    this.retryAfterMs = retryAfterMs;
  }
}
