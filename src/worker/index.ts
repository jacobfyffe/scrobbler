import { config } from '../config/index.js';
import { getAccountsToPoll } from '../scrobbler/repository.js';
import { ingestAccount } from '../scrobbler/ingest.js';
import { closePool } from '../db/pool.js';
import { sleep } from '../lib/retry.js';
import { log } from '../lib/logger.js';

/**
 * Standalone polling worker.
 *
 * Runs as its own process (separate from the API server) so it can be scaled
 * and reasoned about independently. Each tick pulls a batch of accounts ordered
 * by least-recently-polled and ingests each. Failures on one account are logged
 * and isolated — they never abort the tick or take down the loop.
 *
 * This is single-process and sequential by design: simple, predictable, and
 * more than adequate for the current scale. Concurrency or multiple worker
 * instances can come later without changing the account-selection contract.
 */

let running = true;

async function tick(): Promise<void> {
  const accounts = await getAccountsToPoll(config.worker.batchSize);
  if (accounts.length === 0) {
    log.debug('No accounts to poll this tick');
    return;
  }

  for (const account of accounts) {
    if (!running) break;
    try {
      await ingestAccount(account);
    } catch (error) {
      log.error('Failed to ingest account', {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function main(): Promise<void> {
  log.info('Scrobbler worker starting', {
    intervalSeconds: config.worker.pollIntervalSeconds,
    batchSize: config.worker.batchSize,
  });

  while (running) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (error) {
      log.error('Tick failed', { error: error instanceof Error ? error.message : String(error) });
    }

    // Sleep the remainder of the interval (never negative).
    const elapsed = Date.now() - startedAt;
    const remaining = config.worker.pollIntervalSeconds * 1_000 - elapsed;
    if (remaining > 0 && running) {
      await sleep(remaining);
    }
  }

  log.info('Scrobbler worker stopped');
  await closePool();
}

// Graceful shutdown: finish the current account, then exit cleanly.
function shutdown(signal: string): void {
  log.info('Received shutdown signal', { signal });
  running = false;
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error: unknown) => {
  log.error('Worker crashed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
