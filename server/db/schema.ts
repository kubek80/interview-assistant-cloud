// Kysely table types, written by hand to match server/db/migrations/*.sql. When a migration changes
// a table, change it here too (the server tests run every query against the real schema).
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type TimestampNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as the parsed value; written as JSON text (pg does not stringify arrays as JSON). */
type Json<T> = ColumnType<T, string, string>;
type JsonNull<T> = ColumnType<T | null, string | null | undefined, string | null>;

export type Role = 'admin' | 'organiser' | 'interviewer';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  role: Role;
  active: Generated<boolean>;
  google_sub: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
  last_sign_in_at: TimestampNull;
  deactivated_at: TimestampNull;
}

export interface AuthSessionsTable {
  id_hash: Buffer;
  user_id: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  method: 'google' | 'dev';
}

export interface AuthLoginsTable {
  flow_hash: Buffer;
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  created_at: Generated<Date>;
}

export interface OrgSettingsTable {
  id: Generated<boolean>;
  default_retention_days: number;
  ai_enabled: boolean;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface TracksTable {
  id: string;
  name: string;
  version: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  changed_at: TimestampNull;
  exported_at: TimestampNull;
}

export interface CategoriesTable {
  id: string;
  track_id: string;
  /** numeric(6,3); parsed to a number (see pool.ts). */
  weight: ColumnType<number, number | undefined, number>;
  name: string;
  must_have: Generated<boolean>;
  position: Generated<number>;
}

export interface QuestionsTable {
  id: string;
  track_id: string;
  number: number;
  category_id: string;
  text: string;
  description: string;
  difficulty: 'core' | 'advanced' | 'expert';
  type: 'knowledge' | 'scenario' | 'design' | 'behavioural';
  time_min: number;
  look_for: Json<string[]>;
  red_flags: Json<string[]>;
  probes: Json<string[]>;
  rubric_override: JsonNull<Partial<Record<'1' | '2' | '3' | '4', string>>>;
  version: Generated<number>;
  status: Generated<'active' | 'retired'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface QuestionVersionsTable {
  question_id: string;
  version: number;
  snapshot: Json<unknown>;
  created_at: Generated<Date>;
  created_by: string | null;
  source: 'import' | 'create' | 'edit';
}

export interface AuditEventsTable {
  id: Generated<string>;
  at: Generated<Date>;
  actor_id: string | null;
  actor_label: string;
  action: string;
  entity: string;
  entity_id: string | null;
  round_id: string | null;
  before: JsonNull<unknown>;
  after: JsonNull<unknown>;
  reason: string | null;
}

export interface SchemaMigrationsTable {
  version: number;
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
}

// ---- Step 2 and 3 tables (migration 0002). Only what step 1 reads is typed in detail. ----

export interface RoundsTable {
  id: Generated<string>;
  name: string;
  track_id: string;
  requisition_id: string | null;
  state: Generated<'open' | 'closed'>;
  retention_until: ColumnType<string, string, string>;
  default_question_set_id: string | null;
  hide_others_scores: Generated<boolean>;
  ai_enabled: Generated<boolean>;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
  closed_at: TimestampNull;
  closed_by: string | null;
  close_reason: string | null;
}

export interface RoundMembersTable {
  round_id: string;
  user_id: string;
  role: 'organiser' | 'interviewer';
  added_at: Generated<Date>;
  added_by: string | null;
}

export interface Database {
  users: UsersTable;
  auth_sessions: AuthSessionsTable;
  auth_logins: AuthLoginsTable;
  org_settings: OrgSettingsTable;
  tracks: TracksTable;
  categories: CategoriesTable;
  questions: QuestionsTable;
  question_versions: QuestionVersionsTable;
  audit_events: AuditEventsTable;
  schema_migrations: SchemaMigrationsTable;
  rounds: RoundsTable;
  round_members: RoundMembersTable;
}

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type QuestionRow = Selectable<QuestionsTable>;
export type CategoryRow = Selectable<CategoriesTable>;
export type TrackRow = Selectable<TracksTable>;
