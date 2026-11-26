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

export type Role = 'admin' | 'organiser' | 'interviewer';
export const ROLES: readonly Role[] = ['admin', 'organiser', 'interviewer'];
export const ROLE_LABELS: Record<Role, string> = { admin: 'Administrator', organiser: 'Organiser', interviewer: 'Interviewer' };

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
