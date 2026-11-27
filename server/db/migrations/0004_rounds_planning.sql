-- 0004 Hiring rounds, question sets and planning (step 2a: ROUND-1…ROUND-5, FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15).
--
-- Question sets: a round's default set is created (already drawn) with the round and can be edited in
-- place until the first interview that uses it is planned; then it is fixed (FLOW-8) and its question
-- snapshots never change again. Changing the round's questions after that makes a new set for future
-- interviews (FLOW-9). `fixed_at` says which kind a set is.
ALTER TABLE question_sets
  ADD COLUMN fixed_at   timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version    integer NOT NULL DEFAULT 1;
-- Sets made for one interview ("use different questions for this interview") are fixed from the start.

-- Interviews are scheduled as the organiser typed them: a calendar day and an optional time of day
-- (wall-clock, no time zone). A time needs a day.
ALTER TABLE interviews DROP COLUMN scheduled_at;
ALTER TABLE interviews
  ADD COLUMN scheduled_date date,
  ADD COLUMN scheduled_time text CHECK (scheduled_time IS NULL OR scheduled_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN cancelled_at   timestamptz,
  ADD COLUMN cancelled_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT interviews_time_needs_day CHECK (scheduled_time IS NULL OR scheduled_date IS NOT NULL),
  ADD CONSTRAINT interviews_cancelled_state CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL));
DROP INDEX IF EXISTS interviews_round_idx;
CREATE INDEX interviews_round_idx ON interviews (round_id, scheduled_date, scheduled_time);
CREATE INDEX interviews_question_set_idx ON interviews (question_set_id);

-- PRIV-1: a candidate is matched within a round by name or initials plus requisition id, ignoring
-- case and extra spaces (the candidate key of FLOW-29), so one candidate can have several interviews.
ALTER TABLE candidates ADD COLUMN key text;
UPDATE candidates SET key = upper(regexp_replace(btrim(display_name), '\s+', ' ', 'g')) || '|' || upper(regexp_replace(btrim(coalesce(requisition_id, '')), '\s+', ' ', 'g'));
ALTER TABLE candidates ALTER COLUMN key SET NOT NULL;
CREATE UNIQUE INDEX candidates_round_key ON candidates (round_id, key);
