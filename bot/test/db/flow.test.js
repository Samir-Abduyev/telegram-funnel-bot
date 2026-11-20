// Full funnel with a fake Telegram on a THROWAWAY local Postgres (schema `funnel` is dropped!).
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres npm run test:db
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GrammyError } from 'grammy';
import { createApp } from '../../src/app.js';
import { AZ } from '../../src/texts_az.js';
import { RU } from '../../src/texts_owner.js';

const SQL_DIR = fileURLToPath(new URL('../../../sql/', import.meta.url));
const OWNER = 111;
const STUDENT = 222;
const GROUP = -1009999;
const cfg = {
  token: '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake12', ownerId: OWNER, ownerContact: '@owner',
  groupId: GROUP, paymentUrl: 'https://pay.example/x', warnings: [],
};
const BOT_INFO = { id: 999, is_bot: true, first_name: 'Funnel', username: 'funnel_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
const ADMIN_URL = 'https://t.me/owner';

let db;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to a throwaway LOCAL Postgres');
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Refusing to drop schema on a non-local host');
  db = new pg.Pool({ connectionString: url, max: 4 });
});
after(() => db.end());

async function fresh(extraCfg = {}, { fail = () => null, wrapDb = (x) => x } = {}) {
  await db.query('DROP SCHEMA IF EXISTS funnel CASCADE');
  for (const f of readdirSync(SQL_DIR).filter((x) => /^\d{3}_.+\.sql$/.test(x)).sort()) {
    const sql = readFileSync(SQL_DIR + f, 'utf8');
    await db.query(sql);
    await db.query(sql); // must be re-runnable
  }
  const app = createApp({ ...cfg, ...extraCfg }, wrapDb(db), { botInfo: BOT_INFO });
  const calls = [];
  let mid = 100;
  const blocked = new Set();
  const group = { members: 3, admins: 2 }; // by default 1 student: below the threshold, students see no counter
  const kinds = new Map(); // message_id → 'text' | 'media'
  app.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const err = fail(method, payload);
    if (err) throw err;
    if (blocked.has(payload.chat_id)) throw new GrammyError('Forbidden', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, method, payload);
    if (method === 'createChatInviteLink') return { ok: true, result: { invite_link: 'https://t.me/+join', creates_join_request: true } };
    if (method === 'getChatMemberCount') return { ok: true, result: group.members };
    if (method === 'getChatAdministrators') return { ok: true, result: Array.from({ length: group.admins }, (_, i) => ({ status: 'administrator', user: { id: i + 1, is_bot: false, first_name: 'A' } })) };
    // Like real Telegram: a text message cannot become a video and vice versa.
    const bad = (d) => { throw new GrammyError(`Call to '${method}' failed!`, { ok: false, error_code: 400, description: `Bad Request: ${d}` }, method, payload); };
    if (method === 'editMessageText' && kinds.get(payload.message_id) === 'media') bad('there is no text in the message to edit');
    if (method === 'editMessageMedia' && kinds.get(payload.message_id) === 'text') bad('there is no media in the message to edit');
    if (/^(send|copy|forward)/.test(method)) {
      kinds.set(++mid, method === 'sendMessage' ? 'text' : 'media');
      return { ok: true, result: { message_id: mid, date: 0, chat: { id: payload.chat_id, type: 'private' } } };
    }
    return { ok: true, result: true };
  });
  let uid = 0;
  const from = (id) => ({ id, is_bot: false, first_name: id === OWNER ? 'Owner' : 'Aynur', username: id === OWNER ? 'owner' : 'aynur' });
  const msg = (id, extra) => ({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id, type: 'private' }, from: from(id), ...extra } });
  const cmd = (id, text) => msg(id, { text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] });
  // msgId = the message the button is on (default 1 = not on the screen → the bot sends a new screen instead of editing)
  const cb = (id, data, msgId = 1) => ({ update_id: ++uid, callback_query: { id: String(++uid), from: from(id), chat_instance: 'x', data, message: { message_id: msgId, date: 0, chat: { id, type: 'private' } } } });
  const handle = async (u) => { const n = calls.length; await app.bot.handleUpdate(u); return calls.slice(n); };
  /** what the person sees: sends/copies/forwards (no deletes, no callback answers) */
  const shown = async (u) => (await handle(u)).filter((c) => !['deleteMessage', 'answerCallbackQuery', 'getChatMemberCount', 'getChatAdministrators'].includes(c.method));
  /** /start + «▶️ Pulsuz dərslərə başla» */
  const start = async (id) => { await handle(cmd(id, '/start')); await handle(cb(id, 'begin')); };
  return { app, calls, handle, shown, msg, cmd, cb, blocked, from, start, group };
}

const kb = (call) => (call.payload.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.url ?? b.callback_data);
const screenIds = async (id) => (await db.query('SELECT screen_ids FROM funnel.users WHERE user_id = $1', [id])).rows[0].screen_ids.map(Number);
const stage = async (id) => (await db.query('SELECT stage, lesson FROM funnel.users WHERE user_id = $1', [id])).rows[0];
// last lesson n, view 1: join / question + admin / navigation last (prev + lessons from lesson 2, else lessons)
const PAY = (n) => (n > 1 ? ['join', 'ask', ADMIN_URL, `ls:${n - 1}`, 'menu'] : ['join', 'ask', ADMIN_URL, 'menu']);
const PAYV = ['https://pay.example/x', ADMIN_URL, 'paid', 'unjoin']; // view 2 after «Qoşulmaq istəyirəm»

/** Owner sets 3 lessons (lesson 2 with a task). Lesson 3 is the last one → payment buttons under it. */
async function setupLessons(t) {
  for (const n of ['1', '2', '3']) {
    await t.handle(t.cmd(OWNER, `/set ${n}`));
    const out = await t.handle(t.msg(OWNER, { video: { file_id: `VID${n}` }, caption: `Dərs ${n}\nmətn` }));
    assert.equal(out[0].payload.text, RU.saved(n, 'video'));
  }
  assert.equal((await t.handle(t.cmd(OWNER, '/task 2')))[0].payload.text, RU.taskState('2', true));
}

test('whole funnel: one clean screen, lessons menu, payment under the last lesson, group', async () => {
  const t = await fresh();
  await setupLessons(t);

  // /start → ONLY the greeting with one button «Başla» (no admin, no menu); the /start message itself is deleted
  let all = await t.handle(t.cmd(STUDENT, '/start kanal'));
  assert.ok(all.some((c) => c.method === 'deleteMessage' && c.payload.chat_id === STUDENT));
  let out = all.filter((c) => c.method !== 'deleteMessage');
  assert.equal(out.length, 1);
  assert.match(out[0].payload.text, /pulsuz video dərslər/);
  assert.deepEqual(kb(out[0]), ['begin']);
  const welcomeScreen = await screenIds(STUDENT);

  // «Başla» → the greeting disappears, lesson 1 with only «Növbəti dərs» (no menu yet: nothing passed, no admin)
  all = await t.handle(t.cb(STUDENT, 'begin'));
  assert.deepEqual(all.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id), welcomeScreen);
  out = all.filter((c) => !['deleteMessage', 'answerCallbackQuery', 'getChatMemberCount', 'getChatAdministrators'].includes(c.method));
  assert.equal(out[0].payload.video, 'VID1');
  assert.equal(out[0].payload.protect_content, true);
  assert.equal(out[0].payload.caption, 'Dərs 1/3\n\nDərs 1\nmətn'); // progress on top, the owner's caption below
  assert.deepEqual(out[0].payload.caption_entities[0], { type: 'bold', offset: 0, length: 8 });
  assert.deepEqual(kb(out[0]), ['done:1', 'ask']);
  const firstScreen = await screenIds(STUDENT);
  assert.equal(firstScreen.length, 1);

  // Next → lesson 1 deleted, lesson 2 (task: no Next) + «📚 Dərslər» (passed lessons) + hint; still no admin button
  all = await t.handle(t.cb(STUDENT, 'done:1'));
  const deleted = all.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id);
  assert.deepEqual(deleted.sort(), firstScreen.sort());
  out = all.filter((c) => !['deleteMessage', 'answerCallbackQuery', 'getChatMemberCount', 'getChatAdministrators'].includes(c.method));
  assert.equal(out[0].payload.video, 'VID2');
  assert.deepEqual(kb(out[0]), ['task:2', 'ask', 'ls:1', 'menu']); // «📤 Tapşırığı göndər», question, navigation last
  assert.equal(out[0].payload.reply_markup.inline_keyboard[0][0].text, AZ.sendTaskBtn);
  all = await t.handle(t.cb(STUDENT, 'task:2')); // → a pop-up how to send the video; nothing added to the chat
  assert.equal(all.length, 1);
  assert.equal(all[0].method, 'answerCallbackQuery');
  assert.equal(all[0].payload.show_alert, true);
  assert.equal(all[0].payload.text, AZ.sendTaskHow);
  out = await t.shown(t.cb(STUDENT, 'menu')); // only PASSED lessons: lesson 1
  assert.deepEqual(kb(out[0]), ['ls:1', 'resume']);
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'ls:2')), []); // the current lesson is not in the knowledge base
  out = await t.shown(t.cb(STUDENT, 'resume'));
  assert.equal(out[0].payload.video, 'VID2');
  assert.match(out[0].payload.caption, /^Dərs 2\/3\n\n/);
  assert.equal(out[1].payload.text, AZ.taskHint);
  assert.equal(out[1].payload.parse_mode, 'HTML');
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'done:1')), []); // double tap: nothing

  // text instead of the task video → hint; the video → owner gets it → «Tapşırığın qəbul edildi!» + «➡️ Növbəti dərs»
  out = await t.shown(t.msg(STUDENT, { text: 'salam' }));
  assert.equal(out[0].payload.text, AZ.needVideo);
  out = await t.shown(t.msg(STUDENT, { video: { file_id: 'STUDENT_VID' } }));
  assert.match(out[0].payload.text, /Задание к уроку 2/);
  assert.equal(out[1].method, 'forwardMessage');
  assert.equal(out[2].payload.text, AZ.taskAccepted);
  assert.equal(out[2].payload.parse_mode, 'HTML');
  assert.deepEqual(kb(out[2]), ['resume']);
  assert.equal(out[2].payload.reply_markup.inline_keyboard[0][0].text, AZ.nextBtn);
  assert.equal(out.length, 3); // the next lesson is NOT shown yet
  assert.deepEqual(await stage(STUDENT), { stage: 'offer', lesson: 3 }); // …but the progress is already saved
  out = await t.shown(t.cb(STUDENT, 'resume')); // «➡️ Növbəti dərs» → lesson 3 = last → payment buttons
  assert.equal(out[0].payload.video, 'VID3');
  assert.match(out[0].payload.caption, /^Dərs 3\/3\n\n/);
  assert.deepEqual(kb(out[0]), PAY(3));
  assert.equal(out[0].payload.reply_markup.inline_keyboard[0][0].text, AZ.wantJoinBtn);

  // lessons menu: «Dərs N/M», re-watch lesson 2 («Davam et» first, «Geri» = back to the list), back to the current step
  out = await t.shown(t.cb(STUDENT, 'menu'));
  assert.deepEqual(kb(out[0]), ['ls:1', 'ls:2', 'ls:3', 'resume']);
  assert.equal(out[0].payload.reply_markup.inline_keyboard[1][0].text, 'Dərs 2/3');
  out = await t.shown(t.cb(STUDENT, 'ls:2'));
  assert.equal(out[0].payload.video, 'VID2');
  assert.match(out[0].payload.caption, /^Dərs 2\/3\n\n/);
  assert.deepEqual(kb(out[0]), ['ls:3', 'resume', 'ask', 'ls:1', 'menu']);
  assert.deepEqual(out[0].payload.reply_markup.inline_keyboard[0].map((b) => b.text), [AZ.nextBtn]); // next first
  assert.deepEqual(out[0].payload.reply_markup.inline_keyboard[3].map((b) => b.text), [AZ.prevBtn, AZ.menuBtn]);
  out = await t.shown(t.cb(STUDENT, 'resume'));
  assert.deepEqual(kb(out[0]), PAY(3));

  // «Qoşulmaq istəyirəm» → the SAME video message, only its buttons change (online / card = owner's chat / Ödədim / Geri)
  all = await t.handle(t.cb(STUDENT, 'join'));
  out = all.filter((c) => c.method !== 'answerCallbackQuery');
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'editMessageReplyMarkup');
  assert.deepEqual(kb(out[0]), PAYV);
  all = await t.handle(t.cb(STUDENT, 'unjoin')); // «Geri» → back to view 1, still no new message
  assert.equal(all.filter((c) => c.method !== 'answerCallbackQuery')[0].method, 'editMessageReplyMarkup');
  assert.deepEqual(kb(all.at(-1)), PAY(3));
  await t.handle(t.cb(STUDENT, 'join'));

  // «Ödədim» → receipt screen with «Geri»; Geri → back to the last lesson with the payment buttons; again «Ödədim»
  out = await t.shown(t.cb(STUDENT, 'paid'));
  assert.equal(out[0].payload.text, AZ.askReceipt);
  assert.deepEqual(kb(out[0]), ['back']);
  out = await t.shown(t.cb(STUDENT, 'back'));
  assert.deepEqual(kb(out[0]), PAYV);
  await t.handle(t.cb(STUDENT, 'paid'));
  out = await t.shown(t.msg(STUDENT, { text: 'ödədim' }));
  assert.equal(out[0].payload.text, AZ.receiptOnlyMedia);
  out = await t.shown(t.msg(STUDENT, { photo: [{ file_id: 'RC' }] }));
  assert.equal(out[0].method, 'copyMessage');
  assert.equal(out[0].payload.chat_id, OWNER);
  assert.deepEqual(kb(out[0]), ['rc:ok:1', 'rc:no:1']);
  assert.equal(out[1].payload.text, AZ.receiptSent);
  out = await t.shown(t.msg(STUDENT, { text: '?' }));
  assert.equal(out[0].payload.text, AZ.underReview);

  // a student cannot approve; the owner approves → join-request link → the student's screen gets the join button
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'rc:ok:1')), []);
  out = await t.shown(t.cb(OWNER, 'rc:ok:1'));
  const link = out.find((c) => c.method === 'createChatInviteLink');
  assert.equal(link.payload.chat_id, GROUP);
  assert.equal(link.payload.creates_join_request, true);
  const toStudent = out.find((c) => c.payload.chat_id === STUDENT && c.method === 'sendMessage');
  assert.equal(toStudent.payload.text, AZ.approved);
  assert.deepEqual(kb(toStudent), ['https://t.me/+join', 'ls:1', 'menu', ADMIN_URL]);
  out = await t.handle(t.cb(OWNER, 'rc:ok:1'));
  assert.equal(out[0].payload.text, RU.alreadyDecided);

  // after paying: «🎬 Dərslərə yenidən bax» → lesson 1 → «➡️ Növbəti dərs» → 2 → 3 (all of them in a row, not thrown back)
  out = await t.shown(t.cmd(STUDENT, '/start'));
  assert.equal(out[0].payload.text, AZ.approved);
  assert.equal(out[0].payload.reply_markup.inline_keyboard[1][0].text, AZ.rewatchBtn);
  for (const [n, next] of [[1, 'ls:2'], [2, 'ls:3']]) {
    out = await t.shown(t.cb(STUDENT, `ls:${n}`));
    assert.equal(out[0].payload.video, `VID${n}`);
    assert.equal(kb(out[0])[0], next);
  }
  out = await t.shown(t.cb(STUDENT, 'ls:3'));
  assert.equal(out[0].payload.video, 'VID3');
  assert.deepEqual(kb(out[0]), ['resume', 'ask', 'ls:2', 'menu']); // the last one: no «Növbəti»
  assert.equal((await stage(STUDENT)).stage, 'paid'); // re-watching never touches the payment

  // join request: the paid student is approved, a stranger is left for the owner
  const join = (id) => ({ update_id: Date.now(), chat_join_request: { chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: t.from(id), user_chat_id: id, date: 0 } });
  out = await t.handle(join(STUDENT));
  assert.equal(out[0].method, 'approveChatJoinRequest');
  assert.deepEqual(await t.handle(join(333)), []);

  out = await t.shown(t.cmd(OWNER, '/stats'));
  assert.match(out[0].payload.text, /Оплатили: <b>1<\/b>/);
  assert.match(out[0].payload.text, /kanal: 1 → 1 → 1/);
});

test('single lesson = payment right away; rejected receipt returns to payment; no GROUP_ID keeps it pending', async () => {
  const t = await fresh({ groupId: null, paymentUrl: '' });
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs 1 mətn' }));
  await t.handle(t.cmd(STUDENT, '/start'));
  let out = await t.shown(t.cb(STUDENT, 'begin'));
  assert.deepEqual(kb(out[0]), PAY(1)); // the only lesson is the last one
  out = await t.shown(t.cb(STUDENT, 'join'));
  assert.deepEqual(kb(out[0]), [ADMIN_URL, 'paid', 'unjoin']); // no PAYMENT_URL → no online button

  out = await t.shown(t.msg(STUDENT, { document: { file_id: 'PDF' } })); // receipt right at the offer
  assert.equal(out[0].method, 'copyMessage');

  out = await t.shown(t.cb(OWNER, 'rc:ok:1'));
  assert.equal(out.find((c) => c.method === 'sendMessage').payload.text, RU.noGroup);
  assert.equal((await db.query('SELECT status FROM funnel.receipts WHERE id = 1')).rows[0].status, 'pending');

  out = await t.shown(t.cb(OWNER, 'rc:no:1'));
  const toStudent = out.filter((c) => c.payload.chat_id === STUDENT);
  assert.equal(toStudent[0].payload.text, AZ.rejected);
  assert.equal(toStudent.length, 1); // ONE message, the last lesson is NOT sent again
  assert.deepEqual(kb(toStudent[0]), [ADMIN_URL, 'paid', 'menu']); // payment buttons right under «Ödəniş təsdiqlənmədi»
  assert.equal((await stage(STUDENT)).stage, 'offer');
});

test('owner tools: /show, /lessons, /task, /reset; non-owner cannot /set', async () => {
  const t = await fresh();
  let out = await t.handle(t.cmd(STUDENT, '/set 1'));
  assert.ok(!out.some((c) => c.payload.text === RU.waiting('1')));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM funnel.content')).rows[0].n, 0);

  out = await t.handle(t.cmd(OWNER, '/show welcome'));
  assert.match(out[0].payload.text, /pulsuz video dərslər/);
  assert.equal(out[1].payload.text, RU.defaultShown('welcome'));
  out = await t.handle(t.cmd(OWNER, '/show offer'));
  assert.equal(out[0].payload.text, RU.showUsage);
  out = await t.handle(t.cmd(OWNER, '/task 1'));
  assert.equal(out[0].payload.text, RU.taskNoLesson('1'));
  out = await t.handle(t.cmd(OWNER, '/lessons'));
  assert.match(out[0].payload.text, /уроков нет/);

  await t.handle(t.cmd(OWNER, '/set 1'));
  out = await t.handle(t.msg(OWNER, { sticker: { file_id: 'S' } }));
  assert.equal(out[0].payload.text, RU.unsupported);
  await t.handle(t.msg(OWNER, { video: { file_id: 'V1' }, caption: 'Hazırlıq günü' }));
  await t.handle(t.cmd(OWNER, '/set 2'));
  await t.handle(t.msg(OWNER, { video: { file_id: 'V2' } }));
  out = await t.handle(t.cmd(OWNER, '/show 2')); // last lesson: shown with the payment buttons
  assert.deepEqual(kb(out[0]), PAY(2));
  out = await t.handle(t.cmd(OWNER, '/lessons'));
  assert.match(out[0].payload.text, /Кнопки оплаты стоят под уроком 2/);

  await t.start(OWNER);
  out = await t.handle(t.cmd(OWNER, '/reset'));
  assert.equal(out[0].payload.text, RU.reset);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM funnel.users WHERE user_id = $1', [OWNER])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM funnel.users')).rows[0].n, 1); // the student is untouched
});

test('reminders: 1 day and 3 days, quiet hours, blocked users, task text; they vanish with the next screen', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.start(STUDENT);
  await t.handle(t.cb(STUDENT, 'done:1')); // now on lesson 2 (task)
  await t.start(444); // second student, will block the bot
  const DAY = "interval '1 day'";
  const age = (sql) => db.query(`UPDATE funnel.users SET stage_at = now() - (${sql}) WHERE user_id <> ${OWNER}`);
  const noon = new Date('2026-11-17T08:00:00Z'); // 12:00 Baku
  const night = new Date('2026-11-17T20:00:00Z'); // 00:00 Baku

  await age("interval '2 hours'");
  assert.equal(await t.app.remindTick(noon), 0);

  await age(`${DAY} + interval '1 minute'`);
  assert.equal(await t.app.remindTick(night), 0);
  t.blocked.add(444);
  const n0 = t.calls.length;
  assert.equal(await t.app.remindTick(noon), 1);
  const sent = t.calls.slice(n0).filter((c) => c.method === 'sendMessage' && c.payload.chat_id === STUDENT);
  assert.equal(sent[0].payload.text, AZ.remind.task[0]);
  assert.equal((await db.query('SELECT blocked FROM funnel.users WHERE user_id = 444')).rows[0].blocked, true);
  assert.equal(await t.app.remindTick(noon), 0); // not twice

  await age(`3 * ${DAY} + interval '1 minute'`);
  assert.equal(await t.app.remindTick(noon), 1);
  assert.equal(t.calls.at(-1).payload.text, AZ.remind.task[1]);
  assert.equal(await t.app.remindTick(noon), 0); // only two reminders per stage

  // the student moves on → reminders start over; the reminder messages are deleted with the old screen
  const before = await screenIds(STUDENT);
  const all = await t.handle(t.msg(STUDENT, { video_note: { file_id: 'N' } }));
  const deleted = all.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id);
  assert.deepEqual(deleted.sort(), before.sort());
  assert.equal((await db.query('SELECT reminders FROM funnel.users WHERE user_id = $1', [STUDENT])).rows[0].reminders, 0);
});

test('«❓ Sual ver»: the question goes to the owner, «Reply» goes back to the student; «Geri» cancels', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.start(STUDENT);

  let out = await t.shown(t.cb(STUDENT, 'ask')); // the lesson stays, the prompt is added under it
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.text, AZ.askPrompt);
  assert.deepEqual(kb(out[0]), ['unask']);
  out = await t.shown(t.msg(STUDENT, { voice: { file_id: 'VOICE_Q' } }));
  assert.match(out[0].payload.text, /Вопрос от .* \(урок 1\)/);
  assert.equal(out[0].payload.chat_id, OWNER);
  assert.equal(out[1].method, 'forwardMessage');
  assert.equal(out[2].payload.text, AZ.askSent);
  assert.equal(out[2].method, 'editMessageText'); // the prompt itself became «Sualın göndərildi» — no new message
  assert.equal(out.length, 3);
  assert.deepEqual(await stage(STUDENT), { stage: 'lesson', lesson: 1 }); // a question does not move the funnel

  const ownerMsgs = (await db.query('SELECT owner_msg_id FROM funnel.owner_msgs ORDER BY owner_msg_id')).rows.map((r) => r.owner_msg_id);
  const question = t.calls.filter((c) => c.method === 'forwardMessage').at(-1).payload.message_id; // the student's own message
  out = await t.shown(t.msg(OWNER, { text: 'Cavab', reply_to_message: { message_id: ownerMsgs[1], date: 0, chat: { id: OWNER, type: 'private' } } }));
  assert.equal(out[0].method, 'copyMessage'); // ONE message: the answer, quoting the question
  assert.equal(out[0].payload.chat_id, STUDENT);
  assert.equal(out[0].payload.reply_parameters.message_id, question);
  assert.equal(out[1].payload.text, RU.replySent);

  out = await t.shown(t.msg(STUDENT, { text: 'sağ ol' })); // the next message is NOT a question again
  assert.equal(out[0].payload.text, AZ.useButtons);
  assert.deepEqual(kb(out[0]), ['ask']); // typing → a short hint with ONE button «❓ Sual ver»

  await t.handle(t.cb(STUDENT, 'ask'));
  const promptId = (await screenIds(STUDENT)).at(-1); // the prompt is the last message of the screen
  const pressGeri = t.cb(STUDENT, 'unask', promptId);
  out = await t.handle(pressGeri); // «Geri» → ONLY the prompt is deleted; the lesson is NOT sent again (no jitter)
  assert.deepEqual(out.filter((c) => c.method !== 'answerCallbackQuery').map((c) => c.method), ['deleteMessage']);
  out = await t.shown(t.msg(STUDENT, { text: 'x' }));
  assert.ok(!out.some((c) => c.payload.chat_id === OWNER));
});

test('«⏮ Əvvəlki dərs» walks back through passed lessons only', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.handle(t.cmd(OWNER, '/task 2')); // lesson 2 without a task for this walk
  await t.start(STUDENT);
  await t.handle(t.cb(STUDENT, 'done:1'));
  await t.handle(t.cb(STUDENT, 'done:2')); // now on the last lesson 3
  let out = await t.shown(t.cb(STUDENT, 'ls:2')); // «⏮ Əvvəlki dərs» under lesson 3
  assert.equal(out[0].payload.video, 'VID2');
  assert.deepEqual(kb(out[0]), ['ls:3', 'resume', 'ask', 'ls:1', 'menu']);
  out = await t.shown(t.cb(STUDENT, 'ls:1')); // and further back to lesson 1: no «⏮» there
  assert.equal(out[0].payload.video, 'VID1');
  assert.deepEqual(kb(out[0]), ['ls:2', 'resume', 'ask', 'menu']);
  out = await t.shown(t.cb(STUDENT, 'resume'));
  assert.equal(out[0].payload.video, 'VID3');
});

test('owner answers a task video with «Reply»; reply to an unrelated message goes nowhere', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.start(STUDENT);
  await t.handle(t.cb(STUDENT, 'done:1'));
  await t.handle(t.msg(STUDENT, { video: { file_id: 'TASK' } }));
  const ownerMsgs = (await db.query('SELECT owner_msg_id FROM funnel.owner_msgs ORDER BY owner_msg_id')).rows.map((r) => r.owner_msg_id);
  assert.equal(ownerMsgs.length, 2); // header + forwarded video

  const taskVideo = t.calls.filter((c) => c.method === 'forwardMessage').at(-1).payload.message_id;
  let out = await t.handle(t.msg(OWNER, { voice: { file_id: 'VOICE' }, reply_to_message: { message_id: ownerMsgs[1], date: 0, chat: { id: OWNER, type: 'private' } } }));
  assert.equal(out[0].payload.chat_id, STUDENT);
  assert.equal(out[0].method, 'copyMessage');
  assert.equal(out[0].payload.reply_parameters.message_id, taskVideo); // the answer quotes the student's task video
  assert.equal(out[0].payload.protect_content, true); // the owner's answer cannot be saved / forwarded either
  assert.equal(out[1].payload.text, RU.replySent);

  out = await t.handle(t.msg(OWNER, { text: 'x', reply_to_message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' } } }));
  assert.ok(!out.some((c) => c.payload.chat_id === STUDENT));
});

test('owner is reminded once about a receipt waiting > 2 hours (only in the daytime)', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs' }));
  await t.start(STUDENT);
  const out = await t.shown(t.msg(STUDENT, { photo: [{ file_id: 'RC' }] }));
  const copyId = (await db.query('SELECT owner_msg_id FROM funnel.receipts WHERE id = 1')).rows[0].owner_msg_id;
  assert.ok(copyId && out[0].method === 'copyMessage');

  const noon = new Date('2026-11-17T08:00:00Z');
  const ownerReminders = () => t.calls.filter((c) => c.payload.chat_id === OWNER && /ждёт вашего решения/.test(c.payload.text ?? ''));
  await t.app.remindTick(noon);
  assert.equal(ownerReminders().length, 0); // too fresh
  await db.query("UPDATE funnel.receipts SET created_at = now() - interval '3 hours'");
  await t.app.remindTick(new Date('2026-11-17T20:00:00Z'));
  assert.equal(ownerReminders().length, 0); // night in Baku
  await t.app.remindTick(noon);
  await t.app.remindTick(noon);
  assert.equal(ownerReminders().length, 1);
  assert.equal(ownerReminders()[0].payload.reply_parameters.message_id, copyId);
});

test('task lesson: what students send instead of the video is recorded; «⏭ Tapşırıqsız davam et» only after a day', async () => {
  const t = await fresh();
  await setupLessons(t); // 1, 2 (task), 3
  await t.start(STUDENT);
  await t.handle(t.cb(STUDENT, 'done:1')); // now on lesson 2 (task)

  // wrong formats: each answered «send a video», each recorded with its type
  for (const m of [{ text: 'salam' }, { text: 'https://claude.ai/artifact/x', entities: [{ type: 'url', offset: 0, length: 28 }] },
    { photo: [{ file_id: 'P' }] }, { document: { file_id: 'D', mime_type: 'video/mp4' } }]) {
    const out = await t.shown(t.msg(STUDENT, m));
    assert.equal(out[0].payload.text, AZ.needVideo);
  }
  const kinds = (await db.query(`SELECT detail FROM funnel.events WHERE kind = 'task_wrong' ORDER BY id`)).rows.map((r) => r.detail);
  assert.deepEqual(kinds, ['text', 'link', 'photo', 'video_file']);

  // «⏭» pressed too early (e.g. an old button) → a pop-up, still on lesson 2
  let all = await t.handle(t.cb(STUDENT, 'skip:2'));
  assert.equal(all[0].payload.text, AZ.skipNotYet);
  assert.equal((await stage(STUDENT)).lesson, 2);

  // a day later the task reminder carries «⏭ Tapşırıqsız davam et»
  await db.query(`UPDATE funnel.users SET stage_at = now() - interval '25 hours' WHERE user_id = $1`, [STUDENT]);
  const n0 = t.calls.length;
  assert.equal(await t.app.remindTick(new Date('2026-11-17T08:00:00Z')), 1); // 12:00 Baku
  const reminder = t.calls.slice(n0).find((c) => c.method === 'sendMessage' && c.payload.chat_id === STUDENT);
  assert.equal(reminder.payload.text, AZ.remind.task[0]);
  assert.deepEqual(kb(reminder), ['resume', 'skip:2']);
  assert.equal(reminder.payload.reply_markup.inline_keyboard[1][0].text, AZ.skipBtn);

  // pressing it → lesson 3 opens, the skip is recorded; a second tap does nothing
  const out = await t.shown(t.cb(STUDENT, 'skip:2'));
  assert.equal(out[0].payload.video, 'VID3');
  assert.deepEqual(await stage(STUDENT), { stage: 'offer', lesson: 3 }); // lesson 3 is the last one here → payment step
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'skip:2')), []);

  // give lesson 3 a task too: this time the student sends the video → recorded as done
  await t.handle(t.cmd(OWNER, '/task 3'));
  const done = await t.shown(t.msg(STUDENT, { video: { file_id: 'TASK3' } }));
  assert.ok(done.some((c) => c.method === 'forwardMessage' && c.payload.chat_id === OWNER)); // the owner got the video
  const st = await t.shown(t.cmd(OWNER, '/stats'));
  const text = st.find((c) => c.method === 'sendMessage').payload.text;
  assert.match(text, /🎥 Задания/);
  assert.match(text, /Урок 2: прислали задание 0 · пропустили 1 · вместо видео прислали: ссылку 1, фото\/скриншот 1, текст 1, видео файлом 1/);
  assert.match(text, /Урок 3: прислали задание 1 · пропустили 0/);
});

test('broadcast by step: /broadcast shows buttons with counts; a voice goes only to those now on lesson 2', async () => {
  const t = await fresh();
  for (const n of ['1', '2', '3']) {
    await t.handle(t.cmd(OWNER, `/set ${n}`));
    await t.handle(t.msg(OWNER, { text: `Dərs ${n}` }));
  }
  for (const id of [STUDENT, 444, 555]) await t.start(id); // all on lesson 1
  await t.handle(t.cb(STUDENT, 'done:1')); // STUDENT → lesson 2
  await t.handle(t.cb(444, 'done:1')); // 444 → lesson 2

  let out = await t.shown(t.cmd(OWNER, '/broadcast'));
  assert.equal(out[0].payload.text, RU.bcPick);
  const btns = out[0].payload.reply_markup.inline_keyboard.flat().map((b) => `${b.text}=${b.callback_data}`);
  assert.deepEqual(btns, ['Урок 1 · 1=bcs:1', 'Урок 2 · 2=bcs:2', 'Урок 3 · 0=bcs:3', '💳 Оплата · 0=bcs:offer', '✅ Оплатили · 0=bcs:paid', '👥 Все · 3=bcs:all']);
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'bcs:2')), []); // a student cannot start a broadcast

  out = await t.shown(t.cb(OWNER, 'bcs:2'));
  assert.equal(out[0].payload.text, RU.bcWaiting('2', 2));
  assert.match(out[0].payload.text, /сейчас на уроке 2/);
  assert.match(out[0].payload.text, /голосовое/);
  out = await t.shown(t.msg(OWNER, { voice: { file_id: 'VOICE' } })); // the owner records a voice message
  assert.equal(out[0].method, 'copyMessage'); // preview
  assert.equal(out[1].payload.text, RU.bcPreview('2', 2));
  await t.handle(t.cb(OWNER, kb(out[1])[0]));
  assert.deepEqual(await t.app.lastBroadcast, { sent: 2, blocked: 0, failed: 0 });
  const copies = t.calls.filter((c) => c.method === 'copyMessage' && [STUDENT, 444, 555].includes(c.payload.chat_id));
  assert.deepEqual(copies.map((c) => c.payload.chat_id).sort(), [222, 444]); // 555 (lesson 1) gets nothing
  assert.ok(copies.every((c) => c.payload.protect_content === true));

  out = await t.shown(t.cmd(OWNER, '/broadcast 3')); // typed form still works
  assert.equal(out[0].payload.text, RU.bcEmpty('3'));
  out = await t.shown(t.cmd(OWNER, '/broadcast xyz'));
  assert.equal(out[0].payload.text, RU.bcUsage);
});

test('broadcast to a segment: preview, confirm, protected copies, blocked users counted', async () => {
  const t = await fresh();
  for (const n of ['1', '2']) {
    await t.handle(t.cmd(OWNER, `/set ${n}`));
    await t.handle(t.msg(OWNER, { text: `Dərs ${n}` }));
  }
  for (const id of [STUDENT, 444, 555]) await t.start(id);
  await t.handle(t.cb(STUDENT, 'done:1')); // → last lesson = offer
  await t.handle(t.cb(444, 'done:1')); // → offer (will block the bot)

  let out = await t.handle(t.cmd(OWNER, '/broadcast paid'));
  assert.equal(out[0].payload.text, RU.bcEmpty('paid'));
  out = await t.handle(t.cmd(OWNER, '/broadcast offer'));
  assert.equal(out[0].payload.text, RU.bcWaiting('offer', 2));
  out = await t.handle(t.msg(OWNER, { text: 'Endirim cümə gününə qədər!' }));
  assert.equal(out[0].method, 'copyMessage'); // preview to the owner
  assert.equal(out[1].payload.text, RU.bcPreview('offer', 2));
  const go = kb(out[1])[0];

  t.blocked.add(444);
  out = await t.handle(t.cb(OWNER, go));
  assert.equal(out.find((c) => c.method === 'sendMessage').payload.text, RU.bcStarted(2));
  assert.deepEqual(await t.app.lastBroadcast, { sent: 1, blocked: 1, failed: 0 });
  const copies = t.calls.filter((c) => c.method === 'copyMessage' && [STUDENT, 444, 555].includes(c.payload.chat_id));
  assert.deepEqual(copies.map((c) => c.payload.chat_id), [STUDENT, 444]); // 555 is still on lesson 1
  assert.ok(copies.every((c) => c.payload.protect_content === true));
  assert.equal(t.calls.at(-1).payload.text, RU.bcDone(1, 1, 0));
  out = await t.handle(t.cb(OWNER, go)); // second tap does nothing
  assert.equal(out[0].payload.text, RU.bcGone);
});

test('soft channel invite once after lesson 1; lessons menu shows only unlocked lessons', async () => {
  const t = await fresh({ channelUrl: 'https://t.me/my_channel' });
  await setupLessons(t);
  await t.start(STUDENT);
  let out = await t.shown(t.cb(STUDENT, 'menu'));
  assert.deepEqual(kb(out[0]), ['resume']); // on lesson 1 nothing is passed yet
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'ls:1')), []); // the current lesson is not re-watchable
  assert.deepEqual(await t.shown(t.cb(STUDENT, 'ls:3')), []); // locked lesson: nothing

  await t.handle(t.cb(STUDENT, 'resume'));
  out = await t.shown(t.cb(STUDENT, 'done:1'));
  assert.equal(out[0].payload.video, 'VID2'); // the next lesson first, the soft invite under it
  assert.equal(out.at(-1).payload.text, AZ.channel);
  assert.deepEqual(kb(out.at(-1)), ['https://t.me/my_channel']);
  await t.handle(t.msg(STUDENT, { video: { file_id: 'V' } }));
  out = await t.shown(t.cmd(OWNER, '/stats'));
  assert.match(out[0].payload.text, /без метки: 1 → 1 → 0/);
});

test('/swap exchanges two lessons with their task flag; into an empty slot it moves', async () => {
  const t = await fresh();
  await setupLessons(t); // 1, 2 (task), 3
  let out = await t.handle(t.cmd(OWNER, '/swap 2 3'));
  assert.match(out[0].payload.text, /поменялись местами/);
  const rows = async () => Object.fromEntries((await db.query('SELECT slot, file_id, has_task FROM funnel.content')).rows.map((r) => [r.slot, r]));
  let c = await rows();
  assert.equal(c['2'].file_id, 'VID3');
  assert.equal(c['2'].has_task, false);
  assert.equal(c['3'].file_id, 'VID2');
  assert.equal(c['3'].has_task, true);

  out = await t.handle(t.cmd(OWNER, '/swap 3 5'));
  c = await rows();
  assert.equal(c['5'].file_id, 'VID2');
  assert.equal(c['3'], undefined);
  assert.match(out[0].payload.text, /Воронка: 2 урок/);
  out = await t.handle(t.cmd(OWNER, '/swap 7 8'));
  assert.equal(out[0].payload.text, RU.swapNothing('7', '8'));
  out = await t.handle(t.cmd(OWNER, '/swap 2'));
  assert.equal(out[0].payload.text, RU.swapUsage);

  await t.start(STUDENT);
  out = await t.shown(t.cb(STUDENT, 'done:1'));
  assert.equal(out[0].payload.video, 'VID3');
  assert.deepEqual(kb(out[0]), PAY(2)); // lesson 2 is now the last one
});

test('lessons added after a student reached «payment» → he continues with the next lesson, not the last one', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { video: { file_id: 'VID1' }, caption: 'Hazırlıq' }));
  await t.start(STUDENT); // only 1 lesson → it is the last one → payment
  assert.deepEqual(await stage(STUDENT), { stage: 'offer', lesson: 1 });

  for (const n of ['2', '3', '4', '5']) { // the owner adds the rest of the lessons
    await t.handle(t.cmd(OWNER, `/set ${n}`));
    await t.handle(t.msg(OWNER, { video: { file_id: `VID${n}` }, caption: `Dərs ${n}` }));
  }
  let out = await t.shown(t.cmd(STUDENT, '/start'));
  assert.equal(out[0].payload.video, 'VID2'); // NOT lesson 5 with payment
  assert.deepEqual(kb(out[0]), ['done:2', 'ask', 'ls:1', 'menu']);
  for (const n of [2, 3, 4]) {
    out = await t.shown(t.cb(STUDENT, `done:${n}`));
    assert.equal(out[0].payload.video, `VID${n + 1}`);
  }
  assert.deepEqual(kb(out[0]), PAY(5)); // payment only under lesson 5
  assert.deepEqual(await stage(STUDENT), { stage: 'offer', lesson: 5 });
});

test('paid group counter: owner always sees it in /stats; students see it under payment from 10 students', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { video: { file_id: 'VID1' } }));
  let out = await t.shown(t.cmd(OWNER, '/stats'));
  assert.match(out.find((c) => c.method === 'sendMessage').payload.text, /В платной группе сейчас: <b>3<\/b> участников \(вместе с админами и ботами\) — ученикам покажется от 10/);

  await t.start(STUDENT); // 3 members → below the threshold → no counter for students
  out = await t.shown(t.cb(STUDENT, 'resume'));
  assert.equal(out.length, 1);

  t.group.members = 52; // everyone counts (admins and bots too); the owner's /stats also refreshes the cached number
  out = await t.shown(t.cmd(OWNER, '/stats'));
  assert.match(out.find((c) => c.method === 'sendMessage').payload.text, /<b>52<\/b> участников \(вместе с админами и ботами\) — ученики видят/);
  out = await t.shown(t.cb(STUDENT, 'resume'));
  assert.deepEqual(kb(out[0]), PAY(1)); // the last lesson with payment buttons…
  assert.equal(out[1].payload.text, AZ.groupCount(52)); // …and the counter right under it
  assert.match(AZ.groupCount(52), /52 nəfər/);

  const noGroup = await fresh({ groupId: null });
  out = await noGroup.handle(noGroup.cmd(OWNER, '/stats'));
  assert.match(out[0].payload.text, /Платная группа: не подключена/);
});

test('buttons UPDATE the lesson message in place (video → video); text ↔ video falls back to send + delete', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.handle(t.cmd(OWNER, '/task 2')); // no task: plain Next walk 1 → 2 → 3
  await t.start(STUDENT);
  const [lesson1] = await screenIds(STUDENT);

  // «➡️ Növbəti dərs» pressed ON lesson 1 → the same message now shows lesson 2: no new message, nothing deleted
  let all = await t.handle(t.cb(STUDENT, 'done:1', lesson1));
  let acts = all.filter((c) => !['answerCallbackQuery', 'getChatMemberCount', 'getChatAdministrators'].includes(c.method));
  assert.deepEqual(acts.map((c) => c.method), ['editMessageMedia']);
  assert.equal(acts[0].payload.message_id, lesson1);
  assert.equal(acts[0].payload.media.media, 'VID2');
  assert.match(acts[0].payload.media.caption, /^Dərs 2\/3\n\n/);
  assert.deepEqual(kb(acts[0]), ['done:2', 'ask', 'ls:1', 'menu']);
  assert.deepEqual(await screenIds(STUDENT), [lesson1]);

  // «⏮ Əvvəlki dərs» → lesson 1 in the same message; «▶️ Davam et» → back to lesson 2, still the same message
  all = await t.handle(t.cb(STUDENT, 'ls:1', lesson1));
  assert.equal(all.find((c) => c.method === 'editMessageMedia').payload.media.media, 'VID1');
  all = await t.handle(t.cb(STUDENT, 'resume', lesson1));
  assert.equal(all.find((c) => c.method === 'editMessageMedia').payload.media.media, 'VID2');
  assert.ok(!all.some((c) => c.method === 'deleteMessage'));

  // «📚 Dərslər» → the list appears as BUTTONS under the same video (nothing sent, nothing deleted)
  all = await t.handle(t.cb(STUDENT, 'menu', lesson1));
  acts = all.filter((c) => !['answerCallbackQuery'].includes(c.method));
  assert.deepEqual(acts.map((c) => c.method), ['editMessageReplyMarkup']);
  assert.deepEqual(kb(acts[0]), ['ls:1', 'resume']);
  // a lesson picked from that list → the same message again
  all = await t.handle(t.cb(STUDENT, 'ls:1', lesson1));
  assert.equal(all.find((c) => c.method === 'editMessageMedia').payload.media.media, 'VID1');

  // the lessons list from a TEXT message that is not on the screen → a separate message (fallback)
  all = await t.handle(t.cb(STUDENT, 'menu', 99999));
  assert.equal(all.find((c) => c.method === 'sendMessage').payload.text, AZ.menuTitle);
  assert.deepEqual(all.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id), [lesson1]);

  // a button on an OLD message (not on the current screen) is never edited
  all = await t.handle(t.cb(STUDENT, 'resume', lesson1));
  assert.ok(!all.some((c) => c.method.startsWith('edit')));
});

test('«Ödədim» keeps the last lesson on screen: buttons → «Geri», the receipt request goes under it; «Geri» restores', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { video: { file_id: 'VID1' }, caption: 'Son dərs' }));
  await t.start(STUDENT); // the only lesson = the last one
  const [video] = await screenIds(STUDENT);
  let all = await t.handle(t.cb(STUDENT, 'join', video));
  assert.equal(all.find((c) => c.method === 'editMessageReplyMarkup').payload.message_id, video);
  all = await t.handle(t.cb(STUDENT, 'paid', video));
  const acts = all.filter((c) => c.method !== 'answerCallbackQuery');
  assert.deepEqual(acts.map((c) => c.method), ['editMessageReplyMarkup', 'sendMessage']); // nothing deleted
  assert.deepEqual(kb(acts[0]), ['back']);
  assert.equal(acts[1].payload.text, AZ.askReceipt);
  assert.equal((await stage(STUDENT)).stage, 'receipt');
  const prompt = acts[1];
  all = await t.handle(t.cb(STUDENT, 'back', video)); // «Geri» on the video → payment buttons again, the request removed
  assert.equal(all.find((c) => c.method === 'editMessageMedia').payload.message_id, video);
  assert.equal((await stage(STUDENT)).stage, 'offer');
  assert.equal(all.filter((c) => c.method === 'deleteMessage').length, 1); // only the small request message
  assert.ok(prompt);
});

test('bot added to a group tells the owner its id', async () => {
  const t = await fresh();
  const out = await t.handle({
    update_id: 1,
    my_chat_member: {
      chat: { id: -100555, type: 'supergroup', title: 'Kurs' }, from: t.from(OWNER), date: 0,
      old_chat_member: { status: 'left', user: BOT_INFO }, new_chat_member: { status: 'administrator', user: BOT_INFO },
    },
  });
  assert.equal(out[0].payload.chat_id, OWNER);
  assert.match(out[0].payload.text, /GROUP_ID=-100555/);
});

// ---- QA cycle 1 regressions ----

const tgError = (code, description, method, payload, parameters) =>
  new GrammyError('x', { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, method, payload);

test('receipt copy to the owner fails → student is not stuck in review and can send it again', async () => {
  let failCopy = false;
  const t = await fresh({}, { fail: (m, p) => (failCopy && m === 'copyMessage' ? tgError(429, 'Too Many Requests: retry after 5', m, p, { retry_after: 5 }) : null) });
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs' }));
  await t.start(STUDENT);
  failCopy = true;
  await assert.rejects(t.handle(t.msg(STUDENT, { photo: [{ file_id: 'P1' }] })));
  failCopy = false;
  assert.equal((await stage(STUDENT)).stage, 'offer');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM funnel.receipts')).rows[0].n, 0);

  const out = await t.shown(t.msg(STUDENT, { photo: [{ file_id: 'P2' }] }));
  const copy = out.find((c) => c.method === 'copyMessage' && c.payload.chat_id === OWNER);
  const [r] = (await db.query('SELECT id, owner_msg_id FROM funnel.receipts')).rows;
  assert.deepEqual(kb(copy), [`rc:ok:${r.id}`, `rc:no:${r.id}`]);
  assert.ok(r.owner_msg_id);
  assert.equal((await stage(STUDENT)).stage, 'review');
});

test('receipt decision moves receipt and student together; a second decision changes nothing', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs' }));
  await t.start(STUDENT);
  await t.handle(t.msg(STUDENT, { photo: [{ file_id: 'P' }] }));
  await t.handle(t.cb(OWNER, 'rc:ok:1'));
  const u = (await db.query('SELECT stage, invite_link, paid_at FROM funnel.users WHERE user_id = $1', [STUDENT])).rows[0];
  assert.equal(u.stage, 'paid');
  assert.equal(u.invite_link, 'https://t.me/+join');
  assert.ok(u.paid_at);
  assert.equal((await db.query('SELECT status FROM funnel.receipts WHERE id = 1')).rows[0].status, 'approved');
  await t.handle(t.cb(OWNER, 'rc:no:1'));
  assert.equal((await stage(STUDENT)).stage, 'paid');
});

test('an expired callback query (answerCallbackQuery 400) does not cancel the action', async () => {
  const t = await fresh({}, { fail: (m, p) => (m === 'answerCallbackQuery' ? tgError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid', m, p) : null) });
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs' }));
  await t.start(STUDENT);
  const out = await t.shown(t.cb(STUDENT, 'paid'));
  assert.equal((await stage(STUDENT)).stage, 'receipt');
  assert.equal(out[0].payload.text, AZ.askReceipt);
});

test('an album of two videos closes one task lesson; a GIF is not a task video', async () => {
  const t = await fresh();
  for (const n of ['1', '2', '3', '4']) {
    await t.handle(t.cmd(OWNER, `/set ${n}`));
    await t.handle(t.msg(OWNER, { video: { file_id: `V${n}` }, caption: `L${n}` }));
  }
  await t.handle(t.cmd(OWNER, '/task 1'));
  await t.handle(t.cmd(OWNER, '/task 2'));
  await t.start(STUDENT);
  let out = await t.shown(t.msg(STUDENT, { animation: { file_id: 'GIF' }, document: { file_id: 'GIF' } }));
  assert.equal(out[0].payload.text, AZ.needVideo);
  assert.deepEqual(await stage(STUDENT), { stage: 'lesson', lesson: 1 });
  await t.handle(t.msg(STUDENT, { media_group_id: 'g1', video: { file_id: 'a' } }));
  out = await t.shown(t.msg(STUDENT, { media_group_id: 'g1', video: { file_id: 'b' } }));
  assert.deepEqual(out, []);
  assert.deepEqual(await stage(STUDENT), { stage: 'lesson', lesson: 2 });
});

test('content cache: a read in flight while the owner saves does not keep the old lessons', async () => {
  let slow = false;
  const wrapDb = (pool) => ({
    query: async (...a) => {
      const r = await pool.query(...a);
      if (slow && /^SELECT \* FROM funnel\.content/.test(a[0])) await new Promise((res) => setTimeout(res, 300));
      return r;
    },
    connect: () => pool.connect(),
  });
  const t = await fresh({}, { wrapDb });
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { text: 'Dərs 1' }));
  await t.handle(t.cmd(OWNER, '/set 2'));
  slow = true;
  const tick = t.app.remindTick(new Date('2026-11-17T08:00:00Z')); // 12:00 Baku: reads content (slowly)
  await new Promise((r) => setTimeout(r, 50));
  await t.handle(t.msg(OWNER, { text: 'Dərs 2' }));
  await tick;
  slow = false;
  const out = await t.handle(t.cmd(OWNER, '/lessons'));
  assert.match(out.at(-1).payload.text, /Воронка: 2 урок/);
});

test('one screen: new messages are sent before the old ones are deleted; a failed send keeps the old screen', async () => {
  let failHint = false;
  const t = await fresh({}, { fail: (m, p) => (failHint && m === 'sendMessage' && p.text === AZ.taskHint ? tgError(500, 'Internal Server Error', m, p) : null) });
  await setupLessons(t);
  await t.start(STUDENT);
  const first = await screenIds(STUDENT);

  failHint = true;
  const n = t.calls.length;
  await assert.rejects(t.handle(t.cb(STUDENT, 'done:1')));
  const all = t.calls.slice(n);
  assert.ok(!all.some((c) => c.method === 'deleteMessage')); // old screen untouched
  assert.ok(all.some((c) => c.method === 'sendVideo'));
  const after = await screenIds(STUDENT);
  assert.equal(after.length, first.length + 1); // the lesson-2 video that did go out is remembered

  failHint = false;
  const next = await t.handle(t.cb(STUDENT, 'resume'));
  const firstDelete = next.findIndex((c) => c.method === 'deleteMessage');
  const lastSend = next.findLastIndex((c) => /^send/.test(c.method));
  assert.ok(firstDelete > lastSend); // send first, delete after
  assert.deepEqual(next.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id).sort(), after.sort());
  assert.equal((await screenIds(STUDENT)).length, 2);
});

test('owner «Reply» to a student while /set is pending goes to the student, not into the lesson', async () => {
  const t = await fresh();
  await setupLessons(t);
  await t.start(STUDENT);
  await t.handle(t.cb(STUDENT, 'done:1'));
  await t.handle(t.msg(STUDENT, { video: { file_id: 'TASK' } }));
  const fwd = (await db.query('SELECT max(owner_msg_id) AS m FROM funnel.owner_msgs')).rows[0].m;
  await t.handle(t.cmd(OWNER, '/set 2'));
  let out = await t.handle(t.msg(OWNER, { text: 'Əla iş!', reply_to_message: { message_id: fwd, date: 0, chat: { id: OWNER, type: 'private' } } }));
  assert.equal(out[0].payload.chat_id, STUDENT);
  assert.equal(out.at(-1).payload.text, RU.replySent);
  assert.equal((await db.query("SELECT file_id FROM funnel.content WHERE slot = '2'")).rows[0].file_id, 'VID2');
  out = await t.handle(t.msg(OWNER, { video: { file_id: 'NEW2' } })); // the /set wait is still there
  assert.equal(out[0].payload.text, RU.saved('2', 'video'));
});

test('/broadcast with an Object.prototype name is rejected as usage; segmentUsers refuses it too', async () => {
  const t = await fresh();
  for (const arg of ['constructor', '__proto__', 'tostring']) {
    const out = await t.handle(t.cmd(OWNER, `/broadcast ${arg}`));
    assert.equal(out[0].payload.text, RU.bcUsage);
  }
  const S = await import('../../src/store.js');
  await assert.rejects(S.segmentUsers(db, 'constructor'), /unknown segment/);
});

test('/set with a caption over 1024 characters is refused and not saved', async () => {
  const t = await fresh();
  await t.handle(t.cmd(OWNER, '/set 1'));
  let out = await t.handle(t.msg(OWNER, { video: { file_id: 'V' }, caption: 'a'.repeat(1025) }));
  assert.equal(out[0].payload.text, RU.captionTooLong(1025));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM funnel.content')).rows[0].n, 0);
  out = await t.handle(t.msg(OWNER, { video: { file_id: 'V' }, caption: 'a'.repeat(1024) }));
  assert.equal(out[0].payload.text, RU.saved('1', 'video'));
});

test('alerts: a failure while handling a button → the owner learns what, where and why', async () => {
  const t = await fresh({}, {
    fail: (method) => (method === 'sendVideo' ? new GrammyError('x', { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier' }, method, {}) : null),
  });
  await t.handle(t.cmd(OWNER, '/set 1'));
  await t.handle(t.msg(OWNER, { video: { file_id: 'BROKEN' } }));
  await t.handle(t.cmd(STUDENT, '/start'));
  // like long polling in production: handleUpdates passes a failed update to bot.catch (handleUpdate would rethrow)
  const polled = async (u) => { const n = t.calls.length; await t.app.bot.handleUpdates([u]); return t.calls.slice(n); };
  const out = await polled(t.cb(STUDENT, 'begin'));
  const alert = out.find((c) => c.method === 'sendMessage' && c.payload.chat_id === OWNER);
  assert.match(alert.payload.text, /🚨 <b>Ошибка при обработке действия<\/b>/);
  assert.match(alert.payload.text, /нажатие кнопки «begin» — Aynur @aynur \(id 222\)/);
  assert.match(alert.payload.text, /wrong file identifier/);
  assert.match(alert.payload.text, /💡 Telegram отклонил запрос/);
  const again = await polled(t.cb(STUDENT, 'begin')); // the same problem again → no second message within 30 min
  assert.ok(!again.some((c) => c.method === 'sendMessage' && c.payload.chat_id === OWNER));
});

test('alerts: heartbeat — DB lost → one alert, DB back → «restored»; start reports the downtime', async () => {
  let down = false;
  const wrapDb = (pool) => ({
    query: async (...a) => { if (down) throw new Error('Connection terminated due to connection timeout'); return pool.query(...a); },
    connect: () => pool.connect(),
  });
  const t = await fresh({}, { wrapDb });
  const toOwner = () => t.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === OWNER).map((c) => c.payload.text);

  await t.app.heartbeat(new Date());
  assert.equal(toOwner().length, 0); // all fine → silence
  down = true;
  await t.app.heartbeat();
  await t.app.heartbeat();
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0], /Нет связи с базой данных/);
  assert.match(toOwner()[0], /Supabase/);
  down = false;
  await t.app.heartbeat();
  assert.equal(toOwner().at(-1), '✅ Связь с базой данных восстановлена, бот работает.');

  // the process vanished 40 min ago (no graceful stop) → the next start says so
  await db.query(`UPDATE funnel.bot_state SET value = jsonb_build_object('at', (now() - interval '40 minutes')::text) WHERE key = 'heartbeat'`);
  await t.app.startupReport(new Date());
  assert.match(toOwner().at(-1), /был недоступен<\/b> примерно с .* \(≈40 мин\)/);
  // a graceful stop is reported as such
  await t.app.recordStop('вручную, Ctrl+C');
  await t.app.startupReport(new Date(Date.now() + 5 * 60 * 1000));
  assert.match(toOwner().at(-1), /Был остановлен в .* \(вручную, Ctrl\+C\), простой ≈5 мин/);
});
