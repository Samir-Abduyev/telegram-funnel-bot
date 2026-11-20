import { GrammyError, HttpError } from 'grammy';

/** HTML-escape for Telegram parse_mode=HTML. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A bot token ("123456789:AA…") must never reach logs: network errors of grammY contain the request URL with the token.
const TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
export const redactSecrets = (s) => String(s ?? '').replace(TOKEN_RE, '<token>');

/** Short, secret-free description of an error. */
export function describeError(err) {
  if (err instanceof GrammyError) return redactSecrets(`Telegram ${err.method}: ${err.error_code} ${err.description}`);
  if (err instanceof HttpError) return redactSecrets(`Telegram network error: ${err.error instanceof Error ? err.error.message : String(err.error)}`);
  if (err instanceof Error) return redactSecrets(err.message);
  return redactSecrets(String(err));
}

/** true when Telegram says the person blocked the bot / deleted the account. */
export const isBlocked = (err) => err instanceof GrammyError && err.error_code === 403;

/** Hour (0–23) in Baku. */
export const bakuHour = (date = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Baku', hour: '2-digit', hourCycle: 'h23' }).format(date));

/** Clickable name of a user for owner messages (HTML). */
export const who = (u) => {
  const id = u.user_id ?? u.id;
  const name = esc(u.first_name || 'İstifadəçi');
  return `<a href="tg://user?id=${id}">${name}</a>${u.username ? ` @${esc(u.username)}` : ''} · id ${id}`;
};
