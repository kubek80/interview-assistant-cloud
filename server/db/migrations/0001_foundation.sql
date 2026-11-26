-- 0001 Foundation (step 1): people and access, sessions, organisation settings, the audit log and
-- the question bank. Applied by `npm run db:migrate` (HOST-4) inside one transaction.
--
-- Conventions for every migration:
--   * ids of things that can carry candidate data are random UUIDs (PRIV-3); bank ids keep their
--     readable seed form ("qa", "qa-11", "qa-automation") because the track file format uses them;
--   * times are timestamptz; dates that are calendar days (retention) are date;
--   * real constraints: foreign keys, checks and unique keys, so bad data cannot get in even past the API;
--   * never edit a migration once it is applied anywhere: add a new numbered file instead.

-- People with access (USER-1…USER-4, AUTH-2, AUTH-3).
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email LIKE '%_@_%'),
  name             text CHECK (name IS NULL OR length(name) <= 200),
  role             text NOT NULL CHECK (role IN ('admin', 'organiser', 'interviewer')),
  active           boolean NOT NULL DEFAULT true,
  google_sub       text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at  timestamptz,
  deactivated_at   timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_role_active_idx ON users (role) WHERE active;

-- Signed-in sessions (AUTH-4). The cookie holds a random token; only its keyed hash is stored, so a
-- copy of this table cannot be used to sign in. Idle expiry is last_seen_at + the configured idle time.
CREATE TABLE auth_sessions (
  id_hash       bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  method        text NOT NULL CHECK (method IN ('google', 'dev'))
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_last_seen_idx ON auth_sessions (last_seen_at);

-- Sign-ins in progress (AUTH-1): state, nonce and PKCE verifier for one Google round trip, bound to
-- the browser by a short-lived cookie whose keyed hash is the key. Used once, then deleted.
CREATE TABLE auth_logins (
  flow_hash      bytea PRIMARY KEY,
  state          text NOT NULL,
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,
  return_to      text NOT NULL CHECK (length(return_to) <= 512),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_logins_created_idx ON auth_logins (created_at);

-- Organisation settings, one row (replaces the local app's "This device" settings).
CREATE TABLE org_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_retention_days  integer NOT NULL DEFAULT 90 CHECK (default_retention_days BETWEEN 1 AND 3650),
  ai_enabled              boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO org_settings (id) VALUES (true);

-- The question bank (DB-1, BANK-9…BANK-14).
CREATE TABLE tracks (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9]{0,29}$'),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  version      text NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]{2}(\.[0-9]+)?$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- BANK-14: when changes not yet exported as a track file started; null when there are none.
  changed_at   timestamptz,
  exported_at  timestamptz
);
CREATE UNIQUE INDEX tracks_name_key ON tracks (lower(btrim(name)));

CREATE TABLE categories (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  track_id   text NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  weight     numeric(6, 3) NOT NULL DEFAULT 1 CHECK (weight >= 0.1 AND weight <= 10),
  must_have  boolean NOT NULL DEFAULT false,
  position   integer NOT NULL DEFAULT 0,
  UNIQUE (id, track_id)
);
CREATE UNIQUE INDEX categories_name_key ON categories (track_id, lower(btrim(name)));

CREATE TABLE questions (
  id               text PRIMARY KEY,
  track_id         text NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  number           integer NOT NULL CHECK (number > 0),
  category_id      text NOT NULL,
  text             text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  description      text NOT NULL CHECK (length(description) BETWEEN 1 AND 20000),
  difficulty       text NOT NULL CHECK (difficulty IN ('core', 'advanced', 'expert')),
  type             text NOT NULL CHECK (type IN ('knowledge', 'scenario', 'design', 'behavioural')),
  time_min         integer NOT NULL CHECK (time_min BETWEEN 1 AND 600),
  look_for         jsonb NOT NULL CHECK (jsonb_typeof(look_for) = 'array'),
  red_flags        jsonb NOT NULL CHECK (jsonb_typeof(red_flags) = 'array'),
  probes           jsonb NOT NULL CHECK (jsonb_typeof(probes) = 'array'),
  rubric_override  jsonb CHECK (rubric_override IS NULL OR jsonb_typeof(rubric_override) = 'object'),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track_id, number),
  CHECK (id = track_id || '-' || number),
  -- The category must belong to the same track.
  FOREIGN KEY (category_id, track_id) REFERENCES categories (id, track_id)
);
CREATE INDEX questions_category_idx ON questions (category_id);

-- BANK-11, FLOW-8: every version a question has had, as the full question at that version. Plans
-- snapshot questions themselves; this is the history ("what did version 2 say?").
CREATE TABLE question_versions (
  question_id  text NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version >= 1),
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  source       text NOT NULL CHECK (source IN ('import', 'create', 'edit')),
  PRIMARY KEY (question_id, version)
);

-- The audit log (HPRIV-4, AUD-1, USER-4, BANK-14). Append-only: the trigger below refuses updates
-- and deletes, except an update made by the retention purge or a deletion request (step 3), which
-- sets `ia.audit_redaction = 'on'` for its own transaction to redact candidate text.
CREATE TABLE audit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Who it was at the time ("Ada Lovelace <ada@example.com>", or "system" for scripts and jobs).
  actor_label  text NOT NULL CHECK (length(actor_label) <= 400),
  action       text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)*$'),
  entity       text NOT NULL CHECK (entity ~ '^[a-z_]+$'),
  entity_id    text CHECK (entity_id IS NULL OR length(entity_id) <= 200),
  -- Set for events inside a hiring round (step 2), so organisers can see their rounds' entries.
  round_id     uuid,
  before       jsonb,
  after        jsonb,
  reason       text CHECK (reason IS NULL OR length(reason) <= 4000)
);
CREATE INDEX audit_events_at_idx ON audit_events (at DESC, id DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, id DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity, entity_id);
CREATE INDEX audit_events_round_idx ON audit_events (round_id, id DESC) WHERE round_id IS NOT NULL;

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('ia.audit_redaction', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
