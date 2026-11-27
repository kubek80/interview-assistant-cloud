// Kysely table types, written by hand to match server/db/migrations/*.sql. When a migration changes
// a table, change it here too (the server tests run every query against the real schema).
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type TimestampNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as the parsed value; written as JSON text (pg does not stringify arrays as JSON). */
type Json<T> = ColumnType<T, string, string>;
type JsonNull<T> = ColumnType<T | null, string | null | undefined, string | null>;

export type Role = 'admin' | 'organiser' | 'interviewer' | 'reviewer';

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

// ---- Question sets, candidates and interviews (migrations 0002 and 0004, step 2) ----

export interface QuestionSetsTable {
  id: Generated<string>;
  round_id: string | null;
  track_id: string;
  track_version: string;
  name: string;
  /** Ordered question snapshots (src/domain/types Question). */
  questions: Json<import('../../src/domain/types').Question[]>;
  /** The set's categories with its own weights and must-have flags (FLOW-6). */
  categories: Json<import('../../src/domain/types').PlanCategory[]>;
  time_budget_min: number;
  fingerprint: string;
  created_at: Generated<Date>;
  created_by: string | null;
  /** FLOW-8: set when the first interview using it is planned; then it never changes. */
  fixed_at: TimestampNull;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface CandidatesTable {
  id: Generated<string>;
  round_id: string;
  display_name: string;
  requisition_id: string | null;
  /** candidateKey(): name and requisition, upper case, spaces collapsed; unique per round. */
  key: string;
  created_at: Generated<Date>;
  created_by: string | null;
}

export type InterviewState = 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export interface InterviewsTable {
  id: Generated<string>;
  round_id: string;
  candidate_id: string;
  question_set_id: string;
  state: Generated<InterviewState>;
  scheduled_date: ColumnType<string | null, string | null | undefined, string | null>;
  scheduled_time: string | null;
  note: string | null;
  recording_notice: Generated<boolean>;
  retention_until: ColumnType<string, string, string>;
  consent_at: TimestampNull;
  consent_by: string | null;
  recording_consent_at: TimestampNull;
  lead_user_id: string | null;
  current_question_id: string | null;
  timer_accumulated_ms: Generated<number>;
  timer_running_since: TimestampNull;
  question_timers: ColumnType<Record<string, unknown>, string | undefined, string>;
  started_at: TimestampNull;
  completed_at: TimestampNull;
  cancelled_at: TimestampNull;
  cancelled_by: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  created_by: string | null;
  updated_at: Generated<Date>;
}

export type PanelStatus = 'expected' | 'joined' | 'submitted' | 'did_not_take_part';

export interface InterviewPanelTable {
  interview_id: string;
  user_id: string;
  status: Generated<PanelStatus>;
  joined_at: TimestampNull;
  marked_by: string | null;
}

// ---- Question review (migration 0003, REVIEW-1 to REVIEW-7) ----

export interface ReviewRequestsTable {
  id: Generated<string>;
  track_id: string;
  scope: 'track' | 'category' | 'questions';
  category_id: string | null;
  note: Generated<string>;
  due_date: ColumnType<string | null, string | null | undefined, string | null>;
  state: Generated<'open' | 'closed'>;
  created_by: string | null;
  created_at: Generated<Date>;
  closed_at: TimestampNull;
}

export interface ReviewRequestItemsTable {
  request_id: string;
  question_id: string;
  position: number;
}

export interface ReviewRequestReviewersTable {
  request_id: string;
  user_id: string;
}

export type ReviewOutcome = 'looks_good' | 'commented' | 'proposed' | 'nothing_to_add';

export interface ReviewProgressTable {
  request_id: string;
  user_id: string;
  question_id: string;
  outcome: ReviewOutcome;
  updated_at: Generated<Date>;
}

export type ProposalStatus = 'open' | 'accepted' | 'accepted_with_edits' | 'declined' | 'withdrawn';

export interface QuestionProposalsTable {
  id: Generated<string>;
  kind: 'change' | 'new';
  track_id: string;
  question_id: string | null;
  base_version: number | null;
  proposed: Json<Record<string, unknown>>;
  new_category_name: string | null;
  reason: string;
  status: Generated<ProposalStatus>;
  proposed_by: string;
  created_at: Generated<Date>;
  review_request_id: string | null;
  decided_by: string | null;
  decided_at: TimestampNull;
  decision_reason: string | null;
  result_question_id: string | null;
  result_version: number | null;
}

export interface QuestionCommentsTable {
  id: Generated<string>;
  question_id: string;
  author_id: string;
  text: string;
  question_version: number;
  review_request_id: string | null;
  created_at: Generated<Date>;
}

export interface QuestionLooksGoodTable {
  question_id: string;
  user_id: string;
  question_version: number;
  created_at: Generated<Date>;
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
  question_sets: QuestionSetsTable;
  candidates: CandidatesTable;
  interviews: InterviewsTable;
  interview_panel: InterviewPanelTable;
  review_requests: ReviewRequestsTable;
  review_request_items: ReviewRequestItemsTable;
  review_request_reviewers: ReviewRequestReviewersTable;
  review_progress: ReviewProgressTable;
  question_proposals: QuestionProposalsTable;
  question_comments: QuestionCommentsTable;
  question_looks_good: QuestionLooksGoodTable;
}

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type QuestionRow = Selectable<QuestionsTable>;
export type CategoryRow = Selectable<CategoriesTable>;
export type TrackRow = Selectable<TracksTable>;
