import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { log } from '../lib/logger.js';

/**
 * A deliberately tiny forward-only migration runner.
 *
 * Migrations are plain .sql files in ./migrations, applied in filename order
 * (hence the zero-padded numeric prefixes). Each applied filename is recorded
 * in schema_migrations so reruns are no-ops. Each file runs inside its own
 * transaction, so a failing migration leaves the database unchanged.
 *
 * This is intentionally not a full migration framework — for a project this
 * size, a readable 40-line runner beats a heavy dependency.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const already = await appliedMigrations();

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic sort works because of zero-padded prefixes

  let appliedCount = 0;
  for (const filename of files) {
    if (already.has(filename)) continue;

    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    log.info('Applying migration', { filename });

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    });
    appliedCount++;
  }

  log.info('Migrations complete', { applied: appliedCount, total: files.length });
}

// Allow running directly: `tsx src/db/migrate.ts` or `node dist/db/migrate.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error('Migration failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
}
