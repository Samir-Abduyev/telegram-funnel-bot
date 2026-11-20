-- «One screen» interface: ids of the bot's messages currently shown to the student.
-- Before showing the next screen the bot deletes them, so the chat does not fill up. Idempotent.
ALTER TABLE funnel.users ADD COLUMN IF NOT EXISTS screen_ids bigint[] NOT NULL DEFAULT '{}';
