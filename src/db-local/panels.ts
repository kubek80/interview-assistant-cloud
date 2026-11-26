import { db } from './db';
import { getIndependentScoring } from './settings';
import { candidateKey } from '../domain/plan';
import { computePanel, computeScorecard, type PanelResult, type Scorecard } from '../domain/scoring';
import type { Answer, InterviewPlan, PanelDecision, PanelRecord, PlannedInterview, Session } from '../domain/types';
import { attendance, hideImported, panelKey, uniqueNames, type Attendance } from '../domain/team';
import { computeAiScorecard, isOutOfDate } from '../domain/ai/result';
import type { AiSecondOpinion } from '../domain/ai/types';

/**
 * AI-10, AI-11: an AI second opinion shown in the debrief as its own column. It is never a
 * panel member: the panel median and spread are computed without it.
 */
export interface PanelAiEntry {
  /** The (local, submitted) session it belongs to. */
  session: Session;
  result: AiSecondOpinion;
  scorecard: Scorecard;
  outOfDate: boolean;
}

export interface PanelEntry {
  session: Session;
  /** FLOW-27: true for an imported record while independent scoring is on and this device's own record for the panel is not submitted. */
  hidden: boolean;
  /** Null when hidden or not submitted, so hidden scores cannot leak into the UI. */
  answers: Answer[] | null;
  scorecard: Scorecard | null;
}

export interface PanelView {
  plan: InterviewPlan;
  candidateKey: string;
  /** This device's own (local) session(s) for this candidate and plan. */
  ownSessions: Session[];
  ownSubmitted: boolean;
  /** FLOW-27: independent scoring is on for this device. */
  independentScoring: boolean;
  entries: PanelEntry[];
  /** TEAM-1, TEAM-6: the planned interviews (invitations) of this panel on this device. */
  planned: PlannedInterview[];
  /** TEAM-6: expected, submitted and still to come. */
  attendance: Attendance;
  /** Computed over visible, submitted entries only (FLOW-28, SCORE-11). Never includes `ai`. */
  panel: PanelResult<Session>;
  /** AI-9, AI-11: AI second opinions of this device's submitted sessions in the panel (never imported ones). */
  ai: PanelAiEntry[];
  /** TEAM-9…TEAM-12, SUM-4: the panel decision and written summary, if any. */
  record: PanelRecord | null;
}

/**
 * FLOW-27, FLOW-29: group sessions with the same candidate key and plan fingerprint as `target`.
 * Imported records are shown, unless independent scoring is on for this device: then they are
 * hidden until one of this device's own records in the group is submitted (hideImported).
 */
export function buildPanel(
  target: Session,
  sessions: readonly Session[],
  plansById: ReadonlyMap<string, InterviewPlan>,
  answersBySession: ReadonlyMap<string, Answer[]>,
  plannedInterviews: readonly PlannedInterview[] = [],
  independentScoring = false,
): PanelView | null {
  const plan = plansById.get(target.planId);
  if (!plan?.fingerprint) return null;
  const key = candidateKey(target.candidate);
  const group = sessions.filter((s) => candidateKey(s.candidate) === key && plansById.get(s.planId)?.fingerprint === plan.fingerprint);
  const ownSessions = group.filter((s) => s.origin === 'local');
  const ownSubmitted = ownSessions.some((s) => s.state === 'submitted');
  const hide = hideImported(independentScoring, ownSessions);
  const planned = plannedInterviews.filter((p) => panelKey(p.candidate, p.fingerprint) === panelKey(target.candidate, plan.fingerprint));
  const entries: PanelEntry[] = group.map((session) => {
    const hidden = session.origin === 'imported' && hide;
    const visible = !hidden && session.state === 'submitted';
    const sPlan = plansById.get(session.planId)!;
    const answers = visible ? (answersBySession.get(session.id) ?? []) : null;
    return { session, hidden, answers, scorecard: answers ? computeScorecard(sPlan, answers) : null };
  });
  // TEAM-7: a judgement with no question scores has no percentage and is not counted in the panel score.
  const panel = computePanel(entries.filter((e) => e.scorecard && e.scorecard.answeredCount > 0).map((e) => ({ ref: e.session, scorecard: e.scorecard! })));
  const expected = uniqueNames(planned.flatMap((p) => p.expected));
  return {
    plan,
    candidateKey: key,
    ownSessions,
    ownSubmitted,
    independentScoring,
    entries,
    planned,
    attendance: attendance(expected, group),
    panel,
    ai: [],
    record: null,
  };
}

/**
 * AI-9, AI-10, AI-11: the debrief's AI column. Only for this device's own submitted sessions in
 * the panel; it is computed separately and never added to `view.panel`.
 */
export function panelAiEntries(
  view: Pick<PanelView, 'entries'>,
  plansById: ReadonlyMap<string, InterviewPlan>,
  aiBySession: ReadonlyMap<string, { result: AiSecondOpinion; transcriptHash: string | null }>,
): PanelAiEntry[] {
  return view.entries.flatMap((e) => {
    const ai = aiBySession.get(e.session.id);
    const plan = plansById.get(e.session.planId);
    if (!ai || !plan || e.session.origin !== 'local' || e.session.state !== 'submitted') return [];
    return [{ session: e.session, result: ai.result, scorecard: computeAiScorecard(plan, ai.result), outOfDate: isOutOfDate(ai.result, ai.transcriptHash) }];
  });
}

/** The records of one panel (candidate key + plan fingerprint) on this device, split by origin. */
export async function panelRecords(candidate: { initials: string; requisitionId: string | null | undefined }, fingerprint: string): Promise<{ local: Session[]; imported: Session[]; entered: Session[] }> {
  const planIds = (await db.plans.where('fingerprint').equals(fingerprint).primaryKeys()) as string[];
  const key = candidateKey(candidate);
  const group = planIds.length ? await db.sessions.where('planId').anyOf(planIds).filter((s) => candidateKey(s.candidate) === key).toArray() : [];
  return { local: group.filter((s) => s.origin === 'local'), imported: group.filter((s) => s.origin === 'imported'), entered: group.filter((s) => s.origin === 'entered') };
}

/**
 * FLOW-27 in the data layer: true when `session` is an imported record that must stay hidden on
 * this device: independent scoring is on and no local record of the same candidate key on a plan
 * with the same fingerprint is submitted. Same rule as buildPanel; used by every path that could
 * show or export scores (useSessionBundle, exportScorecard, exportSessionFile, the comparison).
 * Call inside a transaction (or none) that can read db.settings, db.plans and db.sessions.
 */
export async function isBlinded(session: Session): Promise<boolean> {
  if (session.origin !== 'imported') return false;
  if (!(await getIndependentScoring())) return false;
  const plan = await db.plans.get(session.planId);
  if (!plan?.fingerprint) return true;
  return hideImported(true, (await panelRecords(session.candidate, plan.fingerprint)).local);
}

/** Loads everything needed for the Debrief screen of `sessionId`. */
export async function loadPanel(sessionId: string): Promise<PanelView | null> {
  const target = await db.sessions.get(sessionId);
  if (!target) return null;
  const [sessions, plans, planned, independent] = await Promise.all([db.sessions.toArray(), db.plans.toArray(), db.plannedInterviews.toArray(), getIndependentScoring()]);
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const key = candidateKey(target.candidate);
  const ids = sessions.filter((s) => candidateKey(s.candidate) === key).map((s) => s.id);
  const answers = await db.answers.where('sessionId').anyOf(ids).toArray();
  const view = buildPanel(target, sessions, plansById, groupAnswers(answers), planned, independent);
  if (!view) return null;
  const own = view.entries.filter((e) => e.session.origin === 'local' && e.session.state === 'submitted').map((e) => e.session.id);
  const [results, transcripts] = await Promise.all([db.aiResults.where('sessionId').anyOf(own).toArray(), db.transcripts.where('sessionId').anyOf(own).toArray()]);
  const hashes = new Map(transcripts.map((t) => [t.sessionId, t.hash]));
  const aiBySession = new Map(results.map((r) => [r.sessionId, { result: r.result, transcriptHash: hashes.get(r.sessionId) ?? null }]));
  const record = (await db.panelRecords.where('panelKey').equals(panelKey(target.candidate, view.plan.fingerprint)).first()) ?? null;
  return { ...view, ai: panelAiEntries(view, plansById, aiBySession), record };
}

export interface PlanChoice {
  fingerprint: string;
  /** A representative plan (several plan records can share a fingerprint). */
  plan: InterviewPlan;
  planIds: string[];
  submittedCount: number;
}

/** FLOW-30: locked plans grouped by fingerprint, for "choose a plan first". */
export async function loadPlanChoices(): Promise<PlanChoice[]> {
  const [plans, sessions] = await Promise.all([db.plans.toArray(), db.sessions.toArray()]);
  const byFp = new Map<string, PlanChoice>();
  for (const plan of plans) {
    if (!plan.locked || !plan.fingerprint) continue;
    const c = byFp.get(plan.fingerprint) ?? { fingerprint: plan.fingerprint, plan, planIds: [], submittedCount: 0 };
    c.planIds.push(plan.id);
    c.submittedCount += sessions.filter((s) => s.planId === plan.id && s.state === 'submitted').length;
    byFp.set(plan.fingerprint, c);
  }
  return [...byFp.values()].sort((a, b) => b.plan.createdAt.localeCompare(a.plan.createdAt));
}

export interface ComparisonRow {
  session: Session;
  candidateKey: string;
  scorecard: Scorecard;
}

/**
 * FLOW-30: submitted sessions for one plan fingerprint, with scorecards. Imported sessions are
 * included only when their candidate's panel is not hidden (FLOW-27: hideImported).
 */
export async function loadComparison(fingerprint: string): Promise<{ plan: InterviewPlan; rows: ComparisonRow[]; decisions: Map<string, PanelDecision> } | null> {
  const [plans, sessions, independent, records] = await Promise.all([db.plans.toArray(), db.sessions.toArray(), getIndependentScoring(), db.panelRecords.where('fingerprint').equals(fingerprint).toArray()]);
  const matching = plans.filter((p) => p.fingerprint === fingerprint);
  if (!matching.length) return null;
  const planIds = new Set(matching.map((p) => p.id));
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const all = sessions.filter((s) => planIds.has(s.planId));
  const inPlan = all.filter((s) => s.state === 'submitted');
  const hidden = (key: string) => hideImported(independent, all.filter((s) => s.origin === 'local' && candidateKey(s.candidate) === key));
  // FLOW-27 hides imported records only; judgements entered here by hand are always shown (TEAM-7).
  const visible = inPlan.filter((s) => s.origin !== 'imported' || !hidden(candidateKey(s.candidate)));
  const answers = groupAnswers(await db.answers.where('sessionId').anyOf(visible.map((s) => s.id)).toArray());
  return {
    plan: matching[0],
    rows: visible.map((session) => ({
      session,
      candidateKey: candidateKey(session.candidate),
      scorecard: computeScorecard(plansById.get(session.planId)!, answers.get(session.id) ?? []),
    })),
    // TEAM-12: the panel decision of each candidate with these questions.
    decisions: new Map(records.filter((r) => r.decision).map((r) => [candidateKey(r.candidate), r.decision!])),
  };
}

function groupAnswers(answers: Answer[]): Map<string, Answer[]> {
  const m = new Map<string, Answer[]>();
  for (const a of answers) m.set(a.sessionId, [...(m.get(a.sessionId) ?? []), a]);
  return m;
}
