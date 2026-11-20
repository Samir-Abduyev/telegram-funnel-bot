# Funnel bot — project map (read first, then open ONLY the files you need)

Telegram funnel bot, independent of VibeCeh: /start → free video lessons one by one (a lesson may require a task video,
forwarded to the owner) → payment offer (link / card via owner's TG) → receipt → owner approves → join-request link →
bot approves the join request into the closed group. Reminders after 1 and 3 days (10:00–21:00 Baku). No AI.
Node 24 ESM, grammY long polling, pg → Supabase Postgres, schema `funnel`. Owner guide (RU): `ИНСТРУКЦИЯ.md`.

## Working rules (owner's standing instructions)
- Talk to the owner in Russian; students see Azerbaijani (`bot/src/texts_az.js`, «sən»); owner messages: `texts_owner.js` (RU).
- Secrets: never write tokens/passwords into files or .env (the owner pastes them), never print them, never `cat .env`
  (use `grep -n '^NAME=' .env | sed 's/=.*/=<set>/'`). All logs go through `redactSecrets` (main.js).
- No subagents/workflows, no paid services without asking. Never claim it works without a test or a live check.
- Skills: `systematic-debugging` (any bug/failure), `verification-before-completion` (before "done"). Karpathy discipline as in ../CLAUDE.md.

## Production (since 18.11): Linux VPS, systemd `funnel-bot` (user funnel, /opt/funnel-bot)
- Server IP, SSH command, Supabase project ref and the deploy one-liner live in **PRIVATE.md** (local only, gitignored — this repo is PUBLIC).
- Deploy = tar over SSH + `deploy/update.sh` (no rsync on Windows); keep `--exclude=PRIVATE.md --exclude=.git --exclude=bot/.env` (funnel-bot is its own git repo: public GitHub Samir-Abduyev/telegram-funnel-bot).
- NEVER start the bot on the PC any more (409 with the server). Logs: `journalctl -u funnel-bot -n 50 --no-pager` on the server.
- PUBLIC repo: never commit IPs, ids, project refs or secrets — put them into PRIVATE.md.

## Commands (from funnel-bot/bot)
- `npm test` (unit) · `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres npm run test:db` (full flow, fake Telegram; drops schema funnel!)
  Local PG 18 for tests: `"/c/Program Files/PostgreSQL/18/bin/pg_ctl" -D "<scratchpad>/pgdata" -o "-p 55433" start` (initdb -U postgres -A trust if missing; run in background).
  Trim output: `| grep -E "^ℹ (pass|fail)|^✖"`.
- `npm run migrate` (sql/*.sql once each) · `npm start`. On Windows run as a background task `exec node --env-file=.env src/main.js` (never npm|tee → orphan node → Telegram 409).
- VPS: `deploy/install.sh`, `deploy/update.sh`, systemd `deploy/funnel-bot.service` (exit 78 = config error, no restart loop).

## Files (bot/src)
- `alerts.js` owner alerts: createAlerter(send) → alert(key,title,err,where) once per 30 min per key (+repeat count), resolved(key,text); hintFor(desc) RU cause/action; describeUpdate(ctx).
  Wired: bot.catch (handler errors, «where» = button/command/user), heartbeat (app.heartbeat every 60 s → funnel.bot_state 'heartbeat'; DB failure → alert 'db', recovery → resolved),
  remind/unhandled/fatal in main.js, DB wait at start (bare grammy Api alerter), startupReport (RU.startup: first start / graceful stop / downtime ≥3 min), recordStop on SIGINT/SIGTERM/fatal.
  `scripts/forever.mjs` (`npm run forever`): PC supervisor — restarts on crash with backoff 5/10/30/60 s and sends the exit code + last 12 log lines; exit 0 = stop, 78 = stop + alert.
  On the PC run it in the app's Terminal panel (NOT as a Claude background task: those are killed under memory pressure). In tests updates that must reach bot.catch go through bot.handleUpdates([u]).
- `main.js` start, DB wait/retry, exit codes, reminder timer (15 min), heartbeat timer (1 min) · `config.js` .env → cfg (+warnings) · `db.js` pool/SSL · `util.js` esc, redactSecrets, describeError, isBlocked, bakuHour, who
- `app.js` everything Telegram: sendStep (what the user sees per stage), advance, student handlers, owner commands (/set /task /show /lessons /stats /reset /cancel /help),
  receipt decision `rc:ok|no:ID`, chat_join_request, my_chat_member (tells owner the group id), remindTick · `store.js` ALL SQL
- Tests: `test/unit/basics.test.js`, `test/db/flow.test.js` (harness: `bot.api.config.use` fake + `handleUpdate`).

## Data (sql/001–006; 005 = bot_state heartbeat/stop; 006 = events task_done/task_wrong(detail=type)/task_skip → /stats «🎥 Задания»)
Task reminders (≥1 day) carry «⏭ Tapşırıqsız davam et» (skip:N, server allows only after SKIP_TASK_AFTER_MS=24 h). /broadcast without args → segment buttons with counts (bcs:1..9|offer|paid|all).
users (stage lesson→offer→receipt→review→paid, lesson, stage_at, reminders 0..2, blocked, invite_link, source) ·
content (slot welcome|offer|1-9, kind, file_id, text, entities, has_task) · receipts (pending/approved/rejected, owner_msg_id, reminded) ·
owner_msgs (owner_msg_id → user_id: owner «Reply» on a task/question/receipt is copied to that student).
UI rules (owner tested live 18.11, hates jitter and verbosity): buttons UPDATE the message they were pressed on — screen parts are
descriptors {c,kb}|{text,extra}; showScreen(…, {editId: editable(ctx,user)}) edits part 0 in place (editMessageMedia/Text; Telegram
can add media to a text message, but not text to a video → fallback send+delete). «📚 Dərslər» = editMessageReplyMarkup with the list
under the same video; «Ödədim» = video keeps, buttons → «⬅️ Geri», receipt request as a small say(); «Sual ver» prompt is edited into
«Sualın göndərildi»; «Geri» under the prompt only deletes the prompt. Answers to questions/tasks/receipts are copyMessage with
reply_parameters → quote the student's own message (owner_msgs.student_msg_id, sql/004). Rejected receipt = ONE text message with
payment buttons (no lesson resend). Button order: main action, «❓ Sual ver» (+ admin on the last lesson), navigation row LAST.
Texts short (no «verbose» filler). Live test: Telegram Web in the built-in browser (owner account), /reset → /start.
users.screen_ids (003): student UI is ONE screen — showScreen() sends the new messages first, then replaceScreen() + deletes the old ones (send failure keeps the old screen);
say() adds a transient message to the screen. Last lesson = stage 'offer' (lesson = total) with payKeyboard (online/card pop-up/Ödədim)
+ nav row «📚 Dərslər» (menu of unlocked lessons, ls:N re-watch) and «💬 Adminlə əlaqə» (url from OWNER_CONTACT). No separate offer slot.
Student content is sent with protect_content (no download/forward). Owner: reply-through-bot («Reply» on task/receipt),
receipt reminder after 2 h (once, in remindTick), /broadcast all|lessons|offer|paid (preview → confirm → background loop, app.lastBroadcast), /swap.
DB: own Supabase project in Frankfurt (details in PRIVATE.md) — ~80 ms/query from Baku, ~9 ms from the VPS.
Lesson count = slots 1..n without gaps. Content is cached in memory, reset on /set and /task (single process).

## Gotchas
- Windows has a stray system variable BOT_TOKEN (another bot) and `--env-file` never overrides system vars → config reads
  through `envWithFile()` (bot/.env wins). For manual checks use `node -e` with envWithFile, not process.env.
- pg returns bigint as string → `pg.types.setTypeParser(20, Number)` in store.js (ids compared with ===).
- Bots cannot add users to groups: invite link with `creates_join_request` + approve only `stage='paid'`.
- Owner /set waits are in memory (lost on restart: just repeat /set). Captions ≤ 1024 chars (Telegram).
- Bash heredocs / `node -e` eat backslashes: write regex code with Write/Edit.
- NEVER probe «is the bot running?» with a manual `getUpdates`: it cuts the running bot's long poll (409) and main.js exits 78
  (happened 18.11). Check the node process (`Get-CimInstance … *src/main.js*`) and the task log instead.
- Invariants (QA 1): receipt copy to the owner fails → receipt deleted + stage back (cancelReceipt); decideReceipt moves receipt AND user in one SQL;
  answerCallbackQuery never throws (middleware); album = one message (media_group_id); content cache uses a version counter (resetContent()).

## Known Low risks (QA 17.11, cycles 1–2 PASS: no Critical/High)
- Not done: F7 sequential grammY processing (DB now ~80 ms/query; consider @grammyjs/runner + sequentialize, throttling), F10 DATABASE_SSL=verify on VPS.
- N1 owner album during /set or /broadcast: extra items fall into the student flow. N2 setStage('review') + createReceipt are 2 queries.
- N3 mixed album (photo first, video second) for a task → video ignored. N4 copyMessage timeout that actually delivered → duplicate receipt card.
- F13: owner without a wait is treated as a student; anyone adding the bot to a group pings the owner; parallel /broadcast not prevented.
