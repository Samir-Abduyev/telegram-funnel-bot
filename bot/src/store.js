// All SQL of the bot. Every function takes the pool first.
import pg from 'pg';

// bigint (Telegram ids, receipt ids) → JS number, not string: ids fit in 2^53, and Telegram/our checks compare numbers.
pg.types.setTypeParser(20, Number);

/** Creates the user on first /start (or first message). Returns { user, created }. */
export async function startUser(db, from, source) {
  const r = await db.query(
    `INSERT INTO funnel.users (user_id, first_name, username, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, blocked = false
     RETURNING *, (xmax = 0) AS created`,
    [from.id, from.first_name ?? '', from.username ?? null, source || null],
  );
  const { created, ...user } = r.rows[0];
  return { user, created };
}

/** Fetches the user and refreshes name / unblocks in the same query (a person who writes has not blocked us). */
export async function touchUser(db, from) {
  const r = await db.query(
    `UPDATE funnel.users SET first_name = $2, username = $3, blocked = false WHERE user_id = $1 RETURNING *`,
    [from.id, from.first_name ?? '', from.username ?? null],
  );
  return r.rows[0] ?? null;
}

export async function getUser(db, userId) {
  return (await db.query('SELECT * FROM funnel.users WHERE user_id = $1', [userId])).rows[0] ?? null;
}

/**
 * Moves the user to a new stage. With `from` given, moves only if the user is still exactly there
 * (stage + lesson) — a double tap on a button then advances once. Returns the updated row or null.
 */
export async function setStage(db, userId, stage, lesson, from = null) {
  const r = await db.query(
    `UPDATE funnel.users SET stage = $2, lesson = COALESCE($3, lesson), stage_at = now(), reminders = 0
     WHERE user_id = $1 AND ($4::text IS NULL OR (stage = $4 AND lesson = $5)) RETURNING *`,
    [userId, stage, lesson, from?.stage ?? null, from?.lesson ?? null],
  );
  return r.rows[0] ?? null;
}

/** Sets the current screen to `ids`, returns the previous ids (atomically, so two taps never delete twice). */
export async function replaceScreen(db, userId, ids) {
  const r = await db.query(
    `UPDATE funnel.users u SET screen_ids = $2::bigint[] FROM (SELECT screen_ids FROM funnel.users WHERE user_id = $1 FOR UPDATE) old
     WHERE u.user_id = $1 RETURNING old.screen_ids`,
    [userId, ids],
  );
  return (r.rows[0]?.screen_ids ?? []).map(Number);
}

/** Adds message ids to the current screen (they disappear with the next screen). */
export async function addToScreen(db, userId, ids) {
  await db.query('UPDATE funnel.users SET screen_ids = screen_ids || $2::bigint[] WHERE user_id = $1', [userId, ids]);
}

export async function setBlocked(db, userId) {
  await db.query('UPDATE funnel.users SET blocked = true WHERE user_id = $1', [userId]);
}

export async function deleteUser(db, userId) {
  await db.query('DELETE FROM funnel.users WHERE user_id = $1', [userId]);
}

// ---- content ----

export async function listContent(db) {
  return (await db.query('SELECT * FROM funnel.content')).rows;
}

/** Saves content of a slot; keeps the lesson's task flag. */
export async function saveContent(db, slot, c) {
  await db.query(
    `INSERT INTO funnel.content (slot, kind, file_id, text, entities) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (slot) DO UPDATE SET kind = EXCLUDED.kind, file_id = EXCLUDED.file_id, text = EXCLUDED.text,
       entities = EXCLUDED.entities, updated_at = now()`,
    [slot, c.kind, c.file_id ?? null, c.text ?? '', JSON.stringify(c.entities ?? [])],
  );
}

/** Toggles «lesson needs a video». Returns the new value, or null if the lesson is not set. */
export async function toggleTask(db, slot) {
  const r = await db.query('UPDATE funnel.content SET has_task = NOT has_task WHERE slot = $1 RETURNING has_task', [slot]);
  return r.rows[0]?.has_task ?? null;
}

/** Swaps two lesson slots (video, text, task flag). If one is empty, the other simply moves there. Returns rows moved. */
// Separate statements in one transaction: a single DELETE…INSERT statement trips over the primary key.
export async function swapContent(db, a, b) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('DELETE FROM funnel.content WHERE slot IN ($1, $2) RETURNING *', [a, b]);
    for (const row of old.rows) {
      await client.query(
        `INSERT INTO funnel.content (slot, kind, file_id, text, entities, has_task) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [row.slot === a ? b : a, row.kind, row.file_id, row.text, JSON.stringify(row.entities), row.has_task],
      );
    }
    await client.query('COMMIT');
    return old.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- receipts ----

export async function createReceipt(db, userId) {
  return (await db.query('INSERT INTO funnel.receipts (user_id) VALUES ($1) RETURNING id', [userId])).rows[0].id;
}

export async function getReceipt(db, id) {
  return (await db.query('SELECT * FROM funnel.receipts WHERE id = $1', [id])).rows[0] ?? null;
}

/**
 * Decides a pending receipt once (a second tap / second owner device gets null) and, in the same statement,
 * moves the student: approved → 'paid' with the invite link, rejected → back to 'offer'.
 */
export async function decideReceipt(db, id, status, inviteLink = null) {
  const r = await db.query(
    `WITH d AS (
       UPDATE funnel.receipts SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING user_id
     ), u AS (
       UPDATE funnel.users SET stage = CASE WHEN $2 = 'approved' THEN 'paid' ELSE 'offer' END, stage_at = now(), reminders = 0,
         paid_at = CASE WHEN $2 = 'approved' THEN now() ELSE paid_at END,
         invite_link = CASE WHEN $2 = 'approved' THEN $3 ELSE invite_link END
       WHERE user_id = (SELECT user_id FROM d) RETURNING user_id
     )
     SELECT user_id FROM d`,
    [id, status, inviteLink],
  );
  return r.rows[0]?.user_id ?? null;
}

/** Undoes a receipt whose copy never reached the owner: the student goes back from 'review' and may send it again. */
export async function cancelReceipt(db, id, userId, stage) {
  await db.query(
    `WITH d AS (DELETE FROM funnel.receipts WHERE id = $1 AND status = 'pending')
     UPDATE funnel.users SET stage = $3, stage_at = now() WHERE user_id = $2 AND stage = 'review'`,
    [id, userId, stage],
  );
}

export async function setReceiptOwnerMsg(db, id, ownerMsgId) {
  await db.query('UPDATE funnel.receipts SET owner_msg_id = $2 WHERE id = $1', [id, ownerMsgId]);
}

/** Pending receipts older than `hours` not yet reminded about; marks them reminded. */
export async function takeStaleReceipts(db, hours = 2) {
  const r = await db.query(
    `UPDATE funnel.receipts SET reminded = true
     WHERE status = 'pending' AND NOT reminded AND created_at < now() - make_interval(hours => $1)
     RETURNING id, user_id, owner_msg_id`,
    [hours],
  );
  return r.rows;
}

// ---- owner replies ----

/** `studentMsgId`: the student's own message (question / task video / receipt) the owner's answer will quote. */
export async function rememberOwnerMsg(db, ownerMsgId, userId, studentMsgId = null) {
  await db.query(
    'INSERT INTO funnel.owner_msgs (owner_msg_id, user_id, student_msg_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [ownerMsgId, userId, studentMsgId],
  );
}

/** { user_id, student_msg_id } for a message in the owner's chat, or null. */
export async function userForOwnerMsg(db, ownerMsgId) {
  return (await db.query('SELECT user_id, student_msg_id FROM funnel.owner_msgs WHERE owner_msg_id = $1', [ownerMsgId])).rows[0] ?? null;
}

// ---- broadcast ----

export const SEGMENTS = {
  all: "TRUE",
  lessons: "stage = 'lesson'",
  offer: "stage IN ('offer', 'receipt')",
  paid: "stage = 'paid'",
};

/** Segment → SQL condition. '1'..'9' = students who are now on that lesson (reached it, did not go further). */
function segmentWhere(segment) {
  if (/^[1-9]$/.test(segment)) return `stage = 'lesson' AND lesson = ${Number(segment)}`;
  return Object.hasOwn(SEGMENTS, segment) ? SEGMENTS[segment] : null;
}
export const isSegment = (segment) => segmentWhere(String(segment)) !== null;

export async function segmentUsers(db, segment) {
  const where = segmentWhere(segment);
  if (!where) throw new Error(`unknown segment ${segment}`);
  return (await db.query(`SELECT user_id FROM funnel.users WHERE NOT blocked AND ${where} ORDER BY user_id`)).rows.map((r) => r.user_id);
}

/** How many (not blocked) people are in each segment: { '1': n, '2': n, …, offer, paid, all }. One query. */
export async function segmentCounts(db) {
  const rows = (await db.query(
    `SELECT stage, lesson, count(*)::int AS n FROM funnel.users WHERE NOT blocked GROUP BY stage, lesson`,
  )).rows;
  const c = { offer: 0, paid: 0, all: 0 };
  for (const r of rows) {
    c.all += r.n;
    if (r.stage === 'lesson') c[String(r.lesson)] = (c[String(r.lesson)] ?? 0) + r.n;
    if (r.stage === 'offer' || r.stage === 'receipt') c.offer += r.n;
    if (r.stage === 'paid') c.paid += r.n;
  }
  return c;
}

// ---- reminders ----

/** People stuck in a stage: 1st reminder after 1 day, 2nd after 3 days (counted from the stage start). */
export async function dueReminders(db, limit = 50) {
  const r = await db.query(
    `SELECT * FROM funnel.users
     WHERE NOT blocked AND stage IN ('lesson', 'offer', 'receipt')
       AND ((reminders = 0 AND stage_at < now() - interval '1 day') OR (reminders = 1 AND stage_at < now() - interval '3 days'))
     ORDER BY stage_at LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function markReminded(db, userId) {
  await db.query('UPDATE funnel.users SET reminders = reminders + 1 WHERE user_id = $1', [userId]);
}

// ---- bot health (sql/005) ----

/** { heartbeat: {at}, stop: {at, reason} } — ISO times. */
export async function getHealth(db) {
  const r = await db.query(`SELECT key, value FROM funnel.bot_state WHERE key IN ('heartbeat', 'stop')`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}

export async function setHealth(db, key, value) {
  await db.query(
    `INSERT INTO funnel.bot_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ---- stats ----

// ---- task events (sql/006) ----

/** Remembers what a student did with a task (task_done / task_wrong / task_skip). Never throws: stats only. */
export async function logEvent(db, userId, kind, lesson, detail = null) {
  try {
    await db.query('INSERT INTO funnel.events (user_id, kind, lesson, detail) VALUES ($1, $2, $3, $4)', [userId, kind, lesson, detail]);
  } catch (e) {
    console.error(`[events] ${kind}: ${e.message}`);
  }
}

/** Per task lesson: how many students sent the task / skipped it / sent something else (by type). */
export async function taskStats(db) {
  return (await db.query(
    `SELECT lesson, kind, COALESCE(detail, '') AS detail, count(DISTINCT user_id)::int AS people, count(*)::int AS times
     FROM funnel.events GROUP BY lesson, kind, detail ORDER BY lesson, kind, detail`,
  )).rows;
}

export async function stats(db) {
  const [totals, lessons, sources, tasks] = await Promise.all([
    db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE stage = 'offer')::int AS offer,
        count(*) FILTER (WHERE stage = 'receipt')::int AS receipt,
        count(*) FILTER (WHERE stage = 'review')::int AS review,
        count(*) FILTER (WHERE stage = 'paid')::int AS paid,
        count(*) FILTER (WHERE blocked)::int AS blocked
      FROM funnel.users`),
    db.query(`SELECT lesson, count(*)::int AS n FROM funnel.users WHERE stage = 'lesson' GROUP BY lesson ORDER BY lesson`),
    db.query(`SELECT COALESCE(source, '') AS source, count(*)::int AS n,
        count(*) FILTER (WHERE stage IN ('offer', 'receipt', 'review', 'paid'))::int AS finished,
        count(*) FILTER (WHERE stage = 'paid')::int AS paid
      FROM funnel.users GROUP BY 1 ORDER BY n DESC LIMIT 15`),
    taskStats(db).catch(() => []), // events table missing (migration 006 not applied) → just no task section
  ]);
  return { ...totals.rows[0], lessons: lessons.rows, sources: sources.rows, tasks };
}
