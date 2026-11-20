// Messages to the owner when something breaks: what, where, why, what to do. Never throws; the same problem
// is reported at most once per 30 min (the next report says how many times it repeated meanwhile).
import { esc, describeError } from './util.js';

export const ALERT_REPEAT_MS = 30 * 60 * 1000;

/** Plain-Russian cause and action for a (secret-free) error description. */
export function hintFor(desc) {
  const d = String(desc);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|timeout|terminated|connect/i.test(d) && !/Telegram/.test(d)) {
    return 'Нет связи с базой данных. Проверьте интернет на компьютере/сервере и что проект Supabase «funnel-bot» не на паузе (supabase.com → проект → Resume).';
  }
  if (/Telegram network error/i.test(d)) return 'Нет связи с Telegram: пропал интернет или Telegram недоступен. Бот повторит сам.';
  if (/ 409 /.test(d)) return 'Запущена вторая копия бота (на ПК и на сервере одновременно?). Оставьте одну.';
  if (/ 401 /.test(d)) return 'Токен бота неверный или отозван: вставьте новый BOT_TOKEN в .env.';
  if (/ 429 /.test(d)) return 'Telegram просит отправлять реже (слишком много сообщений). Обычно проходит само.';
  if (/ 403 /.test(d)) return 'Telegram запретил действие: бота заблокировали или у него нет прав (например, не админ группы).';
  if (/ 400 /.test(d)) return 'Telegram отклонил запрос (неверные данные: например, слишком длинная подпись или удалённое сообщение).';
  if (/permission denied|does not exist|relation|column/i.test(d)) return 'Проблема со структурой базы: выполните npm run migrate.';
  return 'Неожиданная ошибка в коде. Перешлите это сообщение разработчику.';
}

/** Short «where» for an update: what the person did. */
export function describeUpdate(ctx) {
  const u = ctx?.update ?? {};
  const from = ctx?.from ? `${ctx.from.first_name ?? ''}${ctx.from.username ? ` @${ctx.from.username}` : ''} (id ${ctx.from.id})` : '';
  if (u.callback_query) return `нажатие кнопки «${u.callback_query.data}» — ${from}`;
  if (u.message?.text?.startsWith('/')) return `команда ${u.message.text.split(/\s/)[0]} — ${from}`;
  if (u.message) {
    const kind = ['text', 'video', 'photo', 'document', 'video_note', 'voice', 'audio', 'animation', 'sticker'].find((k) => u.message[k]) ?? 'сообщение';
    return `сообщение (${kind}) — ${from}`;
  }
  if (u.chat_join_request) return `заявка в группу — ${from}`;
  if (u.my_chat_member) return 'бота добавили/убрали из чата';
  return `обновление ${Object.keys(u).find((k) => k !== 'update_id') ?? '?'}`;
}

/**
 * send(html) → Promise: delivers a message to the owner. Returns alert(key, title, err, where) and resolved(key, text).
 * `key` groups repeats of the same problem (e.g. 'db', 'remind', 'handler:<error>').
 */
export function createAlerter(send, { now = () => Date.now(), repeatMs = ALERT_REPEAT_MS } = {}) {
  const last = new Map(); // key → { at, suppressed }

  async function deliver(text) {
    try {
      await send(text);
      return true;
    } catch (e) {
      console.error(`[alert] cannot notify the owner: ${describeError(e)}`);
      return false;
    }
  }

  async function alert(key, title, err, where = '') {
    const desc = err ? describeError(err) : '';
    console.error(`[alert] ${title}${where ? ` | ${where}` : ''}${desc ? ` | ${desc}` : ''}`);
    const seen = last.get(key);
    if (seen && now() - seen.at < repeatMs) {
      seen.suppressed++;
      return false;
    }
    const repeats = seen?.suppressed ? `\n🔁 За последние 30 мин повторилось ещё ${seen.suppressed} раз(а).` : '';
    last.set(key, { at: now(), suppressed: 0 });
    return deliver([
      `🚨 <b>${esc(title)}</b>`,
      where ? `📍 Где: ${esc(where)}` : '',
      desc ? `❗ Ошибка: <code>${esc(desc.slice(0, 500))}</code>` : '',
      desc ? `💡 ${esc(hintFor(desc))}` : '',
    ].filter(Boolean).join('\n') + repeats);
  }

  /** The problem `key` is over: tells the owner once (only if it was reported). */
  async function resolved(key, text) {
    if (!last.has(key)) return false;
    last.delete(key);
    return deliver(`✅ ${esc(text)}`);
  }

  return { alert, resolved };
}
