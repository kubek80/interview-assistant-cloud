// Candidate details typed on the New interview screen before the question set is pinned (FLOW-7).
//
// They are saved in IndexedDB as they are typed (saveCandidateDraft in src/db/plans.ts), so
// closing the tab loses nothing (RES-1). The repository removes them when the plan is locked or
// deleted, by a deletion request for the candidate key, by the retention purge and by erase-all
// (PRIV-5, PRIV-6). They never go into a URL or the console (PRIV-3).
//
// Earlier versions kept the draft in this tab's sessionStorage; the "legacy" helpers below read
// such a draft once so it can be moved into IndexedDB, then remove it.
import { defaultRetentionDate } from '../../domain/plan';
import type { CandidateInput } from '../../domain/validation';

export type CandidateErrors = Partial<Record<keyof CandidateInput, string>>;

export function toCandidateInput(d: CandidateDraft): CandidateInput {
  return {
    initials: d.initials,
    requisitionId: d.requisitionId.trim() || null,
    interviewerName: d.interviewerName,
    otherInterviewers: d.otherInterviewers ?? [],
    retentionUntil: d.retentionUntil,
    recordingNotice: d.recordingNotice === true,
  };
}

export interface CandidateDraft {
  initials: string;
  requisitionId: string;
  interviewerName: string;
  /** PANEL-1: more interviewers at this machine (they share the one scorecard). */
  otherInterviewers: string[];
  retentionUntil: string;
  /** TR-4: the interview will be recorded or transcribed (default: this device's last choice). */
  recordingNotice?: boolean;
  /** FLOW-9: reuse this locked question set instead of the draft's own questions. */
  reusePlanId?: string | null;
}

export function emptyCandidateDraft(interviewerName = '', now: Date = new Date()): CandidateDraft {
  return { initials: '', requisitionId: '', interviewerName, otherInterviewers: [], retentionUntil: defaultRetentionDate(now) };
}

const KEY_PREFIX = 'ia.setup-candidate.';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Reads a stored draft; anything malformed is ignored. */
export function loadLegacyCandidateDraft(planId: string, store: StorageLike | null = storage()): Partial<CandidateDraft> | null {
  try {
    const raw = store?.getItem(KEY_PREFIX + planId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return null;
    const out: Partial<CandidateDraft> = {};
    for (const k of ['initials', 'requisitionId', 'interviewerName', 'retentionUntil'] as const) {
      if (typeof v[k] === 'string') out[k] = (v[k] as string).slice(0, 200);
    }
    if (Array.isArray(v.otherInterviewers)) out.otherInterviewers = v.otherInterviewers.filter((n): n is string => typeof n === 'string').slice(0, 12).map((n) => n.slice(0, 200));
    return out;
  } catch {
    return null;
  }
}

export function saveLegacyCandidateDraft(planId: string, draft: CandidateDraft, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(KEY_PREFIX + planId, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the form still works, it just won't survive a reload.
  }
}

export function clearLegacyCandidateDraft(planId: string, store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(KEY_PREFIX + planId);
  } catch {
    // ignore
  }
}
