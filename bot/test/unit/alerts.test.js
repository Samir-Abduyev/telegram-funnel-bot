import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import { createAlerter, hintFor, describeUpdate } from '../../src/alerts.js';
import { RU } from '../../src/texts_owner.js';
import { wrongTaskKind } from '../../src/app.js';
import { AZ } from '../../src/texts_az.js';

test('wrongTaskKind names what was sent instead of the task video; pop-ups fit Telegram (≤ 200)', () => {
  assert.equal(wrongTaskKind({ text: 'salam' }), 'text');
  assert.equal(wrongTaskKind({ text: 'bax www.example.com' }), 'link');
  assert.equal(wrongTaskKind({ text: 'x', entities: [{ type: 'text_link' }] }), 'link');
  assert.equal(wrongTaskKind({ photo: [{}] }), 'photo');
  assert.equal(wrongTaskKind({ document: { mime_type: 'video/quicktime' } }), 'video_file');
  assert.equal(wrongTaskKind({ document: { mime_type: 'application/pdf' } }), 'file');
  assert.equal(wrongTaskKind({ animation: {}, document: {} }), 'gif');
  assert.equal(wrongTaskKind({ voice: {} }), 'voice');
  assert.equal(wrongTaskKind({ sticker: {} }), 'sticker');
  assert.equal(wrongTaskKind({ location: {} }), 'other');
  for (const k of ['skipNotYet', 'sendTaskHow']) assert.ok(AZ[k].length <= 200, k);
});

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake12';

test('hintFor explains the usual causes in Russian', () => {
  assert.match(hintFor('Connection terminated due to connection timeout'), /Нет связи с базой/);
  assert.match(hintFor('connect ECONNREFUSED 1.2.3.4:5432'), /Supabase/);
  assert.match(hintFor('Telegram network error: fetch failed'), /Нет связи с Telegram/);
  assert.match(hintFor('Telegram getUpdates: 409 Conflict: terminated by other getUpdates request'), /вторая копия/);
  assert.match(hintFor('Telegram getMe: 401 Unauthorized'), /BOT_TOKEN/);
  assert.match(hintFor('relation "funnel.bot_state" does not exist'), /npm run migrate/);
  assert.match(hintFor('x is not a function'), /разработчику/);
});

test('describeUpdate says what the person did', () => {
  const from = { id: 5, first_name: 'Aynur', username: 'ay' };
  assert.equal(describeUpdate({ from, update: { callback_query: { data: 'paid' } } }), 'нажатие кнопки «paid» — Aynur @ay (id 5)');
  assert.equal(describeUpdate({ from, update: { message: { text: '/set 2' } } }), 'команда /set — Aynur @ay (id 5)');
  assert.equal(describeUpdate({ from, update: { message: { video: {} } } }), 'сообщение (video) — Aynur @ay (id 5)');
});

test('alerter: once per 30 min per problem, then reports repeats; «resolved» only after an alert; never throws', async () => {
  let now = 0;
  const sent = [];
  const a = createAlerter(async (t) => { sent.push(t); }, { now: () => now });
  assert.equal(await a.resolved('db', 'ok'), false); // nothing was reported → silence

  const err = new Error(`fetch https://api.telegram.org/bot${TOKEN}/x ETIMEDOUT`);
  assert.equal(await a.alert('db', 'Нет связи с базой данных', err, 'проверка'), true);
  assert.match(sent[0], /🚨 <b>Нет связи с базой данных<\/b>/);
  assert.match(sent[0], /📍 Где: проверка/);
  assert.ok(!sent[0].includes(TOKEN), 'the token must never reach the message');
  assert.equal(await a.alert('db', 'Нет связи с базой данных', err), false);
  assert.equal(await a.alert('db', 'Нет связи с базой данных', err), false);
  assert.equal(await a.alert('other', 'Другое', new Error('x')), true); // another problem is not muted
  now += 31 * 60 * 1000;
  await a.alert('db', 'Нет связи с базой данных', err);
  assert.match(sent.at(-1), /повторилось ещё 2 раз/);
  assert.equal(await a.resolved('db', 'Связь восстановлена'), true);
  assert.equal(sent.at(-1), '✅ Связь восстановлена');

  const broken = createAlerter(async () => { throw new GrammyError('x', { ok: false, error_code: 403, description: 'blocked' }, 'sendMessage', {}); });
  assert.equal(await broken.alert('k', 't', new Error('e')), false); // does not throw
});

test('startup report: first start, graceful stop, quick restart, unexpected downtime', () => {
  const now = new Date('2026-11-18T10:30:00Z'); // 14:30 Baku
  assert.equal(RU.startup({}, now), '✅ Бот запущен.');
  assert.match(RU.startup({ heartbeat: { at: '2026-11-18T10:00:00Z' }, stop: { at: '2026-11-18T10:00:30Z', reason: 'вручную, Ctrl+C' } }, now),
    /Был остановлен в 18\.11, 14:00 \(вручную, Ctrl\+C\), простой ≈30 мин/);
  assert.equal(RU.startup({ heartbeat: { at: '2026-11-18T10:29:30Z' } }, now), '✅ Бот перезапущен.');
  const down = RU.startup({ heartbeat: { at: '2026-11-18T09:02:00Z' }, stop: { at: '2026-11-17T09:00:00Z', reason: 'old' } }, now);
  assert.match(down, /был недоступен<\/b> примерно с 18\.11, 13:02 до 18\.11, 14:30 \(≈88 мин\)/);
  assert.match(down, /нехватка памяти/);
});
