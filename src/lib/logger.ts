/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line, which is what most log aggregators expect.
 * Kept dependency-free on purpose — swapping in pino/winston later is trivial
 * because the rest of the code only depends on this small surface.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

function emit(level: Level, message: string, fields?: Fields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
