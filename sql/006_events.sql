-- What happens around tasks, to see where students stumble (shown in /stats). Idempotent.
-- kind: task_done (sent the task video) · task_wrong (sent something else instead: detail = text|link|photo|file|video_file|voice|sticker|gif|audio|other)
--       task_skip (pressed «⏭ Tapşırıqsız davam et» after a day without the task)
CREATE TABLE IF NOT EXISTS funnel.events (
  id      bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  kind    text NOT NULL,
  lesson  int,
  detail  text,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_kind_lesson_idx ON funnel.events (kind, lesson);
