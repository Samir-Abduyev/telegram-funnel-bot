// The bot: student funnel (lessons → payment under the last lesson → receipt → group) + owner commands + reminders.
// Student UI is «one screen»: before the next screen the bot deletes its previous messages, so the chat stays clean.
import { Bot, InlineKeyboard } from 'grammy';
import * as S from './store.js';
import { AZ } from './texts_az.js';
import { RU } from './texts_owner.js';
import { describeError, isBlocked, bakuHour } from './util.js';
import { createAlerter, describeUpdate } from './alerts.js';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'chat_join_request', 'my_chat_member'];
export const REMIND_HOURS = [10, 21]; // reminders only between 10:00 and 21:00 Baku time
export const GROUP_COUNT_MIN = 10; // students see «N nəfər qrupdadır» only from 10 people on (a small number repels)
const GROUP_COUNT_TTL_MS = 10 * 60 * 1000;

const SLOT_RE = /^(welcome|[1-9])$/;
const EDIT_MEDIA = new Set(['video', 'photo', 'animation', 'document', 'audio']); // what editMessageMedia can show
const CAPTION_MAX = 1024; // Telegram limit for bots' captions
const SEND = {
  video: 'sendVideo', photo: 'sendPhoto', animation: 'sendAnimation', document: 'sendDocument',
  video_note: 'sendVideoNote', voice: 'sendVoice', audio: 'sendAudio',
};

/** Message → storable content, or null for unsupported types. (animation before document: GIFs carry both.) */
export function extractContent(m) {
  const cap = { text: m.caption ?? '', entities: m.caption_entities ?? [] };
  if (m.text) return { kind: 'text', file_id: null, text: m.text, entities: m.entities ?? [] };
  if (m.video) return { kind: 'video', file_id: m.video.file_id, ...cap };
  if (m.photo) return { kind: 'photo', file_id: m.photo.at(-1).file_id, ...cap };
  if (m.animation) return { kind: 'animation', file_id: m.animation.file_id, ...cap };
  if (m.document) return { kind: 'document', file_id: m.document.file_id, ...cap };
  if (m.video_note) return { kind: 'video_note', file_id: m.video_note.file_id, text: '', entities: [] };
  if (m.voice) return { kind: 'voice', file_id: m.voice.file_id, ...cap };
  if (m.audio) return { kind: 'audio', file_id: m.audio.file_id, ...cap };
  return null;
}

/** Number of lessons shown: 1, 2, 3… without gaps. */
export function lessonCount(content) {
  const have = new Set(content.map((c) => c.slot));
  let n = 0;
  while (have.has(String(n + 1))) n++;
  return n;
}

/**
 * Lesson content with a bold first line `head` («Dərs 3/5»). Telegram entity offsets are UTF-16 units = JS string length,
 * so the owner's formatting is shifted by the added prefix. Unchanged when there is no caption slot (video_note) or the
 * result would exceed Telegram's limit (caption 1024 / text 4096).
 */
export function withHead(c, head) {
  if (!head || c.html || c.kind === 'video_note') return c;
  const text = c.text ? `${head}\n\n${c.text}` : head;
  if (text.length > (c.kind === 'text' ? 4096 : 1024)) return c;
  const shift = text.length - (c.text?.length ?? 0);
  const moved = (c.entities ?? []).map((e) => ({ ...e, offset: e.offset + shift }));
  return { ...c, text, entities: [{ type: 'bold', offset: 0, length: head.length }, ...moved] };
}

/** https://t.me/name for a contact like «@name», else null. */
export const contactUrl = (contact) => (/^@[A-Za-z0-9_]{4,32}$/.test(contact) ? `https://t.me/${contact.slice(1)}` : null);

const isTaskVideo = (m) => !!(m.video || m.video_note);
export const SKIP_TASK_AFTER_MS = 24 * 60 * 60 * 1000; // «⏭ Tapşırıqsız davam et» only after a day without the task

/** What a student sent instead of the task video (for /stats «🎥 Задания»). */
export function wrongTaskKind(m) {
  if (m.text) {
    const link = (m.entities ?? []).some((e) => e.type === 'url' || e.type === 'text_link') || /https?:\/\/|www\.|t\.me\//i.test(m.text);
    return link ? 'link' : 'text';
  }
  if (m.photo) return 'photo';
  if (m.animation) return 'gif'; // before document: a GIF carries both
  if (m.document) return /^video\//.test(m.document.mime_type ?? '') ? 'video_file' : 'file';
  if (m.voice) return 'voice';
  if (m.sticker) return 'sticker';
  if (m.audio) return 'audio';
  return 'other';
}
const isReceipt = (m) => !!(m.photo || m.document);

export function createApp(cfg, db, { botInfo } = {}) {
  const bot = new Bot(cfg.token, botInfo ? { botInfo } : {});
  const api = bot.api;
  const alerter = createAlerter((text) => api.sendMessage(cfg.ownerId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
  // Answering a callback is cosmetic: an old query (400 «query is too old» after downtime) must not stop the action.
  bot.use((ctx, next) => {
    if (ctx.callbackQuery) {
      const answer = ctx.answerCallbackQuery.bind(ctx);
      ctx.answerCallbackQuery = (...a) => answer(...a).catch((e) => console.warn(`[bot] answerCallbackQuery: ${describeError(e)}`));
    }
    return next();
  });
  // In memory (after a restart just repeat the command / tap the button again):
  const ownerWaits = new Map(); // owner id → { slot } after /set, { segment } after /broadcast
  let pendingBroadcast = null; // { id, chatId, msgId, segment } waiting for «Отправить»
  // Students who tapped «❓ Sual ver»: their next message is a question for the owner (in memory, ≤ 1000; lost on restart).
  const askWaits = new Map(); // user id → id of the «Sualını yaz» prompt (turned into «Sualın göndərildi» afterwards)
  let bcSeq = 0;
  const remember = (sent, userId, studentMsgId = null) => S.rememberOwnerMsg(db, sent.message_id, userId, studentMsgId);
  // Content cache. A read that was in flight while the owner changed content must not cache the old rows → version check.
  let contentCache = null;
  let contentVersion = 0;
  const loadContent = async () => {
    if (contentCache) return contentCache;
    const v = contentVersion;
    const rows = await S.listContent(db);
    if (v === contentVersion) contentCache = rows;
    return rows;
  };
  const resetContent = () => { contentCache = null; contentVersion++; };
  // Albums (media_group_id) arrive as several messages: only the first one counts (bounded memory).
  const seenAlbums = new Set();
  const firstOfAlbum = (userId, groupId) => {
    const key = `${userId}:${groupId}`;
    if (seenAlbums.has(key)) return false;
    seenAlbums.add(key);
    if (seenAlbums.size > 1000) seenAlbums.delete(seenAlbums.values().next().value);
    return true;
  };
  const isOwner = (ctx) => ctx.from?.id === cfg.ownerId;
  const adminUrl = contactUrl(cfg.ownerContact);

  // Members of the paid group as Telegram counts them (everyone, admins and bots included — the owner's choice).
  // Cached 10 min (a Telegram API call).
  let members = { n: null, at: 0 };
  async function groupMembers() {
    if (!cfg.groupId) return null;
    if (Date.now() - members.at < GROUP_COUNT_TTL_MS) return members.n;
    let n = null;
    try {
      n = await api.getChatMemberCount(cfg.groupId);
    } catch (e) {
      console.warn(`[group] member count: ${describeError(e)}`);
    }
    members = { n, at: Date.now() };
    return n;
  }

  // ---- sending ----

  // protect_content: lessons cannot be downloaded, saved or forwarded (Telegram hides those buttons).
  // `c` may be wrapped by withHead() to show «Dərs 3/5» on top.
  async function sendContent(chatId, c, reply_markup) {
    const p = { reply_markup, protect_content: true };
    if (c.html) return api.sendMessage(chatId, c.html, { parse_mode: 'HTML', ...p });
    if (c.kind === 'text') return api.sendMessage(chatId, c.text, { entities: c.entities, ...p });
    const caption = c.kind === 'video_note' || !c.text ? {} : { caption: c.text, caption_entities: c.entities };
    return api[SEND[c.kind]](chatId, c.file_id, { ...caption, ...p });
  }

  /** Bottom row of every student screen: lessons menu + contact the admin. */
  const navRow = (kb, { menu = true } = {}) => {
    if (menu) kb.text(AZ.menuBtn, 'menu');
    if (adminUrl) kb.url(AZ.contactBtn, adminUrl);
    return kb;
  };
  // Button layout rule: the main action on top, navigation («⏮ Əvvəlki dərs», «📚 Dərslər», «⬅️ Geri») ALWAYS the last row.
  // Navigation row from lesson 2 on: «⏮ Əvvəlki dərs» (re-watch lesson n-1) + «📚 Dərslər» (list of passed lessons).
  const backRow = (kb, n) => (n > 1 ? kb.text(AZ.prevBtn, `ls:${n - 1}`).text(AZ.menuBtn, 'menu') : kb);
  // Last lesson (n = total), view 1: «🚀 Qrupa qoşulmaq istəyirəm» / «❓ Sual ver» + «💬 Adminlə əlaqə» / navigation
  // (the ONLY lesson with the admin button).
  const offerKeyboard = (n) => {
    const kb = new InlineKeyboard().text(AZ.wantJoinBtn, 'join').row().text(AZ.askBtn, 'ask');
    if (adminUrl) kb.url(AZ.contactBtn, adminUrl);
    kb.row();
    return n > 1 ? backRow(kb, n) : kb.text(AZ.menuBtn, 'menu');
  };
  // Payment buttons: online / card (opens the owner's chat) / «Ödədim».
  const payButtons = () => {
    const kb = new InlineKeyboard();
    if (cfg.paymentUrl) kb.url(AZ.payLinkBtn, cfg.paymentUrl).row();
    if (adminUrl) kb.url(AZ.cardBtn, adminUrl).row();
    else kb.text(AZ.cardBtn, 'card').row();
    return kb.text(AZ.paidBtn, 'paid').row();
  };
  // Last lesson, view 2 (same video, only the buttons change): payment buttons / «⬅️ Geri».
  const payKeyboard = () => payButtons().text(AZ.backBtn, 'unjoin');
  // After a rejected receipt: payment buttons / «📚 Dərslər» (the last lesson is NOT sent again).
  const rejectKeyboard = () => payButtons().text(AZ.menuBtn, 'menu');
  // Lesson N: «➡️ Növbəti dərs» (no task) or «📤 Tapşırığı göndər» (task) / «❓ Sual ver» / «⏮ Əvvəlki dərs» + «📚 Dərslər».
  const lessonKeyboard = (n, lesson) => {
    const kb = new InlineKeyboard();
    if (lesson.has_task) kb.text(AZ.sendTaskBtn, `task:${n}`).row();
    else kb.text(AZ.nextBtn, `done:${n}`).row();
    return backRow(kb.text(AZ.askBtn, 'ask').row(), n);
  };
  const resumeKeyboard = () => new InlineKeyboard().text(AZ.resumeBtn, 'resume');
  // A student typed instead of pressing a button — maybe it is a question: offer «❓ Sual ver» right there.
  const hintKeyboard = () => new InlineKeyboard().text(AZ.askBtn, 'ask');
  const beginKeyboard = () => new InlineKeyboard().text(AZ.beginBtn, 'begin');

  // A screen part: { c, kb } — lesson/welcome content, or { text, extra } — a bot message (sendMessage options).
  const sendPart = (chat, p) => (p.c ? sendContent(chat, p.c, p.kb) : api.sendMessage(chat, p.text, p.extra));
  /** Turns an existing message into `p` in place. Throws when Telegram cannot (text ↔ media, voice, video note). */
  function editPart(chat, id, p) {
    if (!p.c) return api.editMessageText(chat, id, p.text, p.extra);
    const c = p.c;
    if (c.html) return api.editMessageText(chat, id, c.html, { parse_mode: 'HTML', reply_markup: p.kb });
    if (c.kind === 'text') return api.editMessageText(chat, id, c.text, { entities: c.entities, reply_markup: p.kb });
    if (!EDIT_MEDIA.has(c.kind)) throw new Error(`${c.kind} cannot be edited`);
    const media = { type: c.kind, media: c.file_id, ...(c.text ? { caption: c.text, caption_entities: c.entities } : {}) };
    return api.editMessageMedia(chat, id, media, { reply_markup: p.kb });
  }
  /** The message a button was pressed on, if it belongs to the student's current screen (only those may be edited). */
  const editable = (ctx, user) => {
    const id = ctx.callbackQuery?.message?.message_id;
    return id && (user?.screen_ids ?? []).map(Number).includes(id) ? id : null;
  };

  /**
   * Replaces the student's screen. With `editId` (the message whose button was pressed) the first part UPDATES that
   * message in place (lesson → lesson: new video, caption and buttons, nothing disappears); when Telegram cannot edit
   * (text ↔ video) it falls back to: send the new parts FIRST, then delete the bot's previous messages. If sending fails,
   * the old screen stays and the ids already sent are kept (deleted with the next screen). Deleting is best effort (48 h).
   */
  async function showScreen(userId, parts, { editId = null } = {}) {
    const ids = [];
    let kept = null;
    if (editId && parts.length) {
      try {
        await editPart(userId, editId, parts[0]);
        kept = editId;
      } catch (e) {
        if (/message is not modified/.test(describeError(e))) kept = editId; // the same screen again (double tap)
      }
      if (kept) { ids.push(kept); parts = parts.slice(1); }
    }
    try {
      for (const part of parts) ids.push((await sendPart(userId, part)).message_id);
    } catch (e) {
      const sent = ids.filter((id) => id !== kept);
      if (sent.length) await S.addToScreen(db, userId, sent).catch(() => {});
      throw e;
    }
    const old = await S.replaceScreen(db, userId, ids);
    await Promise.all(old.filter((id) => id !== kept).map((id) => api.deleteMessage(userId, id).catch(() => {})));
  }

  /** A short message that disappears with the next screen. */
  async function say(userId, text, extra = {}) {
    const m = await api.sendMessage(userId, text, extra);
    await S.addToScreen(db, userId, [m.message_id]);
  }

  /**
   * What the student should see now (current lesson / last lesson / receipt…). `before` = extra parts first.
   * `pay`: show the last lesson already with the payment buttons (after «Geri» from the receipt, after a rejected receipt).
   */
  async function showStep(user, before = [], { pay = false, editId = null } = {}) {
    const chat = user.user_id;
    const content = await loadContent();
    const total = lessonCount(content);
    const show = (parts) => showScreen(chat, [...before, ...parts], { editId });
    if (total === 0) return show([{ text: AZ.noLessons }]);
    // At «payment» but lessons were added after he reached it (he saw lesson N as the last one): continue with N+1.
    if (user.stage === 'offer' && user.lesson < total) {
      user = (await S.setStage(db, chat, 'lesson', user.lesson + 1, user)) ?? user;
    }
    if (user.stage === 'lesson' && user.lesson >= total) { // reached the last lesson (or lessons were removed)
      user = (await S.setStage(db, chat, 'offer', total)) ?? user;
    }
    const lessonParts = (n, kb) => {
      const lesson = content.find((c) => c.slot === String(n));
      const parts = [{ c: withHead(lesson, AZ.progress(n, total)), kb: kb(lesson) }];
      if (lesson.has_task) parts.push({ text: AZ.taskHint, extra: { parse_mode: 'HTML' } });
      return parts;
    };
    if (user.stage === 'lesson') return show(lessonParts(user.lesson, (l) => lessonKeyboard(user.lesson, l)));
    if (user.stage === 'offer') {
      const n = await groupMembers(); // social proof under the payment buttons, only when it is not embarrassingly small
      const proof = n !== null && n >= GROUP_COUNT_MIN ? [{ text: AZ.groupCount(n), extra: { parse_mode: 'HTML' } }] : [];
      return show([...lessonParts(total, () => (pay ? payKeyboard() : offerKeyboard(total))), ...proof]);
    }
    if (user.stage === 'receipt') return show([{ text: AZ.askReceipt, extra: { reply_markup: new InlineKeyboard().text(AZ.backBtn, 'back') } }]);
    if (user.stage === 'review') return show([{ text: AZ.underReview, extra: { parse_mode: 'HTML', reply_markup: navRow(new InlineKeyboard()) } }]);
    // Paid: group link + «🎬 Dərslərə yenidən bax» (all lessons from lesson 1, one after another) + menu / admin.
    const kb = user.invite_link ? new InlineKeyboard().url(AZ.joinBtn, user.invite_link).row() : new InlineKeyboard();
    kb.text(AZ.rewatchBtn, 'ls:1').row();
    return show([{ text: user.invite_link ? AZ.approved : AZ.joined, extra: { parse_mode: 'HTML', reply_markup: navRow(kb) } }]);
  }

  /**
   * Lesson N finished (button or task video): next lesson (the last one carries the payment buttons). Once per lesson.
   * `accepted`: after a task video show «✅ Tapşırığın qəbul edildi!» with «➡️ Növbəti dərs» instead of the lesson itself.
   */
  async function advance(user, before = [], { accepted = false, editId = null } = {}) {
    const total = lessonCount(await loadContent());
    const nextN = user.lesson + 1;
    const next = await S.setStage(db, user.user_id, nextN >= total ? 'offer' : 'lesson', Math.min(nextN, total), user);
    if (!next) return null;
    const after = [];
    if (user.lesson === 1 && cfg.channelUrl) { // soft channel invite once, after lesson 1 (not a condition)
      after.push({ text: AZ.channel, extra: { reply_markup: new InlineKeyboard().url(AZ.channelBtn, cfg.channelUrl) } });
    }
    if (accepted) {
      const kb = new InlineKeyboard().text(AZ.nextBtn, 'resume');
      await showScreen(user.user_id, [...before, { text: AZ.taskAccepted, extra: { parse_mode: 'HTML', reply_markup: kb } }, ...after]);
    } else {
      await showStep(next, before, { editId });
      if (after.length) await say(user.user_id, after[0].text, after[0].extra);
    }
    return next;
  }

  /** Lessons the student may re-watch: only PASSED ones (before the current lesson); all of them from the last lesson on. */
  const unlocked = (user, total) => (user.stage === 'lesson' ? Math.min(user.lesson - 1, total) : total);

  async function toOwner(text, extra = {}) {
    return api.sendMessage(cfg.ownerId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  /** Entry screen: greeting with ONE button «▶️ Pulsuz dərslərə başla» (nothing else). */
  async function showWelcome(chat, firstName) {
    const welcome = (await loadContent()).find((c) => c.slot === 'welcome') ?? { html: AZ.welcome(firstName) };
    await showScreen(chat, [{ c: welcome, kb: beginKeyboard() }]);
  }
  // Not started yet (or still on lesson 1): /start shows the entry screen; further along: the current step.
  const atEntry = (user) => user.stage === 'lesson' && user.lesson === 1;

  // ---- students ----

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const { user, created } = await S.startUser(db, ctx.from, ctx.match?.slice(0, 64));
    api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}); // keep the chat clean
    if (atEntry(user)) await showWelcome(ctx.chat.id, ctx.from.first_name);
    else await showStep(user);
  });

  // Every button below updates the message it was pressed on when Telegram allows it (editable → showScreen editId).
  bot.callbackQuery('begin', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (user) await showStep(user, [], { editId: editable(ctx, user) });
  });

  // «⏭ Tapşırıqsız davam et» (from a reminder): a student stuck on lesson N's task for a day goes on without it.
  bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    const n = Number(ctx.match[1]);
    const user = await S.getUser(db, ctx.from.id);
    if (!user || user.stage !== 'lesson' || user.lesson !== n) return ctx.answerCallbackQuery(); // already moved on
    const lesson = (await loadContent()).find((c) => c.slot === String(n));
    if (!lesson?.has_task) return ctx.answerCallbackQuery();
    if (Date.now() - new Date(user.stage_at).getTime() < SKIP_TASK_AFTER_MS) {
      return ctx.answerCallbackQuery({ text: AZ.skipNotYet, show_alert: true });
    }
    await ctx.answerCallbackQuery();
    await S.logEvent(db, user.user_id, 'task_skip', n);
    await advance(user);
  });

  // «📤 Tapşırığı göndər»: a pop-up explains how to send the task video (the video itself opens the next lesson).
  bot.callbackQuery(/^task:(\d+)$/, (ctx) => ctx.answerCallbackQuery({ text: AZ.sendTaskHow, show_alert: true }));

  bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
    const n = Number(ctx.match[1]);
    const user = await S.getUser(db, ctx.from.id);
    if (!user || user.stage !== 'lesson' || user.lesson !== n) return ctx.answerCallbackQuery();
    const lesson = (await loadContent()).find((c) => c.slot === String(n));
    if (lesson?.has_task) return ctx.answerCallbackQuery({ text: AZ.needVideo, show_alert: true });
    await ctx.answerCallbackQuery();
    await advance(user, [], { editId: editable(ctx, user) });
  });

  bot.callbackQuery('resume', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (user) await showStep(user, [], { editId: editable(ctx, user) });
  });

  bot.callbackQuery('menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (!user) return;
    const content = await loadContent();
    const kb = new InlineKeyboard();
    const total = lessonCount(content);
    for (let n = 1; n <= unlocked(user, total); n++) kb.text(AZ.progress(n, total), `ls:${n}`).row();
    kb.text(AZ.resumeBtn, 'resume');
    // The list appears as buttons UNDER THE SAME message (video stays, nothing jumps); a separate message only as a fallback.
    const editId = editable(ctx, user);
    if (editId) {
      try {
        await api.editMessageReplyMarkup(user.user_id, editId, { reply_markup: kb });
        return;
      } catch (e) {
        if (/message is not modified/.test(describeError(e))) return;
      }
    }
    await showScreen(user.user_id, [{ text: AZ.menuTitle, extra: { parse_mode: 'HTML', reply_markup: kb } }]);
  });

  bot.callbackQuery(/^ls:(\d+)$/, async (ctx) => { // re-watch a passed lesson (progress unchanged)
    await ctx.answerCallbackQuery();
    const n = Number(ctx.match[1]);
    const user = await S.getUser(db, ctx.from.id);
    const content = await loadContent();
    const total = lessonCount(content);
    if (!user || n < 1 || n > unlocked(user, total)) return;
    const lesson = content.find((c) => c.slot === String(n));
    // «➡️ Növbəti dərs» (re-watch the next lesson too: after paying he can go 1 → last in a row) /
    // «Davam et» = back to where he stopped / «❓ Sual ver» / navigation last
    const kb = new InlineKeyboard();
    if (n < unlocked(user, total)) kb.text(AZ.nextBtn, `ls:${n + 1}`).row();
    kb.text(AZ.resumeBtn, 'resume').row().text(AZ.askBtn, 'ask').row();
    if (n > 1) kb.text(AZ.prevBtn, `ls:${n - 1}`);
    kb.text(AZ.menuBtn, 'menu');
    await showScreen(user.user_id, [{ c: withHead(lesson, AZ.progress(n, total)), kb }], { editId: editable(ctx, user) });
  });

  // «❓ Sual ver»: the next message of the student goes to the owner (who answers with «Reply»).
  bot.callbackQuery('ask', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (!user) return;
    if (askWaits.size >= 1000) askWaits.clear(); // bounded memory
    const prompt = await api.sendMessage(user.user_id, AZ.askPrompt, { reply_markup: new InlineKeyboard().text(AZ.backBtn, 'unask') });
    await S.addToScreen(db, user.user_id, [prompt.message_id]);
    askWaits.set(user.user_id, prompt.message_id);
  });
  bot.callbackQuery('unask', async (ctx) => { // «Geri» under the prompt: cancel the question; the lesson above stays as is
    await ctx.answerCallbackQuery();
    askWaits.delete(ctx.from.id);
    const id = ctx.callbackQuery.message?.message_id;
    if (id) await api.deleteMessage(ctx.from.id, id).catch(() => {});
  });

  bot.callbackQuery('card', (ctx) => ctx.answerCallbackQuery({ text: AZ.card(cfg.ownerContact), show_alert: true }));

  // «Qoşulmaq istəyirəm» / «Geri»: the video stays, only the buttons under it change.
  const switchOfferButtons = (toPay) => async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (user?.stage !== 'offer') return user && showStep(user);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: toPay ? payKeyboard() : offerKeyboard(lessonCount(await loadContent())) });
    } catch (e) {
      if (/message is not modified/.test(describeError(e))) return; // double tap
      await showStep(user, [], { pay: toPay }); // the message is gone: show the lesson again with the right buttons
    }
  };
  bot.callbackQuery('join', switchOfferButtons(true));
  bot.callbackQuery('unjoin', switchOfferButtons(false));

  bot.callbackQuery('paid', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (!user) return;
    const moved = user.stage === 'offer' ? await S.setStage(db, user.user_id, 'receipt', null, user) : null;
    const now = moved ?? user;
    const editId = editable(ctx, user);
    if (now.stage === 'receipt' && editId) {
      // the last lesson stays on screen: its buttons become «⬅️ Geri», «send the receipt» is a small message under it
      try {
        await api.editMessageReplyMarkup(now.user_id, editId, { reply_markup: new InlineKeyboard().text(AZ.backBtn, 'back') });
      } catch (e) {
        if (/message is not modified/.test(describeError(e))) return;
        return showStep(now, [], { editId });
      }
      return say(now.user_id, AZ.askReceipt);
    }
    await showStep(now, [], { editId });
  });

  bot.callbackQuery('back', async (ctx) => { // from «send the receipt» back to the last lesson with payment buttons
    await ctx.answerCallbackQuery();
    const user = await S.getUser(db, ctx.from.id);
    if (!user) return;
    const moved = user.stage === 'receipt' ? await S.setStage(db, user.user_id, 'offer', null, user) : null;
    await showStep(moved ?? user, [], { pay: true, editId: editable(ctx, user) });
  });

  // ---- owner ----

  const ownerCommand = (name, fn) => bot.command(name, async (ctx, next) => {
    if (!isOwner(ctx) || ctx.chat.type !== 'private') return next();
    await fn(ctx, (ctx.match ?? '').trim().toLowerCase());
  });

  ownerCommand('help', () => toOwner(RU.help));
  ownerCommand('set', async (ctx, arg) => {
    if (!SLOT_RE.test(arg)) return toOwner(RU.setUsage);
    ownerWaits.set(ctx.from.id, { slot: arg });
    await toOwner(RU.waiting(arg));
  });
  ownerCommand('cancel', async (ctx) => {
    ownerWaits.delete(ctx.from.id);
    pendingBroadcast = null;
    await toOwner(RU.cancelled);
  });

  // ---- broadcast: /broadcast <segment> → owner's message → preview → «Отправить» ----

  /** Owner chose who gets the broadcast → wait for the message (text, voice, video, photo…). */
  async function chooseSegment(ownerId, segment) {
    const n = (await S.segmentUsers(db, segment)).length;
    if (!n) return toOwner(RU.bcEmpty(segment));
    ownerWaits.set(ownerId, { segment });
    await toOwner(RU.bcWaiting(segment, n));
  }

  // /broadcast → buttons «Урок N · count», «💳 Оплата · n», «✅ Оплатили · n», «👥 Все · n»; /broadcast 2 | offer … still works.
  ownerCommand('broadcast', async (ctx, arg) => {
    if (arg) return S.isSegment(arg) ? chooseSegment(ctx.from.id, arg) : toOwner(RU.bcUsage);
    const [c, content] = await Promise.all([S.segmentCounts(db), loadContent()]);
    const kb = new InlineKeyboard();
    const total = Math.max(lessonCount(content), ...Object.keys(c).filter((k) => /^\d$/.test(k)).map(Number));
    for (let n = 1; n <= total; n++) {
      kb.text(RU.bcLessonBtn(n, c[String(n)] ?? 0), `bcs:${n}`);
      if (n % 2 === 0) kb.row();
    }
    kb.row().text(RU.bcOfferBtn(c.offer), 'bcs:offer').text(RU.bcPaidBtn(c.paid), 'bcs:paid').row().text(RU.bcAllBtn(c.all), 'bcs:all');
    await toOwner(RU.bcPick, { reply_markup: kb });
  });

  bot.callbackQuery(/^bcs:([1-9]|offer|paid|all)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isOwner(ctx)) return;
    await chooseSegment(ctx.from.id, ctx.match[1]);
  });

  async function prepareBroadcast(ctx, segment) {
    ownerWaits.delete(ctx.from.id);
    pendingBroadcast = { id: ++bcSeq, chatId: ctx.chat.id, msgId: ctx.message.message_id, segment };
    const n = (await S.segmentUsers(db, segment)).length;
    await api.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id, { protect_content: true });
    await toOwner(RU.bcPreview(segment, n), {
      reply_markup: new InlineKeyboard().text(RU.bcGo, `bc:go:${bcSeq}`).text(RU.bcNo, `bc:no:${bcSeq}`),
    });
  }

  /** Sends the broadcast one by one (≈20 per second); resolves with counts. */
  async function runBroadcast({ chatId, msgId, segment }) {
    let sent = 0, blocked = 0, failed = 0;
    for (const userId of await S.segmentUsers(db, segment)) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await api.copyMessage(userId, chatId, msgId, { protect_content: true });
          sent++;
          break;
        } catch (e) {
          if (isBlocked(e)) { blocked++; await S.setBlocked(db, userId); break; }
          const wait = e?.parameters?.retry_after; // Telegram «too many requests»: wait and retry once
          if (wait && attempt === 1) { await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
          failed++;
          console.error(`[broadcast] ${userId}: ${describeError(e)}`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await toOwner(RU.bcDone(sent, blocked, failed));
    return { sent, blocked, failed };
  }

  bot.callbackQuery(/^bc:(go|no):(\d+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const job = pendingBroadcast;
    if (!job || job.id !== Number(ctx.match[2])) return ctx.answerCallbackQuery({ text: RU.bcGone });
    pendingBroadcast = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (ctx.match[1] === 'no') return toOwner(RU.cancelled);
    await toOwner(RU.bcStarted((await S.segmentUsers(db, job.segment)).length));
    // In the background: the bot keeps answering students while the broadcast runs.
    app.lastBroadcast = runBroadcast(job).catch((e) => console.error(`[broadcast] ${describeError(e)}`));
  });

  ownerCommand('task', async (ctx, arg) => {
    if (!/^[1-9]$/.test(arg)) return toOwner(RU.taskUsage);
    const on = await S.toggleTask(db, arg);
    resetContent();
    await toOwner(on === null ? RU.taskNoLesson(arg) : RU.taskState(arg, on));
  });
  ownerCommand('swap', async (ctx, arg) => {
    const m = arg.match(/^([1-9])\s+([1-9])$/);
    if (!m || m[1] === m[2]) return toOwner(RU.swapUsage);
    const moved = await S.swapContent(db, m[1], m[2]);
    resetContent();
    if (!moved) return toOwner(RU.swapNothing(m[1], m[2]));
    const content = await loadContent();
    await toOwner(RU.swapped(m[1], m[2]) + '\n\n' + RU.lessons(content, lessonCount(content), []));
  });

  ownerCommand('show', async (ctx, arg) => {
    if (!SLOT_RE.test(arg)) return toOwner(RU.showUsage);
    const content = await loadContent();
    const c = content.find((x) => x.slot === arg);
    if (c) {
      const total = lessonCount(content);
      const last = arg === String(total);
      const kb = arg === 'welcome' ? beginKeyboard() : last ? offerKeyboard(total) : lessonKeyboard(Number(arg), c);
      const head = arg === 'welcome' || Number(arg) > total ? null : AZ.progress(Number(arg), total);
      await sendContent(ctx.chat.id, withHead(c, head), kb);
      if (c.has_task) await ctx.reply(AZ.taskHint, { parse_mode: 'HTML' });
      return;
    }
    if (arg !== 'welcome') return toOwner(RU.notSet(arg));
    await sendContent(ctx.chat.id, { html: AZ.welcome(ctx.from.first_name) }, beginKeyboard());
    await toOwner(RU.defaultShown(arg));
  });
  ownerCommand('lessons', async () => {
    const content = await loadContent();
    await toOwner(RU.lessons(content, lessonCount(content), cfg.warnings));
  });
  ownerCommand('stats', async () => {
    members.at = 0; // the owner wants the exact number now
    const [s, n] = await Promise.all([S.stats(db), groupMembers()]);
    await toOwner(RU.stats(s, { configured: !!cfg.groupId, n, min: GROUP_COUNT_MIN }));
  });
  ownerCommand('reset', async (ctx) => {
    await S.deleteUser(db, ctx.from.id);
    await toOwner(RU.reset);
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery(/^rc:(ok|no):(\d+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const ok = ctx.match[1] === 'ok';
    const id = Number(ctx.match[2]);
    const receipt = await S.getReceipt(db, id);
    if (!receipt || receipt.status !== 'pending') return ctx.answerCallbackQuery({ text: RU.alreadyDecided });

    let link = null;
    if (ok) { // create the invite link first: if that fails, the receipt stays pending and the owner can retry
      if (!cfg.groupId) { await ctx.answerCallbackQuery(); return toOwner(RU.noGroup); }
      try {
        link = (await api.createChatInviteLink(cfg.groupId, { creates_join_request: true, name: `id ${receipt.user_id}` })).invite_link;
      } catch (e) {
        await ctx.answerCallbackQuery();
        return toOwner(RU.linkFailed(describeError(e)));
      }
    }
    const userId = await S.decideReceipt(db, id, ok ? 'approved' : 'rejected', link); // + student's stage, atomically
    if (!userId) return ctx.answerCallbackQuery({ text: RU.alreadyDecided });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text(ok ? RU.approvedMark : RU.rejectedMark, 'noop'),
    }).catch(() => {});

    const user = await S.getUser(db, userId);
    try {
      if (ok) await showStep(user);
      // rejected: ONE message «Ödəniş təsdiqlənmədi» with the payment buttons under it — the last lesson is not sent again
      else await showScreen(userId, [{ text: AZ.rejected, extra: { parse_mode: 'HTML', reply_markup: rejectKeyboard() } }]);
    } catch (e) {
      if (isBlocked(e)) await S.setBlocked(db, userId);
      else throw e;
    }
    await toOwner(ok ? RU.approvedDone(user) : RU.rejectedDone(user));
  });

  // ---- group: join requests and «bot added to a chat» ----

  bot.on('chat_join_request', async (ctx) => {
    const req = ctx.chatJoinRequest;
    if (req.chat.id !== cfg.groupId) return;
    const user = await S.getUser(db, req.from.id);
    if (user?.stage !== 'paid') return; // a stranger: left pending, the owner decides in Telegram
    await api.approveChatJoinRequest(req.chat.id, req.from.id);
    members.at = 0; // a new student joined: recount next time
    await api.sendMessage(req.user_chat_id, AZ.joined).catch(() => {});
    await toOwner(RU.joined(user));
  });

  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member: m } = ctx.myChatMember;
    if (chat.type === 'private' || !['member', 'administrator'].includes(m.status)) return;
    await toOwner(RU.addedToChat(chat.title ?? '', chat.id, m.status === 'administrator'));
  });

  // ---- any other private message ----

  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const m = ctx.message;

    // Owner answers a student: «Reply» on a task video / receipt in the owner's chat (before /set waits: a reply is never a lesson).
    if (isOwner(ctx) && m.reply_to_message) {
      const row = await S.userForOwnerMsg(db, m.reply_to_message.message_id);
      if (row) {
        const target = row.user_id;
        // The answer QUOTES the student's own question (reply to it), so he sees what was answered.
        // Neither is part of a screen → never deleted by the bot.
        const quote = row.student_msg_id ? { reply_parameters: { message_id: row.student_msg_id, allow_sending_without_reply: true } } : {};
        try {
          await api.copyMessage(target, ctx.chat.id, m.message_id, { protect_content: true, ...quote });
        } catch (e) {
          if (!isBlocked(e)) throw e;
          await S.setBlocked(db, target);
          return toOwner(RU.replyBlocked);
        }
        return toOwner(RU.replySent);
      }
    }

    if (isOwner(ctx) && ownerWaits.has(ctx.from.id)) {
      const wait = ownerWaits.get(ctx.from.id);
      if (wait.segment) return prepareBroadcast(ctx, wait.segment);
      const c = extractContent(m);
      if (!c) return toOwner(RU.unsupported);
      if (c.kind !== 'text' && c.text.length > CAPTION_MAX) return toOwner(RU.captionTooLong(c.text.length)); // Premium allows longer
      await S.saveContent(db, wait.slot, c);
      resetContent();
      ownerWaits.delete(ctx.from.id);
      return toOwner(RU.saved(wait.slot, c.kind));
    }

    if (m.media_group_id && !firstOfAlbum(ctx.from.id, m.media_group_id)) return; // album: one message counts, not each

    const user = await S.touchUser(db, ctx.from);
    if (!user) { // wrote before /start
      const { user: created } = await S.startUser(db, ctx.from, null);
      return atEntry(created) ? showWelcome(ctx.chat.id, ctx.from.first_name) : showStep(created);
    }

    const promptId = askWaits.get(user.user_id);
    if (promptId !== undefined) { // after «❓ Sual ver»: this message is the question → owner (answers with «Reply»)
      askWaits.delete(user.user_id);
      const where = user.stage === 'lesson' ? `урок ${user.lesson}` : user.stage === 'offer' ? `последний урок ${user.lesson}` : 'после уроков';
      await remember(await toOwner(RU.question(user, where)), user.user_id, m.message_id);
      await remember(await api.forwardMessage(cfg.ownerId, ctx.chat.id, m.message_id), user.user_id, m.message_id);
      // the prompt itself turns into «✅ Sualın göndərildi» (no new message, no «Geri» left behind)
      return api.editMessageText(user.user_id, promptId, AZ.askSent).catch(() => say(user.user_id, AZ.askSent));
    }

    const content = await loadContent();
    const current = content.find((c) => c.slot === String(user.lesson));
    const taskOpen = current?.has_task && (user.stage === 'lesson' || user.stage === 'offer');
    if (taskOpen && isTaskVideo(m)) { // task video → owner; next lesson opens (on the last lesson: stays with payment)
      await S.logEvent(db, user.user_id, 'task_done', user.lesson);
      await remember(await toOwner(RU.task(user, user.lesson)), user.user_id, m.message_id);
      await remember(await api.forwardMessage(cfg.ownerId, ctx.chat.id, m.message_id), user.user_id, m.message_id);
      return user.stage === 'lesson'
        ? advance(user, [], { accepted: true })
        : say(user.user_id, AZ.taskAcceptedLast, { parse_mode: 'HTML' });
    }
    if (user.stage === 'lesson' && current?.has_task) { // sent something else instead of the task video → remember what
      await S.logEvent(db, user.user_id, 'task_wrong', user.lesson, wrongTaskKind(m));
      return say(user.user_id, AZ.needVideo, { reply_markup: hintKeyboard() });
    }
    if (user.stage === 'lesson') return say(user.user_id, AZ.useButtons, { reply_markup: hintKeyboard() });

    if ((user.stage === 'offer' || user.stage === 'receipt') && isReceipt(m)) {
      const moved = await S.setStage(db, user.user_id, 'review', null, user);
      if (!moved) return;
      const id = await S.createReceipt(db, user.user_id);
      let copy;
      try {
        copy = await api.copyMessage(cfg.ownerId, ctx.chat.id, m.message_id, {
          caption: RU.receipt(user, id),
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(RU.approveBtn, `rc:ok:${id}`).text(RU.rejectBtn, `rc:no:${id}`),
        });
      } catch (e) { // the owner never got it: undo, so the student is not stuck in 'review' and can send it again
        await S.cancelReceipt(db, id, user.user_id, user.stage);
        throw e;
      }
      await remember(copy, user.user_id, m.message_id);
      await S.setReceiptOwnerMsg(db, id, copy.message_id);
      return showScreen(user.user_id, [{ text: AZ.receiptSent, extra: { parse_mode: 'HTML', reply_markup: navRow(new InlineKeyboard()) } }]);
    }
    if (user.stage === 'receipt') return say(user.user_id, AZ.receiptOnlyMedia);
    if (user.stage === 'offer') return say(user.user_id, AZ.useButtons, { reply_markup: hintKeyboard() });
    return showStep(user); // review / paid
  });

  // Any failure while handling an update → the owner learns what broke and for whom (same error: once per 30 min).
  bot.catch((err) => alerter.alert(`handler:${describeError(err.error).slice(0, 80)}`, 'Ошибка при обработке действия', err.error, describeUpdate(err.ctx)));

  // ---- reminders ----

  /** Sends due reminders (called every 15 min). Returns how many were sent to students. */
  async function remindTick(now = new Date()) {
    const h = bakuHour(now);
    if (h < REMIND_HOURS[0] || h >= REMIND_HOURS[1]) return 0;

    for (const r of await S.takeStaleReceipts(db)) { // receipts waiting for the owner > 2 h: remind once
      const u = await S.getUser(db, r.user_id);
      const reply = r.owner_msg_id ? { reply_parameters: { message_id: r.owner_msg_id, allow_sending_without_reply: true } } : {};
      await toOwner(RU.receiptReminder(u, r.id), reply).catch((e) => console.error(`[remind] owner: ${describeError(e)}`));
    }

    const content = await loadContent();
    const total = lessonCount(content);
    let sent = 0;
    for (const u of await S.dueReminders(db)) {
      if (total === 0) break;
      const task = u.stage === 'lesson' && content.find((c) => c.slot === String(u.lesson))?.has_task;
      const text = AZ.remind[task ? 'task' : u.stage][u.reminders];
      // stuck on a task for a day (every reminder comes after ≥ 1 day) → also «⏭ Tapşırıqsız davam et»
      const reply_markup = task ? resumeKeyboard().row().text(AZ.skipBtn, `skip:${u.lesson}`) : resumeKeyboard();
      try {
        await say(u.user_id, text, { reply_markup });
        sent++;
      } catch (e) {
        if (isBlocked(e)) { await S.setBlocked(db, u.user_id); continue; }
        console.error(`[remind] ${u.user_id}: ${describeError(e)}`);
        continue; // network trouble: try again next tick
      }
      await S.markReminded(db, u.user_id);
      await new Promise((r) => setTimeout(r, 50)); // stay far below Telegram limits
    }
    return sent;
  }

  /** «/» menu: students see only /start; the owner sees all management commands. */
  async function setupCommands() {
    await api.setMyCommands([{ command: 'start', description: 'Pulsuz dərslərə başla' }]);
    await api.setMyCommands(RU.menu, { scope: { type: 'chat', chat_id: cfg.ownerId } })
      .catch((e) => console.warn(`[main] owner menu not set (write /start to the bot first): ${describeError(e)}`));
  }

  // ---- health: heartbeat every minute, report downtime on start ----

  /** Every minute: «I am alive» into the DB. A failure = no DB connection → owner alert; recovery → «restored». */
  async function heartbeat(now = new Date()) {
    try {
      await S.setHealth(db, 'heartbeat', { at: now.toISOString() });
      await alerter.resolved('db', 'Связь с базой данных восстановлена, бот работает.');
    } catch (e) {
      await alerter.alert('db', 'Нет связи с базой данных', e, 'проверка связи (раз в минуту)');
    }
  }

  /** On start: tells the owner the bot is up and, if it was down, since when and why. */
  async function startupReport(now = new Date()) {
    const h = await S.getHealth(db);
    await S.setHealth(db, 'heartbeat', { at: now.toISOString() });
    await toOwner(RU.startup(h, now)).catch((e) => console.error(`[main] startup report: ${describeError(e)}`));
  }

  /** Graceful stop / fatal error: remembered so the next start explains the downtime. */
  const recordStop = (reason, now = new Date()) => S.setHealth(db, 'stop', { at: now.toISOString(), reason });

  const app = {
    bot, remindTick, setupCommands, heartbeat, startupReport, recordStop, lastBroadcast: null,
    alert: (...a) => alerter.alert(...a),
  };
  return app;
}
