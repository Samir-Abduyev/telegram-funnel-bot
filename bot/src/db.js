import pg from 'pg';
import { readFileSync } from 'node:fs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Postgres pool. SSL is set explicitly (sslmode in the URL is ignored: node-postgres would let it override ssl).
 *   disable – no TLS (local only) · require – TLS without cert check (default for remote) · verify – TLS + DATABASE_CA_FILE
 */
export function createPool(cfg) {
  const url = new URL(cfg.databaseUrl);
  url.searchParams.delete('sslmode');
  const mode = cfg.databaseSsl || (LOCAL_HOSTS.has(url.hostname) ? 'disable' : 'require');
  const ssl = mode === 'disable'
    ? false
    : mode === 'verify'
      ? { ca: readFileSync(cfg.databaseCaFile, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: false };
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: 5,
    connectionTimeoutMillis: 10000,
    // Keep connections open: a new TLS connection to a far database costs ~3 s (measured Baku → Tokyo), and with a
    // 30 s idle timeout every click after a pause paid it. keepAlive stops routers from silently dropping idle sockets.
    idleTimeoutMillis: 0,
    keepAlive: true,
    statement_timeout: 10000,
    application_name: 'funnel-bot',
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (e) => console.error(`[db] idle client error: ${e.message}`));
  return pool;
}

/** Throws if sql/001_init.sql was not applied. */
export async function checkSchema(db) {
  await db.query('SELECT 1 FROM funnel.users LIMIT 1');
  await db.query('SELECT 1 FROM funnel.content LIMIT 1');
}
