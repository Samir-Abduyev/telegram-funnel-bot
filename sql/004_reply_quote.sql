-- The owner's answer is sent as a REPLY to the student's own message (question / task video / receipt),
-- so the student sees which question was answered. Idempotent.
ALTER TABLE funnel.owner_msgs ADD COLUMN IF NOT EXISTS student_msg_id bigint;
