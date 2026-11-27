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

// ---- Hiring rounds, question sets and planning (ROUND-1…ROUND-5, FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15) ----

/** A person's place in one round's team (ROUND-2). */
export type RoundRole = 'organiser' | 'interviewer';
export const ROUND_ROLE_LABELS: Record<RoundRole, string> = { organiser: 'Organiser', interviewer: 'Interviewer' };

export interface RoundMember {
  id: string;
  name: string;
  email: string;
  role: RoundRole;
  /** Their role in the organisation (USER-2). */
  globalRole: Role;
  active: boolean;
}

/** Interviews of a round by where they are (src/domain/rounds.ts interviewStatus). */
export interface RoundCounts {
  upcoming: number;
  inProgress: number;
  waiting: number;
  finished: number;
}

export interface RoundSummary {
  id: string;
  name: string;
  trackId: string;
  trackName: string;
  requisitionId: string | null;
  state: 'open' | 'closed';
  /** The signed-in person's role in this round; null for an administrator who is not on it. */
  myRole: RoundRole | null;
  team: Array<{ id: string; name: string; role: RoundRole }>;
  counts: RoundCounts;
  retentionUntil: string;
  createdAt: string;
}

export interface RoundDetail extends Omit<RoundSummary, 'team'> {
  team: RoundMember[];
  /** LIVE-3: "Hide other people's scores until you have submitted yours" (stored; used in step 2b). */
  hideOthersScores: boolean;
  closedAt: string | null;
  closeReason: string | null;
  defaultQuestionSetId: string | null;
  /** What the signed-in person may do here (the server checks every request again). */
  canManage: boolean;
  canPlan: boolean;
}

/** A person who can be put on a round's team (active; not a question reviewer). */
export interface TeamOption {
  id: string;
  name: string;
  email: string;
  globalRole: Role;
  /** ROUND-2: only organisers and administrators can organise a round. */
  canOrganise: boolean;
}

/** FLOW-8, FLOW-9, ROUND-3: a question set with its question snapshots and comparison code. */
export interface QuestionSetDetail {
  id: string;
  roundId: string | null;
  trackId: string;
  trackVersion: string;
  name: string;
  questions: import('../domain/types').Question[];
  categories: import('../domain/types').PlanCategory[];
  timeBudgetMin: number;
  /** FLOW-9: the comparison code (shown shortened). */
  fingerprint: string;
  /** FLOW-8: fixed once the first interview using it was planned. */
  fixed: boolean;
  fixedAt: string | null;
  /** Interviews (not cancelled) that use it. */
  interviews: number;
  /** It is the round's current question set. */
  isRoundDefault: boolean;
  /** Increases with every change (optimistic concurrency for editing an unfixed set). */
  version: number;
}

/** The questions of a set as the editor sends them; the server takes the snapshots from the bank. */
export interface QuestionSetInput {
  questionIds: string[];
  categories: Array<{ id: string; weight: number; mustHave: boolean }>;
  timeBudgetMin: number;
  name?: string;
}

export interface SaveQuestionSetResult {
  set: QuestionSetDetail;
  /** FLOW-9: the round's set was fixed, so this made a new set for future interviews. */
  replaced: boolean;
}

/** Where an interview is, as the Dashboard and the round's lists show it. */
export type InterviewStatus = 'upcoming' | 'in-progress' | 'waiting' | 'finished';

export interface PanelMember {
  id: string;
  name: string;
  status: 'expected' | 'joined' | 'submitted' | 'did_not_take_part';
}

export interface InterviewSummary {
  id: string;
  roundId: string;
  roundName: string;
  roundState: 'open' | 'closed';
  trackId: string;
  candidate: { id: string; name: string; requisitionId: string | null };
  /** As entered: a calendar day (YYYY-MM-DD) and a time of day (HH:MM), or null. */
  date: string | null;
  time: string | null;
  state: 'planned' | 'in_progress' | 'paused' | 'completed';
  status: InterviewStatus;
  panel: PanelMember[];
  /** The signed-in person is on its panel. */
  onMyPanel: boolean;
  note: string;
  recordingNotice: boolean;
  questionSet: { id: string; name: string; fingerprint: string; questions: number; minutes: number; isRoundDefault: boolean };
  createdAt: string;
}

export interface InterviewDetail extends InterviewSummary {
  trackName: string;
  retentionUntil: string;
  set: QuestionSetDetail;
  /** The signed-in person may change or cancel it (organisers of the round, administrators). */
  canPlan: boolean;
}

export interface PlanInterviewInput {
  candidate: { name: string; requisitionId?: string | null };
  date?: string | null;
  time?: string | null;
  /** User ids, all on the round's team. */
  panel: string[];
  note?: string;
  recordingNotice?: boolean;
  /** "Use different questions for this interview": a set of its own (fixed at once). */
  questions?: QuestionSetInput;
}

export interface PlanManyInput {
  lines: Array<{ candidate: string; requisitionId?: string | null; date?: string | null; time?: string | null; panel: string[]; note?: string }>;
  recordingNotice?: boolean;
  /** People named in the lines who are not on the team yet: added as interviewers first. */
  addToTeam?: string[];
}

export interface ChangeInterviewInput {
  date?: string | null;
  time?: string | null;
  panel?: string[];
  note?: string;
  recordingNotice?: boolean;
}

// ---- Interviewing together (LIVE-1…LIVE-8, HOST-5, HOST-6) ----
//
// The shared interview (state, current question, lead, timers) lives on the interviews row; each
// panel member's own record (ticks, scores, notes, overall assessment) in records/answers/notes.
// Times inside these shapes are epoch milliseconds of the *server's* clock (the database's), and
// every response carries `serverNow` so the browser can correct for its own clock (RES-2).

/** DATA-3: elapsed = accumulatedMs + (now - runningSince) while running (server epoch ms). */
export interface TimerJson {
  accumulatedMs: number;
  runningSince: number | null;
}

export interface LivePanelMember {
  id: string;
  name: string;
  status: PanelMember['status'];
  /** Their own record (null until they join, or when they share someone else's screen). */
  recordId: string | null;
  recordState: 'draft' | 'submitted' | null;
  /** LIVE-5, PANEL-2: they score on this person's record (shared screen), else null. */
  onRecordOf: string | null;
  /** LIVE-3: last heartbeat from an open interview screen (server epoch ms), or null. */
  seenAt: number | null;
}

/** GET /api/interviews/:id/live: the shared state everyone in the interview follows (LIVE-2). */
export interface LiveState {
  id: string;
  roundId: string;
  /** Increases with every change to the shared state (optimistic concurrency, HOST-5). */
  version: number;
  state: 'planned' | 'in_progress' | 'paused' | 'completed';
  currentQuestionId: string | null;
  /** LIVE-2: who moves everyone; null before anyone on the panel has joined. */
  leadUserId: string | null;
  timer: TimerJson;
  /** Per-question soft timers, by question id (FLOW-19, RES-2). */
  questionTimers: Record<string, TimerJson>;
  startedAt: string | null;
  completedAt: string | null;
  /** LIVE-6: confirmed once for the interview, by whoever started it. */
  consent: { at: string; byName: string; recordingNotice: boolean } | null;
  panel: LivePanelMember[];
  /** LIVE-3: the round hides other people's marks until you have submitted yours. */
  hideOthers: boolean;
  me: {
    onPanel: boolean;
    status: PanelMember['status'] | null;
    /** My own record, when I have joined. */
    recordId: string | null;
    /** I score on this panel member's screen (their record carries my name). */
    onRecordOf: string | null;
    /** I may start it (a panel member, or an organiser of the round). */
    canStart: boolean;
    /** I may mark panel members as "did not take part" (organisers of the round). */
    canMark: boolean;
  };
  serverNow: number;
}

export interface AnswerJson {
  questionId: string;
  score: import('../domain/types').Score | null;
  coveredKeyPoints: number[];
  redFlagsSeen: number[];
  probeHandled: boolean;
  flagged: boolean;
  skipped: boolean;
  skipReason: string | null;
}

export interface NoteJson {
  /** Chosen by the browser (a random UUID) so a note sent twice is stored once (HOST-6). */
  id: string;
  questionId: string;
  /** FLOW-15: elapsed interview time when the note was started. */
  atSec: number;
  text: string;
  /** PANEL-3: which of the record's names made it. */
  by: string | null;
}

export interface OverallJson {
  rating: import('../domain/types').Score | null;
  recommendation: import('../domain/types').Recommendation | null;
  rationale: string;
}

/** What a record holds; the browser and the server apply RecordOps to it with the same code. */
export interface RecordData {
  answers: AnswerJson[];
  notes: NoteJson[];
  overall: OverallJson;
}

export interface RecordDetail extends RecordData {
  id: string;
  interviewId: string;
  ownerId: string;
  /** LIVE-5, PANEL-4: everyone the record speaks for, the owner first. */
  names: string[];
  /** Other panel members sharing the owner's screen (user ids). */
  sharedWith: string[];
  state: 'draft' | 'submitted';
  submittedAt: string | null;
  version: number;
}

/** LIVE-3: another panel member's record as I may see it. */
export interface OtherRecord {
  id: string;
  ownerId: string;
  names: string[];
  state: 'draft' | 'submitted';
  /** Questions they have scored or skipped (always shown: "Ben has scored it"). */
  resolved: string[];
  /** Their marks: null while the round hides them from me (the server never sends them). */
  marks: RecordData | null;
}

/** GET /api/interviews/:id/records */
export interface LiveRecords {
  mine: RecordDetail | null;
  others: OtherRecord[];
  /** LIVE-3, FLOW-27: others' marks are hidden from me until I submit mine. */
  hidden: boolean;
  serverNow: number;
}

/**
 * One change to my own record (LIVE-1, FLOW-13…FLOW-18, FLOW-22). Every op sets a value rather than
 * toggling one, so sending it twice, or from two tabs, never undoes anything (HOST-6).
 */
export type RecordOp =
  | { t: 'score'; q: string; v: import('../domain/types').Score | null }
  | { t: 'kp'; q: string; i: number; on: boolean }
  | { t: 'rf'; q: string; i: number; on: boolean }
  | { t: 'probe'; q: string; on: boolean }
  | { t: 'flag'; q: string; on: boolean }
  | { t: 'skip'; q: string; reason: string }
  | { t: 'unskip'; q: string }
  | { t: 'note.add'; id: string; q: string; atSec: number; text: string; by: string | null }
  | { t: 'note.edit'; id: string; text: string; by?: string | null }
  | { t: 'note.del'; id: string }
  | { t: 'overall'; rating?: import('../domain/types').Score | null; recommendation?: import('../domain/types').Recommendation | null; rationale?: string };

export type LiveCommand =
  /** "Move from question A to question B": refused unless the panel is on A (or already on B). */
  | { type: 'move'; from: string; to: string }
  | { type: 'pause' }
  | { type: 'resume' }
  /** LIVE-2: take the lead with one click. */
  | { type: 'lead' };

/** AUD-4: an amendment to a submitted record, with its reason. */
export interface AmendInput {
  reason: string;
  question?: { id: string; score?: import('../domain/types').Score | null; notes?: Array<{ id?: string; atSec: number; text: string; by?: string | null }> };
  overall?: Partial<OverallJson>;
}

/** GET /api/records/:id: one record with what its scorecard needs (FLOW-24). */
export interface ScorecardData {
  record: RecordDetail;
  interview: InterviewDetail;
  /** Per-question time spent (seconds), from the shared timers. */
  elapsedSec: Record<string, number>;
  startedAt: string | null;
  /** I own it (I may amend it, AUD-4). */
  mine: boolean;
}

/** GET /api/interviews/:id/present: what the candidate window may show (FLOW-11, LIVE-7). */
export interface PresentView {
  state: 'planned' | 'in_progress' | 'paused' | 'completed';
  position: number | null;
  total: number;
  text: string | null;
}
