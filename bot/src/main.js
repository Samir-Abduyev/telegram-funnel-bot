// Entry point: `npm start` (reads .env). Long polling — no public URL needed.
import { loadConfig, describeConfig } from './config.js';
import { createPool, checkSchema } from './db.js';
import { createApp, ALLOWED_UPDATES } from './app.js';
import { describeError, redactSecrets } from './util.js';
import { createAlerter } from './alerts.js';
import { Api } from 'grammy';

// Every log line passes through the token filter (a library error may print a request URL with the bot token).
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(...args.map((a) => (
    typeof a === 'string' ? redactSecrets(a) : a instanceof Error ? redactSecrets(a.stack || a.message) : a)));
}

// Exit codes for systemd: 78 = configuration problem (wrong .env, revoked token, another copy running) → no restart loop.
const EXIT_CONFIG = 78;
const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|timeout|socket hang up|network/i;
const REMIND_EVERY_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000; // «I am alive» into the DB; the next start compares it to tell the owner about downtime

const { cfg, errors } = loadConfig();
if (errors.length) {
  console.error('Ошибки в .env:\n - ' + errors.join('\n - '));
  process.exit(EXIT_CONFIG);
}
console.log(`[config] ${describeConfig(cfg)}`);
for (const w of cfg.warnings) console.warn(`[config] ⚠️ ${w}`);

const db = createPool(cfg);
// Before the app exists the owner is notified through a bare Telegram client (the database may be the problem).
const early = createAlerter((text) => new Api(cfg.token).sendMessage(cfg.ownerId, text, { parse_mode: 'HTML' }));
// Server just booted / no internet yet: wait and retry instead of exiting.
for (let attempt = 1; ; attempt++) {
  try {
    await checkSchema(db);
    await early.resolved('db-start', 'Связь с базой данных появилась — бот запускается.');
    break;
  } catch (e) {
    if (!NETWORK.test(e.message)) {
      console.error(`[db] база недоступна: ${redactSecrets(e.message)}\n     Проверьте DATABASE_URL и выполните npm run migrate.`);
      await early.alert('db-config', 'Бот НЕ запустился: ошибка базы данных', e, 'запуск бота (проверьте DATABASE_URL и выполните npm run migrate)');
      await db.end().catch(() => {});
      process.exit(EXIT_CONFIG);
    }
    if (attempt === 2) await early.alert('db-start', 'Бот не может запуститься: нет связи с базой данных', e, `запуск бота, жду и повторяю (попытка ${attempt})`);
    const wait = Math.min(60, 5 * attempt);
    console.warn(`[db] not reachable (${redactSecrets(e.message)}) — retry in ${wait} s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

const app = createApp(cfg, db);
const timer = setInterval(() => {
  app.remindTick().then((n) => n && console.log(`[remind] sent ${n}`))
    .catch((e) => app.alert('remind', 'Напоминания ученикам не отправились', e, 'рассылка напоминаний (раз в 15 мин)'));
}, REMIND_EVERY_MS);
const beat = setInterval(() => app.heartbeat(), HEARTBEAT_MS); // never throws: alerts the owner itself

process.on('unhandledRejection', (e) => app.alert('unhandled', 'Неожиданная ошибка', e, 'фоновая задача бота'));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[main] ${signal}: stopping…`);
  clearInterval(timer);
  clearInterval(beat);
  await app.bot.stop().catch(() => {});
  await app.recordStop(signal === 'SIGINT' ? 'вручную, Ctrl+C' : `команда остановки ${signal}`).catch(() => {});
  await db.end().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.bot.start({
    allowed_updates: ALLOWED_UPDATES,
    onStart: (me) => {
      console.log(`[main] @${me.username} is running (long polling)`);
      app.setupCommands().catch((e) => console.warn(`[main] commands menu: ${describeError(e)}`));
      app.startupReport().catch((e) => console.error(`[main] startup report: ${describeError(e)}`));
    },
  });
} catch (e) {
  const d = describeError(e);
  console.error(`[main] bot stopped with an error: ${d}`);
  if (/401/.test(d)) console.error('       Токен неверный или отозван: обновите BOT_TOKEN в .env.');
  if (/409/.test(d)) console.error('       Этого бота уже запускает другой процесс. Остановите его.');
  clearInterval(timer);
  clearInterval(beat);
  await app.alert('fatal', 'Бот ОСТАНОВИЛСЯ', e, 'получение сообщений из Telegram');
  await app.recordStop(`ошибка: ${d.slice(0, 120)}`).catch(() => {});
  await db.end().catch(() => {});
  process.exit(/401|409/.test(d) ? EXIT_CONFIG : 1);
}
