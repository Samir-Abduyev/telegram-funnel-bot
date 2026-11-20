// `npm run migrate`: applies ../sql/*.sql in name order, each once, inside a transaction (files are idempotent).
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
const { cfg, errors } = loadConfig();
const dbErrors = errors.filter((e) => e.startsWith('DATABASE'));
if (dbErrors.length) { console.log('Ошибки в .env:\n - ' + dbErrors.join('\n - ')); process.exit(1); }

const db = createPool(cfg);
const files = readdirSync(SQL_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
let applied = new Set();
try {
  applied = new Set((await db.query('SELECT name FROM funnel.schema_migrations')).rows.map((r) => r.name));
} catch { /* first run: the table does not exist yet */ }

let count = 0;
for (const file of files) {
  if (applied.has(file)) { console.log(`skip   ${file}`); continue; }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(join(SQL_DIR, file), 'utf8'));
    await client.query('INSERT INTO funnel.schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    await client.query('COMMIT');
    console.log(`apply  ${file} ✓`);
    count++;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(`FAILED ${file}: ${e.message}`);
    client.release();
    await db.end();
    process.exit(1);
  }
  client.release();
}
console.log(count ? `Готово: применено миграций — ${count}.` : 'База уже актуальна.');
await db.end();
