// The JSON contract between the browser app and the server (types only; no runtime code). The
// server validates every request body with zod (server/**/routes.ts); these are the shapes it
// returns. Times are ISO 8601 strings in UTC.
import type { Category, Question, Track, TrackFile } from '../domain/types';

/** Every error response: `{ error: { code, message, details? } }`. Messages are safe to show. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field problems by field name, or a list of problems (validation, imports). */
    details?: string[] | Record<string, string>;
    /** Quote this when reporting a server error. */
    requestId?: string;
  };
}

export type ApiErrorCode =
  | 'invalid' // 400: the request does not fit (field problems in details)
  | 'not_signed_in' // 401
  | 'forbidden' // 403: signed in but not allowed
  | 'csrf' // 403: missing or wrong anti-forgery header or origin
  | 'not_found' // 404 (also for things that exist but the actor may not know about)
  | 'conflict' // 409: changed meanwhile, or a rule like "last administrator"
  | 'too_large' // 413
  | 'unsupported' // 415
  | 'rate_limited' // 429
  | 'unavailable' // 503
  | 'internal'; // 500

/** Header every state-changing request must carry (AUTH-5 cross-site request forgery protection). */
export const CSRF_HEADER = 'x-ia-request';
export const CSRF_HEADER_VALUE = '1';

export type Role = 'admin' | 'organiser' | 'interviewer' | 'reviewer';
export const ROLES: readonly Role[] = ['admin', 'organiser', 'interviewer', 'reviewer'];
export const ROLE_LABELS: Record<Role, string> = { admin: 'Administrator', organiser: 'Organiser', interviewer: 'Interviewer', reviewer: 'Question reviewer' };

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  /** Global permissions (server/authz/policy.ts); the server checks them again on every request. */
  permissions: string[];
}

export interface AuthOptions {
  google: boolean;
  devSignIn: boolean;
}

export interface DevUser {
  email: string;
  name: string | null;
  role: Role;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  /** Rounds this person is on (ROUND-2), by name. */
  rounds: Array<{ id: string; name: string; role: 'organiser' | 'interviewer' }>;
}

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` for the next page; null when this is the last page. */
  nextCursor: string | null;
}

/** USER-1: one line of the "add many" preview. */
export interface InvitePreviewLine {
  input: string;
  email: string | null;
  outcome: 'add' | 'exists' | 'duplicate' | 'invalid';
  /** For 'exists': their current role and whether they are active. */
  existing?: { role: Role; active: boolean };
}

export interface InviteResult {
  added: UserSummary[];
  skipped: InvitePreviewLine[];
}

export interface TrackSummary extends Track {
  /** BANK-14: when changes not yet exported started; null when there are none. */
  changedAt: string | null;
  exportedAt: string | null;
  questions: number;
  active: number;
  categories: number;
}

export interface TrackBank {
  track: Track;
  /** In the track's category order. */
  categories: Category[];
  /** Ordered by number; includes retired questions. */
  questions: Question[];
  changedAt: string | null;
}

export interface SaveQuestionResult {
  id: string;
  number: number;
  version: number;
  bumped: boolean;
  changed: boolean;
}

export interface ExportedTrack {
  fileName: string;
  mime: string;
  text: string;
  version: string;
}

/** DB-2, DB-3: what an import would do (or did) to one track. */
export interface ImportTrackReport {
  trackId: string;
  name: string;
  source: string;
  /** New track, or an existing one. */
  trackAction: 'create' | 'update' | 'unchanged';
  trackChanges: string[];
  categoriesAdded: string[];
  categoriesChanged: string[];
  added: Array<{ id: string; number: number; text: string }>;
  changed: Array<{ id: string; number: number; text: string; fromVersion: number; toVersion: number; fields: string[] }>;
  unchanged: number;
  /** In the database but newer there than in the file: left as they are. */
  keptNewer: Array<{ id: string; number: number; databaseVersion: number; fileVersion: number }>;
  /** In the database, not in the file: left as they are. */
  notInFile: number;
}

export interface ImportReport {
  ok: boolean;
  /** Problems by file; nothing is written when there are any. */
  problems: Array<{ source: string; messages: string[] }>;
  tracks: ImportTrackReport[];
  dryRun: boolean;
  applied: boolean;
}

/** One file for the in-app import (DB-3). CSV needs the track it belongs to. */
export interface ImportFileInput {
  name: string;
  text: string;
  trackId?: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface OrgSettings {
  defaultRetentionDays: number;
  aiEnabled: boolean;
}

/** A live update (HOST-5): a hint that something in `topic` changed; clients refetch. */
export interface LiveEvent {
  topic: string;
  kind: string;
  id?: string;
}

export type { TrackFile };

// ---- Question review (REVIEW-1 to REVIEW-7) ----

export type ProposalStatus = 'open' | 'accepted' | 'accepted_with_edits' | 'declined' | 'withdrawn';
export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  open: 'Waiting for a decision',
  accepted: 'Accepted',
  accepted_with_edits: 'Accepted with edits',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/** The editable fields of a question, as the editor form has them (src/domain/bankEdit.ts QuestionDraft). */
export type { QuestionDraft } from '../domain/bankEdit';

export interface PersonRef {
  id: string | null;
  name: string;
}

export interface ProposalSummary {
  id: string;
  kind: 'change' | 'new';
  trackId: string;
  trackName: string;
  questionId: string | null;
  questionNumber: number | null;
  /** The question's version the proposal was written against, and its version now. */
  baseVersion: number | null;
  currentVersion: number | null;
  /** REVIEW-6: the question has changed since the proposal was written. */
  outOfDate: boolean;
  /** The proposed question text. */
  text: string;
  reason: string;
  status: ProposalStatus;
  proposedBy: PersonRef;
  createdAt: string;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionReason: string | null;
  resultQuestionId: string | null;
  resultVersion: number | null;
  reviewRequestId: string | null;
}

export interface ProposalDetail extends ProposalSummary {
  proposed: import('../domain/bankEdit').QuestionDraft;
  newCategoryName: string | null;
  /** The question as it is now (a change), for the side-by-side comparison. */
  current: import('../domain/types').Question | null;
  /** The question as it was when the proposal was written (shown when out of date). */
  base: import('../domain/types').Question | null;
  categories: import('../domain/types').Category[];
}

export interface QuestionFeedback {
  comments: Array<{ id: string; author: string; text: string; createdAt: string; questionVersion: number; mine: boolean }>;
  looksGood: Array<{ name: string; version: number; at: string; mine: boolean }>;
}

export type ReviewOutcome = 'looks_good' | 'commented' | 'proposed' | 'nothing_to_add';

export interface ReviewRequestSummary {
  id: string;
  trackId: string;
  trackName: string;
  scope: 'track' | 'category' | 'questions';
  /** "Whole track", the category's name, or "12 chosen questions". */
  scopeLabel: string;
  note: string;
  dueDate: string | null;
  state: 'open' | 'closed';
  requestedBy: string;
  createdAt: string;
  total: number;
  reviewers: Array<{ id: string; name: string; done: number; proposals: number; comments: number }>;
}

export interface ReviewRequestDetail extends ReviewRequestSummary {
  proposals: ProposalSummary[];
}

export interface MyReview {
  id: string;
  trackId: string;
  trackName: string;
  scopeLabel: string;
  note: string;
  dueDate: string | null;
  state: 'open' | 'closed';
  requestedBy: string;
  total: number;
  done: number;
}

export interface MyReviewDetail extends MyReview {
  items: Array<{ questionId: string; number: number; text: string; outcome: ReviewOutcome | null }>;
}

export interface ReviewCounts {
  /** Organisers and administrators: proposals waiting for a decision. */
  openProposals: number;
  /** Reviewers: questions in open review requests they have not done yet. */
  openReviewItems: number;
}

export interface ReviewerOption {
  id: string;
  name: string;
  email: string;
}
