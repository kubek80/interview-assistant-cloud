-- 0002 Hiring rounds, interviews and everything recorded in them (steps 2 and 3).
--
-- Created now so the whole data model is in one place and the step-1 permission helpers can be
-- tested against real round membership. No API uses these tables yet (step 1 only reads
-- round_members for the Users page). Later steps adjust them with new numbered migrations.
--
-- Deletion: everything hangs off a round with ON DELETE CASCADE, so the retention purge (HPRIV-2)
-- and deletion requests (HPRIV-3) delete a round or interview and everything attached to it in one
-- statement. Users are never hard-deleted once they have signed in (USER-3: their judgements stay
-- under their name), so references to users use ON DELETE RESTRICT or SET NULL.

-- ROUND-1: a group of interviews for one role.
CREATE TABLE rounds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  track_id              text NOT NULL REFERENCES tracks (id),
  requisition_id        text CHECK (requisition_id IS NULL OR length(requisition_id) <= 60),
  state                 text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  retention_until       date NOT NULL,
  -- ROUND-3: the round's default question set (set once the set is fixed).
  default_question_set_id uuid,
  -- LIVE-3: "Hide other people's scores until they have submitted" (hosted FLOW-27).
  hide_others_scores    boolean NOT NULL DEFAULT false,
  -- HPRIV-6: AI can be turned off for a round by its organiser.
  ai_enabled            boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  closed_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  close_reason          text CHECK (close_reason IS NULL OR length(close_reason) <= 4000),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX rounds_retention_idx ON rounds (retention_until);

-- ROUND-2: a round's team. Each member organises the round or interviews in it.
CREATE TABLE round_members (
  round_id   uuid NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('organiser', 'interviewer')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (round_id, user_id)
);
CREATE INDEX round_members_user_idx ON round_members (user_id);

-- FLOW-8, FLOW-9, ROUND-3: a fixed question set ("locked plan"): ordered question snapshots, the
-- category snapshot with this set's weights and must-have flags, the time budget and the fingerprint.
CREATE TABLE question_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id         uuid REFERENCES rounds (id) ON DELETE CASCADE,
  track_id         text NOT NULL REFERENCES tracks (id),
  track_version    text NOT NULL,
  name             text NOT NULL CHECK (length(name) <= 200),
  questions        jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) > 0),
  categories       jsonb NOT NULL CHECK (jsonb_typeof(categories) = 'array'),
  time_budget_min  integer NOT NULL CHECK (time_budget_min BETWEEN 1 AND 1440),
  fingerprint      text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX question_sets_round_idx ON question_sets (round_id);
CREATE INDEX question_sets_fingerprint_idx ON question_sets (fingerprint);
ALTER TABLE rounds ADD CONSTRAINT rounds_default_question_set_fk
  FOREIGN KEY (default_question_set_id) REFERENCES question_sets (id) ON DELETE SET NULL;

-- PRIV-1: a candidate in a round, by name or initials and an optional requisition id.
CREATE TABLE candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  display_name    text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 60),
  requisition_id  text CHECK (requisition_id IS NULL OR length(requisition_id) <= 60),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX candidates_round_idx ON candidates (round_id);

-- ROUND-4, LIVE-2, LIVE-6: one interview and its shared live state. Timers are stored as
-- accumulated milliseconds plus "running since", so every browser derives them from server time
-- (RES-2, HOST-6). `version` increases on every change, for optimistic concurrency.
CREATE TABLE interviews (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id                uuid NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  candidate_id            uuid NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  question_set_id         uuid NOT NULL REFERENCES question_sets (id),
  state                   text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'in_progress', 'paused', 'completed', 'cancelled')),
  scheduled_at            timestamptz,
  note                    text CHECK (note IS NULL OR length(note) <= 2000),
  recording_notice        boolean NOT NULL DEFAULT false,
  retention_until         date NOT NULL,
  consent_at              timestamptz,
  consent_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  recording_consent_at    timestamptz,
  lead_user_id            uuid REFERENCES users (id) ON DELETE SET NULL,
  current_question_id     text,
  timer_accumulated_ms    bigint NOT NULL DEFAULT 0 CHECK (timer_accumulated_ms >= 0),
  timer_running_since     timestamptz,
  question_timers         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(question_timers) = 'object'),
  started_at              timestamptz,
  completed_at            timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interviews_round_idx ON interviews (round_id, scheduled_at);
CREATE INDEX interviews_candidate_idx ON interviews (candidate_id);
CREATE INDEX interviews_retention_idx ON interviews (retention_until);

-- ROUND-4, LIVE-4: who is on an interview's panel and where they are.
CREATE TABLE interview_panel (
  interview_id  uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'joined', 'submitted', 'did_not_take_part')),
  joined_at     timestamptz,
  marked_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (interview_id, user_id)
);
CREATE INDEX interview_panel_user_idx ON interview_panel (user_id);

-- LIVE-1, LIVE-5, TEAM-7, DB-5: one judgement record. A live record belongs to one signed-in panel
-- member (owner_user_id); a record can name more than one person (names); a judgement entered on
-- someone's behalf or imported from a local-app file says so in origin.
CREATE TABLE records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id     uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  owner_user_id    uuid REFERENCES users (id) ON DELETE RESTRICT,
  names            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(names) = 'array'),
  origin           text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'entered', 'imported')),
  entered_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  entered_at       timestamptz,
  state            text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitted')),
  overall_rating   smallint CHECK (overall_rating BETWEEN 1 AND 4),
  recommendation   text CHECK (recommendation IN ('strong_hire', 'hire', 'lean_no_hire', 'no_hire')),
  rationale        text CHECK (rationale IS NULL OR length(rationale) <= 20000),
  submitted_at     timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (origin <> 'live' OR owner_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX records_live_owner_key ON records (interview_id, owner_user_id) WHERE origin = 'live';
CREATE INDEX records_interview_idx ON records (interview_id);

-- FLOW-13…FLOW-18: one record's answer to one question.
CREATE TABLE answers (
  record_id            uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
  question_id          text NOT NULL,
  score                smallint CHECK (score BETWEEN 1 AND 4),
  covered_key_points   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(covered_key_points) = 'array'),
  red_flags_seen       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(red_flags_seen) = 'array'),
  probe_handled        boolean NOT NULL DEFAULT false,
  flagged              boolean NOT NULL DEFAULT false,
  skipped              boolean NOT NULL DEFAULT false,
  skip_reason          text CHECK (skip_reason IS NULL OR length(skip_reason) <= 2000),
  version              integer NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, question_id),
  CHECK (NOT (skipped AND score IS NOT NULL))
);

-- FLOW-15, PANEL-3: notes, one row each so two quick notes never overwrite each other.
CREATE TABLE notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    uuid NOT NULL REFERENCES records (id) ON DELETE CASCADE,
  question_id  text NOT NULL,
  at_sec       integer NOT NULL CHECK (at_sec >= 0),
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  by_name      text CHECK (by_name IS NULL OR length(by_name) <= 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_record_idx ON notes (record_id, question_id, created_at);

-- TEAM-9…TEAM-11, LIVE-9: one panel decision per interview.
CREATE TABLE panel_decisions (
  interview_id     uuid PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
  recommendation   text NOT NULL CHECK (recommendation IN ('strong_hire', 'hire', 'lean_no_hire', 'no_hire')),
  rationale        text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 20000),
  participants     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(participants) = 'array'),
  overall_rating   smallint CHECK (overall_rating BETWEEN 1 AND 4),
  question_scores  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(question_scores) = 'object'),
  decided_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);

-- SUM-4: a candidate's short written summary.
CREATE TABLE written_summaries (
  candidate_id  uuid PRIMARY KEY REFERENCES candidates (id) ON DELETE CASCADE,
  text          text NOT NULL CHECK (length(text) <= 20000),
  ai_draft      boolean NOT NULL DEFAULT false,
  updated_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);

-- TR-1, HPRIV-5: transcripts live in the database.
CREATE TABLE transcripts (
  interview_id   uuid PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
  text           text NOT NULL CHECK (length(text) <= 500000),
  source_format  text NOT NULL CHECK (source_format IN ('paste', 'txt', 'vtt', 'srt', 'docx')),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- TR-2, HPRIV-5: recordings live in private object storage; this is only where and what.
CREATE TABLE recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  storage_key   text NOT NULL UNIQUE,
  media_type    text NOT NULL CHECK (media_type ~ '^(audio|video)/[a-z0-9.+-]+$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_interview_idx ON recordings (interview_id);

-- AI-6…AI-8, HPRIV-6: the AI second opinion for an interview (one current result).
CREATE TABLE ai_results (
  interview_id        uuid PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
  model               text NOT NULL,
  transcript_sha256   text NOT NULL CHECK (transcript_sha256 ~ '^[0-9a-f]{64}$'),
  result              jsonb NOT NULL,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ADD CONSTRAINT audit_events_round_fk
  FOREIGN KEY (round_id) REFERENCES rounds (id) ON DELETE SET NULL;
