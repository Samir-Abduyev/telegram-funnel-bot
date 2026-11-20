import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, describeConfig, envWithFile } from '../../src/config.js';
import { redactSecrets, describeError, bakuHour, who } from '../../src/util.js';
import { extractContent, lessonCount, withHead } from '../../src/app.js';
import { AZ } from '../../src/texts_az.js';
import { RU } from '../../src/texts_owner.js';

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake12';
const ENV = {
  BOT_TOKEN: TOKEN, OWNER_ID: '111', OWNER_CONTACT: '@owner', GROUP_ID: '-1001234567890',
  PAYMENT_URL: 'https://pay.example/x', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
};

test('config: valid env, summary has no secrets', () => {
  const { cfg, errors } = loadConfig(ENV);
  assert.deepEqual(errors, []);
  assert.equal(cfg.ownerId, 111);
  assert.equal(cfg.groupId, -1001234567890);
  assert.deepEqual(cfg.warnings, []);
  const d = describeConfig(cfg);
  assert.ok(!d.includes(TOKEN) && !d.includes('u:p@'));
});

test('config: errors and warnings', () => {
  const { errors } = loadConfig({ ...ENV, BOT_TOKEN: 'x', OWNER_ID: 'me', GROUP_ID: '123', PAYMENT_URL: 'http://a', DATABASE_URL: '' });
  assert.equal(errors.length, 5);
  const { cfg, errors: e2 } = loadConfig({ ...ENV, GROUP_ID: '', PAYMENT_URL: '' });
  assert.deepEqual(e2, []);
  assert.equal(cfg.groupId, null);
  assert.equal(cfg.warnings.length, 2);
});

test('.env wins over a variable with the same name already set in the system', () => {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-'));
  writeFileSync(join(dir, '.env'), `BOT_TOKEN=${TOKEN}\nOWNER_ID=111\n`);
  const env = envWithFile(join(dir, '.env'), { BOT_TOKEN: 'stale-system-token', PATH: 'x' });
  assert.equal(env.BOT_TOKEN, TOKEN);
  assert.equal(env.PATH, 'x');
  assert.equal(envWithFile(join(dir, 'missing.env'), { A: '1' }).A, '1');
});

test('token never leaks into error text', () => {
  const e = new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
  assert.ok(!describeError(e).includes(TOKEN));
  assert.ok(redactSecrets(`x ${TOKEN} y`).includes('<token>'));
});

test('bakuHour is UTC+4', () => {
  assert.equal(bakuHour(new Date('2026-11-17T06:30:00Z')), 10);
  assert.equal(bakuHour(new Date('2026-11-17T22:00:00Z')), 2);
});

test('extractContent: types, largest photo, GIF before document, unsupported', () => {
  assert.deepEqual(extractContent({ text: 'hi', entities: [{ type: 'bold', offset: 0, length: 2 }] }),
    { kind: 'text', file_id: null, text: 'hi', entities: [{ type: 'bold', offset: 0, length: 2 }] });
  assert.equal(extractContent({ video: { file_id: 'V' }, caption: 'Dərs 1' }).file_id, 'V');
  assert.equal(extractContent({ video: { file_id: 'V' }, caption: 'Dərs 1' }).text, 'Dərs 1');
  assert.equal(extractContent({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }).file_id, 'big');
  assert.equal(extractContent({ animation: { file_id: 'A' }, document: { file_id: 'D' } }).kind, 'animation');
  assert.equal(extractContent({ video_note: { file_id: 'N' } }).kind, 'video_note');
  assert.equal(extractContent({ sticker: { file_id: 'S' } }), null);
});

test('owner command menu is valid for Telegram (name a-z0-9_, description ≤ 256)', () => {
  for (const c of RU.menu) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
});

test('withHead puts «Dərs N/M» bold on top and shifts the owner formatting', () => {
  const c = { kind: 'video', file_id: 'V', text: 'Hazırlıq 🎬 günü', entities: [{ type: 'italic', offset: 9, length: 2 }] };
  const h = withHead(c, 'Dərs 3/5');
  assert.equal(h.text, 'Dərs 3/5\n\nHazırlıq 🎬 günü');
  assert.deepEqual(h.entities[0], { type: 'bold', offset: 0, length: 8 });
  assert.equal(h.text.substr(h.entities[1].offset, h.entities[1].length), '🎬'); // UTF-16 offsets stay correct
  assert.equal(withHead({ kind: 'video', file_id: 'V', text: '', entities: [] }, 'Dərs 1/5').text, 'Dərs 1/5');
  assert.equal(withHead({ kind: 'video_note', file_id: 'N', text: '' }, 'Dərs 1/5').text, ''); // no caption possible
  const long = { kind: 'video', file_id: 'V', text: 'x'.repeat(1020), entities: [] };
  assert.equal(withHead(long, 'Dərs 1/5'), long); // would exceed 1024 → unchanged
  assert.equal(withHead(c, null), c);
});

test('lessonCount counts 1..n without gaps', () => {
  const c = (...slots) => slots.map((slot) => ({ slot }));
  assert.equal(lessonCount(c()), 0);
  assert.equal(lessonCount(c('welcome', '1', '2', 'offer')), 2);
  assert.equal(lessonCount(c('1', '2', '4')), 2);
  assert.equal(lessonCount(c('2', '3')), 0);
});

test('texts: student HTML is escaped, every reminder exists, owner overview warns about gaps', () => {
  assert.ok(AZ.welcome('<b>x</b>').includes('&lt;b&gt;x'));
  for (const k of ['lesson', 'task', 'offer', 'receipt']) assert.equal(AZ.remind[k].length, 2);
  assert.ok(!JSON.stringify(AZ).includes('uşaqlar'));
  assert.ok(who({ id: 5, first_name: '<A>', username: 'u' }).includes('&lt;A&gt;'));
  const text = RU.lessons([{ slot: '1', kind: 'video' }, { slot: '3', kind: 'video', has_task: true }], 1, ['w']);
  assert.match(text, /урок 3: видео \+ задание 🎥 ⚠️/);
  assert.match(text, /⚠️ w/);
});
