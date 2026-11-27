-- 0006 The debrief, panel decisions, judgements entered on someone's behalf and the Summary
-- (step 2b, second part: LIVE-9, TEAM-6…TEAM-12, SUM-1…SUM-6, SCORE-11, FLOW-28, FLOW-30).
--
-- panel_decisions and written_summaries exist since 0002; records already allow origin 'entered'.
-- This adds what using them needs:
--   - records.entered_for: the round member on whose behalf a judgement was entered (null when it was
--     entered for someone without access, named only in `names`). One entered judgement per person
--     and interview; a later live record of that person supersedes it (see server/panel/service.ts).
--   - panel_decisions: who first recorded it and when (decided_by/decided_at stay "last changed").
--   - written_summaries: last-edited-by is updated_by (already there); nothing to add.
--   - indexes for the Summary's one query path (SUM-6): records of many interviews by state.

ALTER TABLE records
  ADD COLUMN entered_for uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT records_entered_has_enterer CHECK (origin <> 'entered' OR entered_at IS NOT NULL),
  ADD CONSTRAINT records_entered_for_only_entered CHECK (entered_for IS NULL OR origin = 'entered');
CREATE UNIQUE INDEX records_entered_for_key ON records (interview_id, entered_for) WHERE origin = 'entered' AND entered_for IS NOT NULL;

-- The Summary reads the submitted records of all a round's interviews at once.
CREATE INDEX records_interview_state_idx ON records (interview_id, state);

ALTER TABLE panel_decisions
  ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
