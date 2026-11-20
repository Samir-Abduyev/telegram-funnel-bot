-- Funnel bot: free lessons → payment → receipt check → closed group.
-- Idempotent (IF NOT EXISTS): safe to run again. Everything lives in schema `funnel`,
-- so it can share a Supabase project with other bots without clashing.
CREATE SCHEMA IF NOT EXISTS funnel;

-- One row per person who pressed /start.
-- stage: lesson (watching lesson `lesson`) → offer (payment offered) → receipt (pressed «Ödədim», we wait for a receipt)
--        → review (receipt sent, owner decides) → paid (approved; may join the group).
CREATE TABLE IF NOT EXISTS funnel.users (
  user_id     bigint PRIMARY KEY,
  first_name  text NOT NULL DEFAULT '',
  username    text,
  source      text,                                   -- /start payload (t.me/bot?start=kanal)
  stage       text NOT NULL DEFAULT 'lesson' CHECK (stage IN ('lesson', 'offer', 'receipt', 'review', 'paid')),
  lesson      int  NOT NULL DEFAULT 1,
  stage_at    timestamptz NOT NULL DEFAULT now(),     -- when the current stage began (reminders count from here)
  reminders   int  NOT NULL DEFAULT 0,                -- reminders sent in the current stage (max 2)
  blocked     boolean NOT NULL DEFAULT false,         -- the person blocked the bot
  invite_link text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);
CREATE INDEX IF NOT EXISTS users_remind_idx ON funnel.users (stage, stage_at) WHERE NOT blocked;

-- What the bot sends. slot: 'welcome', 'offer' or a lesson number '1'..'9'. Set by the owner with /set.
CREATE TABLE IF NOT EXISTS funnel.content (
  slot       text PRIMARY KEY CHECK (slot ~ '^(welcome|offer|[1-9])$'),
  kind       text NOT NULL,                           -- text | video | photo | document | animation | video_note | voice | audio
  file_id    text,
  text       text NOT NULL DEFAULT '',                -- message text or caption
  entities   jsonb NOT NULL DEFAULT '[]',             -- Telegram formatting of `text`
  has_task   boolean NOT NULL DEFAULT false,          -- lesson needs a video from the student before the next one
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funnel.receipts (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES funnel.users (user_id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS funnel.schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
