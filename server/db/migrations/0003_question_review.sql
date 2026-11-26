-- 0003 Question reviewers and the review workflow (REVIEW-1 to REVIEW-7).

-- REVIEW-1: a fourth role. Reviewers work on the question bank only.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'organiser', 'interviewer', 'reviewer'));

-- REVIEW-7: a request to review part of the bank. Its questions are fixed when it is made, so
-- progress stays meaningful when questions are added later.
CREATE TABLE review_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id     text NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('track', 'category', 'questions')),
  category_id  text REFERENCES categories (id) ON DELETE SET NULL,
  note         text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  due_date     date,
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
CREATE INDEX review_requests_state_idx ON review_requests (state, created_at DESC);

CREATE TABLE review_request_items (
  request_id   uuid NOT NULL REFERENCES review_requests (id) ON DELETE CASCADE,
  question_id  text NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  position     integer NOT NULL,
  PRIMARY KEY (request_id, question_id)
);

CREATE TABLE review_request_reviewers (
  request_id  uuid NOT NULL REFERENCES review_requests (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX review_request_reviewers_user_idx ON review_request_reviewers (user_id);

-- A reviewer's progress on one question of a request: done once they have proposed, commented
-- or marked it as looking good (or said they have nothing to add).
CREATE TABLE review_progress (
  request_id   uuid NOT NULL,
  user_id      uuid NOT NULL,
  question_id  text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('looks_good', 'commented', 'proposed', 'nothing_to_add')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id, question_id),
  FOREIGN KEY (request_id, question_id) REFERENCES review_request_items (request_id, question_id) ON DELETE CASCADE,
  FOREIGN KEY (request_id, user_id) REFERENCES review_request_reviewers (request_id, user_id) ON DELETE CASCADE
);

-- REVIEW-2, REVIEW-3, REVIEW-5, REVIEW-6: a proposed change to a question, or a proposed new one.
-- `proposed` is the full set of question fields (the editor's draft). A change records the version
-- it was written against; when the question has moved on since, the proposal is out of date.
CREATE TABLE question_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('change', 'new')),
  track_id           text NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  question_id        text REFERENCES questions (id) ON DELETE CASCADE,
  base_version       integer,
  proposed           jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  -- A new question may suggest a new category by name (created only if accepted).
  new_category_name  text CHECK (new_category_name IS NULL OR length(btrim(new_category_name)) BETWEEN 1 AND 120),
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'accepted_with_edits', 'declined', 'withdrawn')),
  proposed_by        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  review_request_id  uuid REFERENCES review_requests (id) ON DELETE SET NULL,
  decided_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at         timestamptz,
  decision_reason    text CHECK (decision_reason IS NULL OR length(decision_reason) <= 2000),
  result_question_id text REFERENCES questions (id) ON DELETE SET NULL,
  result_version     integer,
  CHECK ((kind = 'change') = (question_id IS NOT NULL AND base_version IS NOT NULL)),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK (status <> 'declined' OR length(btrim(coalesce(decision_reason, ''))) > 0)
);
CREATE INDEX question_proposals_status_idx ON question_proposals (status, created_at DESC);
CREATE INDEX question_proposals_by_idx ON question_proposals (proposed_by, created_at DESC);
CREATE INDEX question_proposals_question_idx ON question_proposals (question_id);

-- REVIEW-4: comments on a question (plain text) and each reviewer's "looks good" mark.
CREATE TABLE question_comments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id        text NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  author_id          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  text               text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 4000),
  question_version   integer NOT NULL,
  review_request_id  uuid REFERENCES review_requests (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX question_comments_question_idx ON question_comments (question_id, created_at);

CREATE TABLE question_looks_good (
  question_id       text NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question_version  integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, user_id)
);
