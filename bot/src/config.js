import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * process.env with the bot's own .env ON TOP. `node --env-file` never overrides variables that already exist in the
 * system, so a stray Windows variable BOT_TOKEN (from another project) silently replaced our token → 401.
 */
export function envWithFile(path = '.env', base = process.env) {
  let file;
  try { file = readFileSync(path, 'utf8'); } catch { return base; }
  return { ...base, ...parseEnv(file) };
}

// .env → cfg. Returns { cfg, errors }; cfg.warnings lists non-fatal gaps (shown at start and in /lessons).
export function loadConfig(env = envWithFile()) {
  const errors = [];
  const warnings = [];
  const v = (k) => String(env[k] ?? '').trim();

  const token = v('BOT_TOKEN');
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) errors.push('BOT_TOKEN: вставьте токен бота из @BotFather');

  const ownerId = v('OWNER_ID');
  if (!/^\d{3,15}$/.test(ownerId)) errors.push('OWNER_ID: ваш числовой Telegram id (узнать у @userinfobot)');

  const ownerContact = v('OWNER_CONTACT');
  if (!ownerContact) errors.push('OWNER_CONTACT: ваш контакт для оплаты картой, например @username');

  const groupId = v('GROUP_ID');
  if (groupId && !/^-\d{5,20}$/.test(groupId)) errors.push('GROUP_ID: id группы начинается с минуса, например -1001234567890');
  if (!groupId) warnings.push('GROUP_ID не задан: подтверждённые ученики пока не получат ссылку в группу');

  const paymentUrl = v('PAYMENT_URL');
  if (paymentUrl && !/^https:\/\/\S+$/.test(paymentUrl)) errors.push('PAYMENT_URL: ссылка должна начинаться с https://');
  if (!paymentUrl) warnings.push('PAYMENT_URL не задан: кнопка «Ödəniş linki» скрыта, остаётся оплата картой');

  const channelUrl = v('CHANNEL_URL');
  if (channelUrl && !/^https:\/\/t\.me\/\S+$/.test(channelUrl)) errors.push('CHANNEL_URL: ссылка на канал вида https://t.me/имя_канала');

  const databaseUrl = v('DATABASE_URL');
  if (!/^postgres(ql)?:\/\/\S+$/.test(databaseUrl) || databaseUrl.includes('USER:PASSWORD@HOST')) {
    errors.push('DATABASE_URL: строка подключения Postgres (Supabase → Connect → Session pooler)');
  }
  const databaseSsl = v('DATABASE_SSL');
  if (databaseSsl && !['disable', 'require', 'verify'].includes(databaseSsl)) errors.push('DATABASE_SSL: disable | require | verify');
  const databaseCaFile = v('DATABASE_CA_FILE');
  if (databaseSsl === 'verify' && !databaseCaFile) errors.push('DATABASE_CA_FILE: путь к сертификату для DATABASE_SSL=verify');

  const cfg = {
    token,
    ownerId: Number(ownerId),
    ownerContact,
    groupId: groupId ? Number(groupId) : null,
    paymentUrl,
    channelUrl,
    databaseUrl,
    databaseSsl,
    databaseCaFile,
    warnings,
  };
  return { cfg, errors };
}

/** Config summary without secrets. */
export const describeConfig = (cfg) =>
  `owner=${cfg.ownerId} contact=${cfg.ownerContact} group=${cfg.groupId ?? '—'} payment_url=${cfg.paymentUrl ? 'set' : '—'} db_ssl=${cfg.databaseSsl || 'auto'}`;
