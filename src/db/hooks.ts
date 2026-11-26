// Live React hooks over the database. Each returns `undefined` while loading and `null` (or an
// empty array) when nothing is found. They re-render on every change, including changes made in
// another window of the same app (e.g. the candidate window following the current question).
import { useLiveQuery } from 'dexie-react-hooks';
import { db, SETTINGS } from './db';
import { queryAudit, type AuditFilter } from './audit';
import { pendingSeedUpdates, trackMetaOf } from './bank';
import { isBlinded, loadComparison, loadPanel, loadPlanChoices } from './panels';
import { loadCandidatePanel, loadRound, panelRecordFor } from './decisions';
import { computeScorecard } from '../domain/scoring';
import type { Category, Question, Track } from '../domain/types';

export function useTracks() {
  return useLiveQuery(() => db.tracks.toArray().then((ts) => ts.sort((a, b) => a.id.localeCompare(b.id))), []);
}

export interface TrackBank {
  track: Track;
  /** In the seed's order (categories added on this device last). */
  categories: Category[];
  /** Ordered by question number; includes retired questions (filter with filterQuestions). */
  questions: Question[];
  /** BANK-14: when the unexported changes on this device started; null when there are none. */
  changedAt: string | null;
}

export function useTrackBank(trackId: string | undefined) {
  return useLiveQuery(async (): Promise<TrackBank | null> => {
    if (!trackId) return null;
    const track = await db.tracks.get(trackId);
    if (!track) return null;
    const [categories, questions, meta] = await Promise.all([
      db.categories.where('trackId').equals(trackId).toArray(),
      db.questions.where('trackId').equals(trackId).sortBy('number'),
      trackMetaOf(trackId),
    ]);
    const rank = (id: string) => (meta.categoryOrder.includes(id) ? meta.categoryOrder.indexOf(id) : Number.MAX_SAFE_INTEGER);
    categories.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return { track, categories, questions, changedAt: meta.changedAt };
  }, [trackId]);
}

/** BANK-6, BANK-14: per-track unexported-changes marker and any newer bundled seed held back. */
export function useBankStatus() {
  return useLiveQuery(async () => {
    const [metas, pending] = await Promise.all([db.trackMeta.toArray(), pendingSeedUpdates()]);
    return {
      changedAt: Object.fromEntries(metas.map((m) => [m.trackId, m.changedAt])) as Record<string, string | null>,
      pending,
    };
  }, []);
}

export function usePlan(planId: string | undefined) {
  return useLiveQuery(async () => (planId ? ((await db.plans.get(planId)) ?? null) : null), [planId]);
}

export function usePlans() {
  return useLiveQuery(() => db.plans.orderBy('createdAt').reverse().toArray(), []);
}

export function useSession(sessionId: string | undefined) {
  return useLiveQuery(async () => (sessionId ? ((await db.sessions.get(sessionId)) ?? null) : null), [sessionId]);
}

/** All sessions on this device, newest first (FLOW-1). */
export function useSessions() {
  return useLiveQuery(() => db.sessions.orderBy('createdAt').reverse().toArray(), []);
}

/** Answers for a session in plan order is up to the caller; this returns them keyed by question id too. */
export function useAnswers(sessionId: string | undefined) {
  return useLiveQuery(async () => {
    if (!sessionId) return [];
    return db.answers.where('sessionId').equals(sessionId).toArray();
  }, [sessionId]);
}

export function useAnswer(sessionId: string | undefined, questionId: string | null | undefined) {
  return useLiveQuery(
    async () => (sessionId && questionId ? ((await db.answers.get([sessionId, questionId])) ?? null) : null),
    [sessionId, questionId],
  );
}

/**
 * Session + plan + answers + computed scorecard, for the Scorecard and Live screens. For an
 * imported panelist session that is still blinded (FLOW-27) the answers are not loaded at all:
 * `answers` is empty, the scorecard is computed from nothing and `blinded` is true.
 */
export function useSessionBundle(sessionId: string | undefined) {
  return useLiveQuery(async () => {
    if (!sessionId) return null;
    const session = await db.sessions.get(sessionId);
    if (!session) return null;
    const plan = await db.plans.get(session.planId);
    if (!plan) return null;
    const blinded = await isBlinded(session);
    const answers = blinded ? [] : await db.answers.where('sessionId').equals(sessionId).toArray();
    return { session, plan, answers, scorecard: computeScorecard(plan, answers), blinded };
  }, [sessionId]);
}

/** FLOW-27/28/29: the debrief panel for a session (blinding applied). */
export function usePanel(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? loadPanel(sessionId) : Promise.resolve(null)), [sessionId]);
}

/** FLOW-30 */
export function usePlanChoices() {
  return useLiveQuery(() => loadPlanChoices(), []);
}

/** FLOW-30 */
export function useComparison(fingerprint: string | undefined) {
  return useLiveQuery(() => (fingerprint ? loadComparison(fingerprint) : Promise.resolve(null)), [fingerprint]);
}

/** AUD-3. Pass a memoised or primitive-stable filter. */
export function useAuditEvents(filter: AuditFilter = {}) {
  return useLiveQuery(() => queryAudit(filter), [JSON.stringify(filter)]);
}

export function useSetting<T>(key: string) {
  return useLiveQuery(async () => ((await db.settings.get(key))?.value as T | undefined) ?? null, [key]);
}

export function useInterviewerName() {
  return useSetting<string>(SETTINGS.interviewerName);
}

/** TEAM-1, TEAM-2: interviews planned ahead on this device (Upcoming). */
export function usePlannedInterviews() {
  return useLiveQuery(() => db.plannedInterviews.toArray(), []);
}

/** FLOW-33, RES-1: candidate details typed on unfinished set-ups (to label them on the Dashboard). */
export function useCandidateDrafts() {
  return useLiveQuery(() => db.candidateDrafts.toArray(), []);
}

/** SUM-1, SUM-6: every panel on this device for the Summary screen. */
export function useRound() {
  return useLiveQuery(() => loadRound(), []);
}

/** SUM-3: one panel for the candidate page. */
export function useCandidatePanel(ref: string | undefined) {
  return useLiveQuery(() => (ref ? loadCandidatePanel(ref) : Promise.resolve(null)), [ref]);
}

/** TEAM-12: the panel decision and summary of the panel a record belongs to. */
export function usePanelRecordFor(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? panelRecordFor(sessionId) : Promise.resolve(null)), [sessionId]);
}
