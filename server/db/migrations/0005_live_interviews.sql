-- 0005 Interviewing together (step 2b: LIVE-1…LIVE-8, FLOW-10…FLOW-25, HOST-6, AUD-4).
--
-- The shared interview (state, current question, lead, timers, consent) is already on `interviews`
-- (migration 0002) and every change to it raises `version`. This adds:
--   - records.shared_with: panel members who score on the owner's screen (LIVE-5, PANEL-2);
--   - interview_presence: who has the interview open right now, by heartbeat, in the database so
--     every server instance sees the same (LIVE-3, HOST-5).
-- Answers keep their per-row `version`, bumped on every change.

-- LIVE-5, PANEL-2…PANEL-4: a record can speak for more than one panel member (one shared screen).
-- The owner is owner_user_id; the others are listed here and follow the record (joined, submitted).
ALTER TABLE records
  ADD COLUMN shared_with jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shared_with) = 'array');

-- LIVE-3: one row per person with the interview open; `seen_at` is their last heartbeat.
CREATE TABLE interview_presence (
  interview_id  uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, user_id)
);

-- A note's id is chosen by the browser (a random UUID) so a note resent after a lost connection is
-- stored once (HOST-6). The primary key already makes that safe; nothing to change for notes.

-- The live screens read a record's answers and notes together.
CREATE INDEX answers_record_idx ON answers (record_id);
