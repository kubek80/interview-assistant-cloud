// Entities per docs/08-data-model.md (DATA-1..4) and the seed shape in docs/05-question-bank.md.

export type Difficulty = 'core' | 'advanced' | 'expert';
export type QuestionType = 'knowledge' | 'scenario' | 'design' | 'behavioural';
export type QuestionStatus = 'active' | 'retired';
export type Score = 1 | 2 | 3 | 4;
export type ScoreKey = '1' | '2' | '3' | '4';

export const DIFFICULTIES: readonly Difficulty[] = ['core', 'advanced', 'expert'];
export const QUESTION_TYPES: readonly QuestionType[] = ['knowledge', 'scenario', 'design', 'behavioural'];
export const SCORES: readonly Score[] = [1, 2, 3, 4];

/** RUB-2: per-level replacement descriptions, or null. */
export type RubricOverride = Partial<Record<ScoreKey, string>> | null;

export interface Track {
  id: string;
  name: string;
  /** Seed version such as "2026.11" or "2026.11.2"; compared segment by segment (BANK-6). */
  version: string;
}

export interface Category {
  id: string;
  trackId: string;
  name: string;
  weight: number;
  mustHave: boolean;
}

export interface Question {
  id: string;
  trackId: string;
  categoryId: string;
  number: number;
  text: string;
  /**
   * BANK-8: plain-language explanation for the interviewer, read out or paraphrased to steer a
   * candidate who has not understood the question (FLOW-12). Never shown to the candidate (FLOW-11).
   * Plan snapshots locked before descriptions existed, and plan or session files from that time,
   * have no description: read it with `descriptionOf` and treat a missing one as empty.
   */
  description: string;
  difficulty: Difficulty;
  type: QuestionType;
  lookFor: string[];
  redFlags: string[];
  probes: string[];
  timeMin: number;
  version: number;
  status: QuestionStatus;
  rubricOverride: RubricOverride;
}

/** One file in seed/ (BANK-3), also the Admin track import/export format (BANK-7). */
export interface TrackFile {
  track: Track;
  categories: Array<Omit<Category, 'trackId'> & { trackId?: string }>;
  questions: Array<Omit<Question, 'trackId'> & { trackId?: string }>;
}

/** A question frozen into a plan when it is locked (FLOW-8). */
export type QuestionSnapshot = Question;

/** BANK-8, FLOW-12: a question's description, or '' for snapshots and files made before descriptions existed. */
export function descriptionOf(q: { description?: unknown } | null | undefined): string {
  return typeof q?.description === 'string' ? q.description.trim() : '';
}
/** The plan's own copy of a category, with plan-specific weight and must-have flag (FLOW-6). */
export type PlanCategory = Category;

export interface InterviewPlan {
  id: string;
  trackId: string;
  trackVersion: string;
  name: string;
  /** Ordered question snapshots. */
  questions: QuestionSnapshot[];
  categories: PlanCategory[];
  timeBudgetMin: number;
  locked: boolean;
  lockedAt: string | null;
  /** FLOW-9; null until locked. */
  fingerprint: string | null;
  createdAt: string;
}

export type SessionState = 'planned' | 'in_progress' | 'paused' | 'submitted';
/**
 * DATA-2: 'local' for records made on this device, 'imported' for other interviewers' files, and
 * 'entered' for a judgement typed on this device on another interviewer's behalf (TEAM-7, TEAM-8).
 */
export type SessionOrigin = 'local' | 'imported' | 'entered';
export type Recommendation = 'strong_hire' | 'hire' | 'lean_no_hire' | 'no_hire';
export const RECOMMENDATIONS: readonly Recommendation[] = ['strong_hire', 'hire', 'lean_no_hire', 'no_hire'];
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  strong_hire: 'Strong hire',
  hire: 'Hire',
  lean_no_hire: 'Lean no hire',
  no_hire: 'No hire',
};

/** DATA-3: elapsed = accumulatedMs + (now - runningSince) while running. Times are epoch ms. */
export interface TimerState {
  accumulatedMs: number;
  runningSince: number | null;
}

export interface CandidateDetails {
  /** PRIV-1: the candidate's name or initials (up to 60 characters). The field keeps its old name so older data and files load. */
  initials: string;
  requisitionId: string | null;
  /**
   * ISO timestamp of the consent confirmation (PRIV-4), given on the ready screen with the candidate
   * present (FLOW-7). `null` until then: an interview cannot be started without it.
   */
  consentAt: string | null;
  /** ISO date (YYYY-MM-DD); the session is purged after this day (PRIV-5). */
  retentionUntil: string;
  /**
   * TR-4: the candidate was told the interview is recorded or transcribed (RECORDING_CONSENT_TEXT).
   * `source` is 'setup' when the option was on when the interview was set up (the consent
   * confirmation covers it; `at` equals `consentAt`), 'later' when an interviewer confirmed it
   * afterwards, before attaching a transcript or recording. Absent: the candidate was not told,
   * and nothing can be attached until an interviewer confirms they have since been told.
   */
  recordingConsent?: RecordingConsent;
  /**
   * TR-4: "This interview will be recorded or transcribed" was chosen when the interview was set
   * up. The ready screen then adds RECORDING_CONSENT_TEXT to the consent text, and the consent
   * confirmation covers it (stored as recordingConsent with source 'setup').
   */
  recordingNotice?: boolean;
}

/** TR-4 */
export interface RecordingConsent {
  /** ISO timestamp of the confirmation. */
  at: string;
  source: 'setup' | 'later';
}

export interface OverallAssessment {
  rating: Score | null;
  recommendation: Recommendation | null;
  rationale: string;
}

export interface Session {
  id: string;
  planId: string;
  candidate: CandidateDetails;
  /** The first interviewer (this device's). Kept equal to `interviewers[0]` (DATA-5). */
  interviewer: { name: string };
  /**
   * DATA-5, PANEL-1: everyone running this interview at this machine, the device's interviewer
   * first. They share this one record (PANEL-2). Absent on sessions and files made before DATA-5:
   * read it with `interviewersOf` (domain/interviewers), which falls back to `[interviewer.name]`.
   */
  interviewers?: string[];
  state: SessionState;
  currentQuestionId: string | null;
  timer: TimerState;
  overall: OverallAssessment;
  createdAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  origin: SessionOrigin;
  /**
   * TEAM-3, TEAM-5: the invitation this record belongs to (a planned interview shared between
   * devices). Present on records made from "Save for later" or from an imported invitation, and in
   * the interview files exported from them, so the organiser's device can match them. Optional:
   * records and files without it are matched by candidate key and plan fingerprint (FLOW-29).
   */
  invitationId?: string;
  /**
   * TEAM-7, TEAM-8: for origin 'entered' (a judgement typed on someone's behalf): who typed it
   * (this device's interviewer when it was entered) and when. The record's own interviewer is the
   * person on whose behalf it was entered.
   */
  enteredBy?: string;
  enteredAt?: string;
}

export interface NoteEntry {
  /** Elapsed interview time when the note was added (FLOW-15). */
  atSec: number;
  text: string;
  /** PANEL-3: which of the session's interviewers made the note (optional). */
  by?: string;
}

export interface Answer {
  sessionId: string;
  questionId: string;
  score: Score | null;
  /** Indexes into the question's lookFor list. */
  coveredKeyPoints: number[];
  /** Indexes into the question's redFlags list. */
  redFlagsSeen: number[];
  probeHandled: boolean;
  notes: NoteEntry[];
  flagged: boolean;
  skipped: boolean;
  skipReason: string | null;
  /** Time spent on this question in whole seconds, refreshed whenever its timer stops. */
  elapsedSec: number;
  /** Per-question soft timer (DATA-3, RES-2). */
  timer: TimerState;
}

export type AuditAction =
  | 'plan.locked'
  | 'session.started'
  | 'session.submitted'
  | 'session.amended'
  | 'export'
  | 'import'
  | 'bank.loaded'
  | 'retention.purged'
  | 'privacy.access_request'
  | 'privacy.deletion_request'
  | 'data.erased'
  // PANEL-1: interviewers added to or removed from a record in the live interview.
  | 'session.interviewer_added'
  | 'session.interviewer_removed'
  // BANK-14: changes made to the bank in the app (no candidate data).
  | 'bank.question_added'
  | 'bank.question_edited'
  | 'bank.question_retired'
  | 'bank.question_restored'
  | 'bank.category_added'
  | 'bank.category_edited'
  | 'bank.category_removed'
  | 'bank.track_created'
  // TR-3, TR-4: attachments (never their content) and the late recording/transcription notice.
  | 'session.recording_notice_confirmed'
  // FLOW-7, PRIV-4: consent confirmed on the ready screen; a not-yet-started interview discarded.
  | 'session.consent_confirmed'
  | 'session.discarded'
  | 'transcript.attached'
  | 'transcript.replaced'
  | 'transcript.removed'
  | 'recording.attached'
  | 'recording.replaced'
  | 'recording.removed'
  // AI-2, AI-3: the AI second opinion turned on or off on this device, and each run (never the content).
  | 'ai.enabled'
  | 'ai.disabled'
  | 'ai.run'
  | 'ai.run_failed'
  // TEAM-1…TEAM-6: interviews planned for later (never candidate text in before/after).
  | 'invitation.saved'
  | 'invitation.changed'
  | 'invitation.cancelled'
  // FLOW-27: independent scoring turned on or off on this device.
  | 'device.independent_scoring'
  // TEAM-7, TEAM-8: a judgement entered by hand on another interviewer's behalf (corrections are 'session.amended').
  | 'judgement.entered'
  // TEAM-9, TEAM-11: the panel decision recorded, and changed later (reason, before and after).
  | 'decision.recorded'
  | 'decision.changed'
  // SUM-4: the written summary saved (never its text).
  | 'summary.saved'
  // Hosted version (USER-4, AUTH-4, HPRIV-4): people and access, sign-ins, audit exports, settings.
  | 'user.added'
  | 'user.changed'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.removed'
  | 'auth.signed_in'
  | 'auth.signed_out'
  | 'audit.exported'
  | 'settings.changed'
  // REVIEW-2 to REVIEW-7: proposals and review requests (the question text is in the proposal, not the log).
  | 'proposal.created'
  | 'proposal.accepted'
  | 'proposal.declined'
  | 'proposal.withdrawn'
  | 'review.requested'
  | 'review.closed';

export type AuditEntity = 'plan' | 'session' | 'answer' | 'track' | 'category' | 'question' | 'audit' | 'device' | 'invitation' | 'panel' | 'user' | 'settings' | 'proposal' | 'review';

export interface AuditEvent {
  /** Auto-incremented; assigned by the database. */
  id?: number;
  ts: string;
  actor: string;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export const FORMAT_VERSION = 1;

/** DATA-4 */
export interface PlanFile {
  kind: 'interview-plan';
  formatVersion: number;
  exportedAt: string;
  plan: InterviewPlan;
}

/** DATA-4: a session file embeds its plan. */
export interface SessionFile {
  kind: 'interview-session';
  formatVersion: number;
  exportedAt: string;
  plan: InterviewPlan;
  session: Session;
  answers: Answer[];
}

/**
 * TEAM-1…TEAM-6: an interview planned ahead ("Save for later" here, or imported from an invitation
 * file). One record per invitation id on each device. It is the panel-level view of one planned
 * interview: when, who is expected (the whole panel, each person submitting their own record),
 * the note, and which local record (if any) this device's interviewer(s) score.
 *
 * - `expected` is the wider panel. The people sharing this device's scorecard are the local
 *   record's `interviewers` (PANEL-1); they are normally on `expected` too.
 * - `sessionId` is the local record scored on this device (state `planned` until started).
 * - The panel it belongs to is its candidate key plus `fingerprint` (FLOW-29), like every record.
 */
export interface PlannedInterview {
  /** Invitation id: random, stable across devices and re-imports (TEAM-3, TEAM-4). */
  id: string;
  /** The locked plan on this device (its questions are fixed, FLOW-8). */
  planId: string;
  fingerprint: string;
  /** PRIV-1, TEAM-14: initials and requisition id only. */
  candidate: { initials: string; requisitionId: string | null };
  /** PRIV-5, TEAM-14: the planned interview is kept until this day (YYYY-MM-DD). */
  retentionUntil: string;
  /** Local calendar day (YYYY-MM-DD), or null when not scheduled yet. */
  date: string | null;
  /** Local time of day (HH:MM), or null. */
  time: string | null;
  /** Everyone expected to submit a record for this interview (names, compared case-insensitively). */
  expected: string[];
  /** TR-4: whether it will be recorded or transcribed (the ready screen adds the sentence). */
  recordingNotice: boolean;
  /** A short note for the interviewers. */
  note: string;
  /** Who planned it (the organiser's device name). */
  organiser: string;
  /** When the organiser created and last changed it (carried in invitation files). */
  createdAt: string;
  updatedAt: string;
  /** 'here': planned on this device; 'invitation': added from an invitation file. */
  source: 'here' | 'invitation';
  /** Last import of an invitation file for it, when source is 'invitation'. */
  importedAt?: string;
  /** TEAM-3: when an invitation file holding it was last exported from this device. */
  exportedAt?: string;
  /** The local record this device scores (removed with the planned interview). */
  sessionId: string;
}

/** TEAM-3: one planned interview in an invitation file (no scores, no device state). */
export interface InvitationEntry {
  invitationId: string;
  createdAt: string;
  updatedAt: string;
  organiser: string;
  candidate: { initials: string; requisitionId: string | null };
  date: string | null;
  time: string | null;
  expectedInterviewers: string[];
  recordingNotice: boolean;
  note: string;
  retentionUntil: string;
  /** The locked plan with its question snapshots and fingerprint (FLOW-8, FLOW-9). */
  plan: InterviewPlan;
}

/** TEAM-3, DATA-4: an invitation file carries one or more planned interviews. */
export interface InvitationFile {
  kind: 'interview-invitation';
  formatVersion: number;
  exportedAt: string;
  interviews: InvitationEntry[];
}

/** PRIV-6 access request export. */
export interface CandidateDataFile {
  kind: 'candidate-data';
  formatVersion: number;
  exportedAt: string;
  candidateKey: string;
  sessions: Array<{
    plan: InterviewPlan | null;
    session: Session;
    answers: Answer[];
    /** TR-3: the attached transcript (its text with speaker names and timestamps), or null. */
    transcript?: { format: string; attachedAt: string; hash: string; speakers: string[]; text: string } | null;
    /** TR-3: whether a recording is held; the recording itself is downloaded separately from Admin. */
    recording?: { held: boolean; name?: string; type?: string; size?: number; attachedAt?: string };
    /** AI-8: the stored AI second opinion, or null. */
    aiSecondOpinion?: unknown;
  }>;
  audit: AuditEvent[];
  /** TEAM-14: interviews planned for this candidate (Upcoming, invitations). */
  plannedInterviews?: PlannedInterview[];
  /** TEAM-9…TEAM-14, SUM-4: panel decisions, written summaries and what came with panel files. */
  panels?: PanelRecord[];
  /** Candidate details typed on draft plans that were never locked (RES-1). */
  drafts?: Array<{ planId: string; initials: string; requisitionId: string; interviewerName: string; retentionUntil: string; updatedAt: string }>;
}

// ---------------------------------------------------------------------------------------------
// TEAM-9…TEAM-13, SUM-3, SUM-4: one record per panel (candidate key + plan fingerprint, FLOW-29).

/** TEAM-9: the panel's agreed view. It never changes anyone's individual scores (TEAM-11). */
export interface PanelDecision {
  recommendation: Recommendation;
  rationale: string;
  /** Who took part in the decision. */
  participants: string[];
  /** Optional agreed overall rating. */
  rating: Score | null;
  /** Optional agreed scores for individual questions (question id → score); empty by default. */
  scores: Record<string, Score>;
  recordedBy: string;
  recordedAt: string;
  /** TEAM-11: the last change (made with a reason, audited). */
  changedBy?: string;
  changedAt?: string;
}

/** SUM-4: the written summary of a candidate's panel. */
export interface WrittenSummary {
  text: string;
  updatedBy: string;
  updatedAt: string;
}

/** TEAM-13: a transcript or AI second opinion that came with a panel file (shown read-only). */
export interface SharedAttachment {
  /** The record it belongs to. */
  sessionId: string;
  /** Whose interview it is (for the label). */
  interviewers: string[];
  transcript?: { format: string; text: string; speakers: string[] };
  /** AI-8, AI-11: the AI second opinion as exported (model, when, and per question the score and rationale). */
  aiSecondOpinion?: SharedAiOpinion;
}

/** TEAM-13: what a panel file carries of an AI second opinion. */
export interface SharedAiOpinion {
  model: string;
  createdAt: string;
  questions: Array<{ questionId: string; covered: boolean; score: Score | null; rationale?: string }>;
}

/**
 * TEAM-9…TEAM-14: what this device holds about one panel beyond the judgements themselves: the
 * panel decision, the written summary, and (from an imported panel file) who was expected and when.
 */
export interface PanelRecord {
  /** Random id (used in routes, never candidate data: PRIV-3). */
  id: string;
  /** candidateKey#fingerprint (unique). */
  panelKey: string;
  candidate: { initials: string; requisitionId: string | null };
  fingerprint: string;
  planId: string;
  /** PRIV-5, TEAM-14: removed after this day (the latest retention date of the panel's records). */
  retentionUntil: string;
  /** From an imported panel file when no planned interview here says it. */
  expected?: string[];
  date?: string | null;
  time?: string | null;
  decision: PanelDecision | null;
  summary: WrittenSummary | null;
  /** TEAM-13: transcripts and AI second opinions that came with a panel file (only when chosen at export). */
  shared?: SharedAttachment[];
  createdAt: string;
  updatedAt: string;
}

/** TEAM-13: one panel in a panel file. */
export interface PanelFileEntry {
  plan: InterviewPlan;
  candidate: { initials: string; requisitionId: string | null };
  retentionUntil: string;
  expected: string[];
  date: string | null;
  time: string | null;
  /** Every judgement held for the panel (own, imported and entered by hand), submitted only. */
  judgements: Array<{ session: Session; answers: Answer[] }>;
  decision: PanelDecision | null;
  summary: WrittenSummary | null;
  /** Only when chosen at export (never recordings). */
  shared?: SharedAttachment[];
}

/** TEAM-13, DATA-4: a panel file carries one or more panels. */
export interface PanelFile {
  kind: 'interview-panel';
  formatVersion: number;
  exportedAt: string;
  exportedBy: string;
  panels: PanelFileEntry[];
}
