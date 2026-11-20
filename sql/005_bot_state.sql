-- Bot health: «heartbeat» (written every minute while the bot runs) and «stop» (graceful stop / fatal error).
-- On start the bot compares them and tells the owner how long it was down and why. Idempotent.
CREATE TABLE IF NOT EXISTS funnel.bot_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
