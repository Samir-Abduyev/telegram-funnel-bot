# Telegram Funnel Bot — free video lessons → payment → private group

A production Telegram bot that turns channel visitors into paying students: it delivers a short free video course
step by step, checks homework, offers the paid program under the last lesson, verifies payment receipts with the
owner and lets paid students into a private group automatically. Students talk to it in **Azerbaijani**; the owner
manages everything from Telegram in **Russian** — no admin panel, no web server.

Running 24/7 on a small Linux VPS since November 2026.

## What it does

**For students**
- One clean “screen”: every step replaces the previous message, the chat never fills up; a lessons menu shows only
  lessons already passed.
- Video lessons are sent with Telegram content protection (no download, no forwarding).
- Lessons can require homework: the student sends a video, the owner receives it and can answer by voice or text
  right from the bot (“Reply”). Students stuck on homework for a day get a reminder with a “continue without the
  task” option, so nobody is lost before the offer.
- The last lesson carries the offer: online payment link, card payment via the owner’s chat, “I paid” → receipt upload.
- After the owner approves the receipt the student gets a personal join-request link; the bot approves join requests
  only for paid students, so a forwarded link is useless.
- Gentle reminders after 1 and 3 days, only between 10:00 and 21:00 local time.

**For the owner**
- `/set N` → send a video with a caption: that is lesson N. `/task N`, `/swap A B`, `/show N`, `/lessons`.
- Receipts arrive with ✅/❌ buttons; a reminder if one waits for more than 2 hours.
- `/broadcast` → buttons with the number of people on every step (lesson 1, 2, 3…, payment, paid, all) → send
  any message (voice, video note, text) to exactly that group.
- `/stats`: the funnel by step, sources (`t.me/bot?start=tag`), paid-group size, and homework analytics —
  how many sent the task, skipped it, or sent something else instead (text, link, screenshot, file…).
- Monitoring in Telegram: errors with *where* and *why*, lost database connection and recovery, and a downtime
  report on every start (“was unavailable from … to …”).

## Tech
- **Node.js 24** (ESM), **grammY** (long polling), **PostgreSQL** (Supabase) via `pg`, no other runtime dependencies.
- All SQL in one module; idempotent migrations in `sql/`; atomic state transitions (double taps, receipts decided once).
- Tests with the built-in `node --test`: unit tests plus full end-to-end scenarios against a real local Postgres with a
  fake Telegram API (every button, broadcast, reminder and failure path).
- Deployment: `deploy/install.sh` + systemd unit (hardened: `ProtectSystem=strict`, no restart loop on config errors).
- Security: secrets only in `.env` (never committed), bot token redacted from every log line.

## Project layout
```
bot/src/      app.js (all Telegram logic) · store.js (all SQL) · alerts.js · config.js · texts_az.js / texts_owner.js
bot/test/     unit/ and db/ (end-to-end with a fake Telegram)
sql/          001–006 migrations
deploy/       install.sh, update.sh, funnel-bot.service
ИНСТРУКЦИЯ.md owner guide (Russian)
```

## Run it
```bash
cd bot && npm install
cp .env.example .env        # fill in BOT_TOKEN, OWNER_ID, DATABASE_URL …
npm run migrate && npm start
npm test                    # unit tests
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:db   # end-to-end (local throwaway DB)
```

Built by [Samir Abduyev](https://github.com/Samir-Abduyev) with Claude Code.
