import pg from 'pg';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/**
 * A single shared connection pool for the whole process.
 *
 * `pg.Pool` manages a set of reusable connections; you acquire one per query
 * and it's returned automatically. Never create a second pool — that defeats
 * the purpose and can exhaust Postgres connection limits.
 */
export const pool = new pg.Pool({
  connectionString: config.database.url,
  // Keep this conservative; the worker and API share the same DB and a small
  // pool is plenty for a polling workload.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Errors on idle clients are surfaced here. Log loudly but don't crash —
  // the pool will recycle the bad client.
  log.error('Unexpected error on idle database client', { error: err.message });
});

/**
 * Thin query helper that infers row shape from the caller. Use parameterized
 * queries ($1, $2, ...) exclusively — never interpolate user input into SQL.
 */
export async function query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<pg.QueryResult<Row>> {
  return pool.query<Row>(text, params as unknown[] | undefined);
}

/**
 * Run a set of statements inside a transaction. The callback receives a
 * dedicated client; if it throws, the transaction is rolled back.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
