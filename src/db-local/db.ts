import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Answer, AuditEvent, Category, InterviewPlan, PanelRecord, PlannedInterview, Question, Session, Track } from '../domain/types';
import type { Transcript, TranscriptFormat } from '../domain/transcript/types';
import type { AiSecondOpinion } from '../domain/ai/types';
import type { SpeakerMapping } from '../domain/ai/pseudonymise';
import { bundledDescriptions } from './seeds';

export interface Setting {
  key: string;
  value: unknown;
}

/**
 * FLOW-7, RES-1: candidate details typed on the New interview screen before the plan is pinned. Kept in
 * IndexedDB so closing the tab loses nothing; removed when the plan is locked or deleted, by a
 * deletion request for that candidate key, by the retention purge and by erase-all (PRIV-5, PRIV-6).
 */
export interface CandidateDraftRecord {
  planId: string;
  initials: string;
  requisitionId: string;
  interviewerName: string;
  /** PANEL-1: more interviewers named on the draft (absent on drafts saved before DATA-5). */
  otherInterviewers?: string[];
  retentionUntil: string;
  /** Drafts saved before consent moved to the ready screen (FLOW-7) may still carry it; ignored. */
  consentConfirmed?: boolean;
  /** TR-4 (absent on drafts saved before transcripts could be attached). */
  recordingNotice?: boolean;
  /** FLOW-9: "Use the same questions as…": the locked plan this new interview will reuse. */
  reusePlanId?: string | null;
  updatedAt: string;
}

/**
 * TR-1, TR-3: the transcript attached to an interview (at most one per session). Stored against
 * the session and removed with it (retention purge, deletion request, erase-all). Never part of a
 * session file for the panel.
 */
export interface TranscriptRecord {
  sessionId: string;
  /** Parsed structure: segments with speakers and timestamps, the plain text, speakers, hash. */
  transcript: Transcript;
  format: TranscriptFormat;
  /** AI-8: SHA-256 of transcript.text. */
  hash: string;
  attachedAt: string;
}

/** TR-2, TR-3: a recording attached for playback (at most one per session). Never leaves the device. */
export interface RecordingRecord {
  sessionId: string;
  blob: Blob;
  /** File name as chosen. */
  name: string;
  /** MIME type, e.g. "audio/mpeg". */
  type: string;
  /** Bytes. */
  size: number;
  attachedAt: string;
}

/**
 * AI-8: the AI second opinion of an interview (at most one per session; running again replaces
 * it). Read it only through the repository (getAiView / useAiSecondOpinion), which hides it until
 * the session is submitted (AI-9).
 */
export interface AiResultRecord {
  sessionId: string;
  result: AiSecondOpinion;
  /** AI-5: the speaker mapping used for the run (transcript speaker name → label). */
  speakerMapping: SpeakerMapping;
  /** How many extra names were replaced (the names themselves are not kept). */
  extraNameCount: number;
}

/**
 * Per-track bookkeeping for managing the bank on this device (BANK-6, BANK-10, BANK-14). Not part of
 * the track file: exports carry only the documented Track, Category and Question fields.
 */
export interface TrackMetaRecord {
  trackId: string;
  /** BANK-14: time of the first change made on this device since the track was loaded, imported or exported; null when none. */
  changedAt: string | null;
  /** Time of the last track-file export from this device. */
  exportedAt: string | null;
  /** BANK-10: the largest question number ever used in this track here, so numbers and ids are never reused. */
  maxNumber: number;
  /** Category order from the seed or track file (new categories are appended), for display and clean exports. */
  categoryOrder: string[];
}

/** Known settings keys. */
export const SETTINGS = {
  /** AUD-1 actor: the interviewer name set on this device. */
  interviewerName: 'interviewerName',
  /** Last retention purge run (ISO timestamp). */
  lastPurgeAt: 'lastPurgeAt',
} as const;

export class InterviewDb extends Dexie {
  tracks!: EntityTable<Track, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  questions!: EntityTable<Question, 'id'>;
  plans!: EntityTable<InterviewPlan, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  answers!: Table<Answer, [string, string]>;
  audit!: EntityTable<AuditEvent, 'id'>;
  settings!: EntityTable<Setting, 'key'>;
  candidateDrafts!: EntityTable<CandidateDraftRecord, 'planId'>;
  trackMeta!: EntityTable<TrackMetaRecord, 'trackId'>;
  transcripts!: EntityTable<TranscriptRecord, 'sessionId'>;
  recordings!: EntityTable<RecordingRecord, 'sessionId'>;
  aiResults!: EntityTable<AiResultRecord, 'sessionId'>;
  /** TEAM-1…TEAM-6: interviews planned ahead, keyed by invitation id. */
  plannedInterviews!: EntityTable<PlannedInterview, 'id'>;
  /** TEAM-9…TEAM-14, SUM-4: panel decisions and written summaries, one per panel (candidate key + fingerprint). */
  panelRecords!: EntityTable<PanelRecord, 'id'>;

  constructor(name = 'interview-assistant') {
    super(name);
    this.version(1).stores({
      tracks: 'id',
      categories: 'id, trackId',
      questions: 'id, trackId, categoryId',
      plans: 'id, trackId, fingerprint, createdAt',
      sessions: 'id, planId, state, createdAt, candidate.retentionUntil',
      answers: '[sessionId+questionId], sessionId',
      audit: '++id, ts, action, entity, entityId',
      settings: 'key',
    });
    // Additive: draft candidate details move from sessionStorage to IndexedDB (RES-1).
    this.version(2).stores({ candidateDrafts: 'planId' });
    // BANK-8: questions gain a description (from the bundled seed when the id matches, else empty).
    // Locked plans are not touched: their snapshots keep what they had (FLOW-8) and a missing
    // description is read as empty. BANK-6/10/14: per-track bookkeeping for in-app editing.
    this.version(3)
      .stores({ trackMeta: 'trackId' })
      .upgrade(async (tx) => {
        const fromSeed = bundledDescriptions();
        await tx
          .table<Question>('questions')
          .toCollection()
          .modify((q) => {
            if (typeof q.description !== 'string') q.description = fromSeed.get(q.id) ?? '';
          });
      });
    // TR-1, TR-2, AI-8: transcripts, recordings and AI results, one per session. Additive: no
    // existing record changes, so there is nothing to upgrade (sessions without the TR-4
    // recordingConsent field read as "not told").
    this.version(4).stores({ transcripts: 'sessionId', recordings: 'sessionId', aiResults: 'sessionId' });
    // TEAM-1…TEAM-6: planned interviews and invitations. Additive: sessions without an
    // invitationId are matched by candidate key and fingerprint as before.
    this.version(5).stores({ plannedInterviews: 'id, planId, sessionId, fingerprint, retentionUntil' });
    // TEAM-7…TEAM-13, SUM-4: panel decisions, written summaries and shared panel files. Additive:
    // judgements entered by hand are ordinary sessions with origin 'entered'.
    this.version(6).stores({ panelRecords: 'id, &panelKey, fingerprint, retentionUntil' });
  }
}

export const db = new InterviewDb();

/** All tables, for transactions that may touch anything (and for erase-all). */
export const allTables = () => [
  db.tracks,
  db.categories,
  db.questions,
  db.plans,
  db.sessions,
  db.answers,
  db.audit,
  db.settings,
  db.candidateDrafts,
  db.trackMeta,
  db.transcripts,
  db.recordings,
  db.aiResults,
  db.plannedInterviews,
  db.panelRecords,
];

/** TR-3: the tables that hold attachments and AI results of a session (removed with it). */
export const attachmentTables = () => [db.transcripts, db.recordings, db.aiResults];
