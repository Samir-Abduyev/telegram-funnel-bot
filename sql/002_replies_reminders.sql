-- Owner replies through the bot + reminder about receipts waiting too long. Idempotent.

-- Which student a message in the owner's chat is about: the owner taps «Reply» on it → the bot delivers the answer.
CREATE TABLE IF NOT EXISTS funnel.owner_msgs (
  owner_msg_id bigint PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES funnel.users (user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE funnel.receipts ADD COLUMN IF NOT EXISTS owner_msg_id bigint;   -- the receipt copy in the owner's chat
ALTER TABLE funnel.receipts ADD COLUMN IF NOT EXISTS reminded boolean NOT NULL DEFAULT false;
