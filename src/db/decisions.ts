// TEAM-7…TEAM-12, SUM-1, SUM-3, SUM-4: judgements entered by hand, the panel decision, the written
// summary, and the data behind the Summary screen and the candidate page.
//
// A panel is a candidate key plus a plan fingerprint (FLOW-29). Its decision and written summary
// live in one PanelRecord per panel; judgements entered by hand are ordinary records (sessions)
// with origin 'entered', so the debrief, attendance, exports and privacy requests pick them up.
import { db, SETTINGS } from './db';
import { RepoError, appendAudit, clock, getSetting, newId, nowIso } from './util';
import { getDefaultRetentionDays, getIndependentScoring } from './settings';
import { buildPanel, panelAiEntries, type PanelAiEntry } from './panels';
import { addDays, candidateKey, isoDate } from '../domain/plan';
import { computeScorecard } from '../domain/scoring';
import { panelKey as keyOf, uniqueNames } from '../domain/team';
import { interviewersOf } from '../domain/interviewers';
import {
  MAX_SUMMARY,
  cleanDecision,
  decisionChanges,
  decisionProblems,
  enteredAnswers,
  judgementProblems,
  type DecisionInput,
  type EnteredJudgementInput,
} from '../domain/decision';
import type { RoundPanelData } from '../domain/round';
import type { Answer, InterviewPlan, PanelDecision, PanelRecord, PlannedInterview, Score, Session } from '../domain/types';

const TABLES = () => [db.sessions, db.answers, db.plans, db.audit, db.settings, db.plannedInterviews, db.panelRecords, db.tracks];

export interface ResolvedPanel {
  plan: InterviewPlan;
  candidate: { initials: string; requisitionId: string | null };
  panelKey: string;
  /** Every record of the panel (local, imported, entered). */
  records: Session[];
  planned: PlannedInterview[];
  record: PanelRecord | undefined;
}

/** All records of a panel on this device, any origin. */
async function recordsOf(candidate: { initials: string; requisitionId: string | null | undefined }, fingerprint: string): Promise<Session[]> {
  const planIds = (await db.plans.where('fingerprint').equals(fingerprint).primaryKeys()) as string[];
  const key = candidateKey(candidate);
  return planIds.length ? db.sessions.where('planId').anyOf(planIds).filter((s) => candidateKey(s.candidate) === key).toArray() : [];
}

/**
 * The panel a screen refers to: `ref` is the id of any record of the panel, or of its panel record
 * (a panel imported from a panel file may have a decision and no records).
 */
export async function resolvePanel(ref: string): Promise<ResolvedPanel> {
  const session = await db.sessions.get(ref);
  let plan: InterviewPlan | undefined;
  let candidate: { initials: string; requisitionId: string | null };
  if (session) {
    plan = await db.plans.get(session.planId);
    candidate = { initials: session.candidate.initials, requisitionId: session.candidate.requisitionId };
  } else {
    const rec = await db.panelRecords.get(ref);
    if (!rec) throw new RepoError('not-found', 'This interview is not on this device.');
    plan = (await db.plans.get(rec.planId)) ?? (await db.plans.where('fingerprint').equals(rec.fingerprint).first());
    candidate = rec.candidate;
  }
  if (!plan?.fingerprint) throw new RepoError('not-found', 'The questions of this interview are missing.');
  const panelKey = keyOf(candidate, plan.fingerprint);
  const [records, planned, record] = await Promise.all([
    recordsOf(candidate, plan.fingerprint),
    db.plannedInterviews.where('fingerprint').equals(plan.fingerprint).filter((p) => candidateKey(p.candidate) === candidateKey(candidate)).toArray(),
    db.panelRecords.where('panelKey').equals(panelKey).first(),
  ]);
  return { plan, candidate, panelKey, records, planned, record };
}

async function deviceName(): Promise<string> {
  const name = (await getSetting<string>(SETTINGS.interviewerName))?.trim();
  if (!name) throw new RepoError('name-required', 'Enter your name for this device first (Admin › This device).');
  return name;
}

/** PRIV-5, TEAM-14: a panel record is kept as long as the longest-kept record of its panel. */
async function retentionFor(p: Pick<ResolvedPanel, 'records' | 'planned'>): Promise<string> {
  const dates = [...p.records.map((s) => s.candidate.retentionUntil), ...p.planned.map((x) => x.retentionUntil)].filter(Boolean).sort();
  return dates[dates.length - 1] ?? isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays()));
}

/** The panel record of a panel, created (empty) when there is none yet. */
async function ensureRecord(p: ResolvedPanel): Promise<PanelRecord> {
  if (p.record) return p.record;
  const now = nowIso();
  const record: PanelRecord = {
    id: newId(),
    panelKey: p.panelKey,
    candidate: { initials: p.candidate.initials, requisitionId: p.candidate.requisitionId },
    fingerprint: p.plan.fingerprint!,
    planId: p.plan.id,
    retentionUntil: await retentionFor(p),
    decision: null,
    summary: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.panelRecords.add(record);
  return record;
}

/** Names that already have a submitted judgement in the panel. */
function takenNames(records: readonly Session[], except?: string): string[] {
  return records.filter((s) => s.state === 'submitted' && s.id !== except).flatMap((s) => interviewersOf(s));
}

// ---------------------------------------------------------------------------------------------
// TEAM-7, TEAM-8: another interviewer's judgement, entered by hand

/**
 * TEAM-7: records another interviewer's judgement on their behalf: name, overall rating,
 * recommendation and rationale, and optionally a score and a note per question. Stored as a
 * submitted record with origin 'entered' ("entered by … on behalf of …", TEAM-8). Audited.
 */
export async function enterJudgement(ref: string, input: EnteredJudgementInput): Promise<string> {
  return db.transaction('rw', TABLES(), async () => {
    const p = await resolvePanel(ref);
    const errors = judgementProblems(input, p.plan, takenNames(p.records));
    if (Object.keys(errors).length) throw new RepoError('invalid', 'Some details of the judgement are missing or not valid.', Object.values(errors) as string[]);
    const me = await deviceName();
    const now = nowIso();
    const name = input.name.trim().replace(/\s+/g, ' ');
    const invitationId = p.planned[0]?.id ?? p.records.find((r) => r.invitationId)?.invitationId;
    const session: Session = {
      id: newId(),
      planId: p.plan.id,
      candidate: { initials: p.candidate.initials, requisitionId: p.candidate.requisitionId, consentAt: null, retentionUntil: await retentionFor(p) },
      interviewer: { name },
      interviewers: [name],
      state: 'submitted',
      currentQuestionId: null,
      timer: { accumulatedMs: 0, runningSince: null },
      overall: { rating: input.rating, recommendation: input.recommendation, rationale: input.rationale.trim() },
      createdAt: now,
      startedAt: null,
      submittedAt: now,
      origin: 'entered',
      ...(invitationId ? { invitationId } : {}),
      enteredBy: me,
      enteredAt: now,
    };
    const answers = enteredAnswers(session.id, p.plan, input);
    await db.sessions.add(session);
    await db.answers.bulkAdd(answers);
    await appendAudit({
      action: 'judgement.entered',
      entity: 'session',
      entityId: session.id,
      after: { onBehalfOf: name, questionsScored: answers.filter((a) => a.score != null).length, notes: answers.filter((a) => a.notes.length).length },
    });
    return session.id;
  });
}

/** The current input of a judgement entered by hand (to correct it). */
export async function enteredJudgementInput(sessionId: string): Promise<EnteredJudgementInput> {
  const session = await db.sessions.get(sessionId);
  if (!session || session.origin !== 'entered') throw new RepoError('not-found', 'That judgement was not entered on this device.');
  const answers = await db.answers.where('sessionId').equals(sessionId).toArray();
  return {
    name: session.interviewer.name,
    rating: session.overall.rating,
    recommendation: session.overall.recommendation,
    rationale: session.overall.rationale,
    scores: Object.fromEntries(answers.filter((a) => a.score != null).map((a) => [a.questionId, a.score])),
    notes: Object.fromEntries(answers.filter((a) => a.notes.length).map((a) => [a.questionId, a.notes.map((n) => n.text).join('\n')])),
  };
}

/**
 * TEAM-8, AUD-4: corrects a judgement entered by hand. A reason is required; the values before and
 * after are written to the audit log ("edited after submission").
 */
export async function amendEnteredJudgement(sessionId: string, input: EnteredJudgementInput, reason: string): Promise<void> {
  if (!reason.trim()) throw new RepoError('reason-required', 'Give a reason for the correction.');
  await db.transaction('rw', TABLES(), async () => {
    const session = await db.sessions.get(sessionId);
    if (!session || session.origin !== 'entered') throw new RepoError('not-found', 'That judgement was not entered on this device.');
    const p = await resolvePanel(sessionId);
    const errors = judgementProblems(input, p.plan, takenNames(p.records, sessionId));
    if (Object.keys(errors).length) throw new RepoError('invalid', 'Some details of the judgement are missing or not valid.', Object.values(errors) as string[]);
    const before = await enteredJudgementInput(sessionId);
    const name = input.name.trim().replace(/\s+/g, ' ');
    const after: EnteredJudgementInput = { ...input, name, rationale: input.rationale.trim() };
    const b: Record<string, unknown> = {};
    const a: Record<string, unknown> = {};
    for (const k of ['name', 'rating', 'recommendation', 'rationale'] as const) {
      if (before[k] !== after[k]) {
        b[k] = before[k];
        a[k] = after[k];
      }
    }
    for (const k of ['scores', 'notes'] as const) {
      const diffB: Record<string, unknown> = {};
      const diffA: Record<string, unknown> = {};
      for (const q of p.plan.questions) {
        const x = before[k][q.id] || null;
        const y = (k === 'notes' ? (after[k][q.id] ?? '').trim() : after[k][q.id]) || null;
        if (x !== y) {
          diffB[q.id] = x;
          diffA[q.id] = y;
        }
      }
      if (Object.keys(diffA).length) {
        b[k] = diffB;
        a[k] = diffA;
      }
    }
    if (!Object.keys(a).length) return;
    await db.sessions.put({ ...session, interviewer: { name }, interviewers: [name], overall: { rating: after.rating, recommendation: after.recommendation, rationale: after.rationale } });
    await db.answers.where('sessionId').equals(sessionId).delete();
    await db.answers.bulkAdd(enteredAnswers(sessionId, p.plan, after));
    await appendAudit({ action: 'session.amended', entity: 'session', entityId: sessionId, before: b, after: a, reason: reason.trim() });
  });
}

// ---------------------------------------------------------------------------------------------
// TEAM-9…TEAM-11: the panel decision

/**
 * TEAM-9…TEAM-11: records the panel decision, or changes it. One per panel. It needs no
 * judgements behind it (TEAM-10). A change needs a reason and is audited with the values before
 * and after; individual scores are never touched.
 */
export async function recordDecision(ref: string, input: DecisionInput, reason?: string): Promise<PanelDecision> {
  return db.transaction('rw', TABLES(), async () => {
    const p = await resolvePanel(ref);
    const errors = decisionProblems(input, p.plan);
    if (Object.keys(errors).length) throw new RepoError('invalid', 'The panel decision is not complete.', Object.values(errors) as string[]);
    const me = await deviceName();
    const now = nowIso();
    const record = await ensureRecord(p);
    const next = cleanDecision(input);
    const old = record.decision;
    if (old) {
      if (!reason?.trim()) throw new RepoError('reason-required', 'Give a reason for changing the panel decision.');
      const fields = decisionChanges(old, next);
      if (!fields.length) return old;
      const decision: PanelDecision = { ...old, ...next, changedBy: me, changedAt: now };
      await db.panelRecords.put({ ...record, decision, updatedAt: now });
      await appendAudit({
        action: 'decision.changed',
        entity: 'panel',
        entityId: record.id,
        before: Object.fromEntries(fields.map((f) => [f, old[f]])),
        after: Object.fromEntries(fields.map((f) => [f, next[f]])),
        reason: reason.trim(),
      });
      return decision;
    }
    const decision: PanelDecision = { ...next, recordedBy: me, recordedAt: now };
    await db.panelRecords.put({ ...record, decision, updatedAt: now });
    await appendAudit({
      action: 'decision.recorded',
      entity: 'panel',
      entityId: record.id,
      after: { recommendation: decision.recommendation, participants: decision.participants.length, rating: decision.rating, agreedScores: Object.keys(decision.scores).length },
    });
    return decision;
  });
}

// ---------------------------------------------------------------------------------------------
// SUM-4: the written summary

/** How long consecutive saves by the same person count as one edit in the audit log. */
const SUMMARY_AUDIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * SUM-4: saves the written summary of a panel (who and when are kept). The audit log records that
 * it was saved, never the text; saves in quick succession by the same person are one entry.
 */
export async function saveWrittenSummary(ref: string, text: string): Promise<void> {
  if (text.length > MAX_SUMMARY) throw new RepoError('invalid', `Keep the summary under ${MAX_SUMMARY} characters.`);
  await db.transaction('rw', TABLES(), async () => {
    const p = await resolvePanel(ref);
    const me = await deviceName();
    const record = await ensureRecord(p);
    if ((record.summary?.text ?? '') === text) return;
    const now = nowIso();
    await db.panelRecords.put({ ...record, summary: { text, updatedBy: me, updatedAt: now }, updatedAt: now });
    const last = (await db.audit.where('entityId').equals(record.id).toArray()).filter((e) => e.action === 'summary.saved').pop();
    if (last && last.actor === me && clock.now() - Date.parse(last.ts) < SUMMARY_AUDIT_WINDOW_MS) return;
    await appendAudit({ action: 'summary.saved', entity: 'panel', entityId: record.id, after: { characters: text.length } });
  });
}

// ---------------------------------------------------------------------------------------------
// SUM-1, SUM-3: the Summary screen and the candidate page

function groupAnswers(answers: readonly Answer[]): Map<string, Answer[]> {
  const m = new Map<string, Answer[]>();
  for (const a of answers) {
    const list = m.get(a.sessionId);
    if (list) list.push(a);
    else m.set(a.sessionId, [a]);
  }
  return m;
}

function panelData(args: {
  key: string;
  plan: InterviewPlan;
  candidate: { initials: string; requisitionId: string | null };
  records: Session[];
  planned: PlannedInterview[];
  record: PanelRecord | null;
  plansById: ReadonlyMap<string, InterviewPlan>;
  answers: ReadonlyMap<string, Answer[]>;
  independent: boolean;
  trackName: string;
}): RoundPanelData {
  const { records, planned, record } = args;
  const target = records.find((s) => s.origin === 'local') ?? [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const view = target ? buildPanel(target, records, args.plansById, args.answers, planned, args.independent) : null;
  const dated = [...planned].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0];
  return {
    ref: target?.id ?? record!.id,
    panelKey: args.key,
    candidate: args.candidate,
    plan: args.plan,
    trackName: args.trackName,
    records,
    entries: view ? view.entries.map((e) => ({ session: e.session, hidden: e.hidden, answers: e.answers, scorecard: e.scorecard })) : [],
    expected: uniqueNames([...planned.flatMap((x) => x.expected), ...(planned.length ? [] : (record?.expected ?? []))]),
    date: dated?.date ?? record?.date ?? null,
    time: dated?.date ? dated.time : (record?.time ?? null),
    record,
  };
}

/** SUM-1, SUM-6: every panel on this device, with what the Summary screen needs. */
export async function loadRound(): Promise<RoundPanelData[]> {
  const [sessions, plans, planned, records, tracks, independent, answers] = await Promise.all([
    db.sessions.toArray(),
    db.plans.toArray(),
    db.plannedInterviews.toArray(),
    db.panelRecords.toArray(),
    db.tracks.toArray(),
    getIndependentScoring(),
    db.answers.toArray(),
  ]);
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const planByFp = new Map(plans.filter((p) => p.fingerprint).map((p) => [p.fingerprint!, p]));
  const trackNames = new Map(tracks.map((t) => [t.id, t.name]));
  const byAnswers = groupAnswers(answers);
  const groups = new Map<string, { plan: InterviewPlan; candidate: { initials: string; requisitionId: string | null }; records: Session[] }>();
  for (const s of sessions) {
    const plan = plansById.get(s.planId);
    if (!plan?.fingerprint) continue;
    const key = keyOf(s.candidate, plan.fingerprint);
    const g = groups.get(key);
    if (g) g.records.push(s);
    else groups.set(key, { plan, candidate: { initials: s.candidate.initials, requisitionId: s.candidate.requisitionId }, records: [s] });
  }
  for (const r of records) {
    if (groups.has(r.panelKey)) continue;
    const plan = plansById.get(r.planId) ?? planByFp.get(r.fingerprint);
    if (plan) groups.set(r.panelKey, { plan, candidate: r.candidate, records: [] });
  }
  const recordByKey = new Map(records.map((r) => [r.panelKey, r]));
  const plannedByKey = new Map<string, PlannedInterview[]>();
  for (const p of planned) {
    const k = keyOf(p.candidate, p.fingerprint);
    plannedByKey.set(k, [...(plannedByKey.get(k) ?? []), p]);
  }
  return [...groups].map(([key, g]) =>
    panelData({
      key,
      plan: g.plan,
      candidate: g.candidate,
      records: g.records,
      planned: plannedByKey.get(key) ?? [],
      record: recordByKey.get(key) ?? null,
      plansById,
      answers: byAnswers,
      independent,
      trackName: trackNames.get(g.plan.trackId) ?? g.plan.trackId,
    }),
  );
}

export interface CandidatePanel {
  data: RoundPanelData;
  /** AI-9, AI-11: AI second opinions of this device's own submitted records. */
  ai: PanelAiEntry[];
  /** Names offered for "who took part" and "on behalf of". */
  panelNames: string[];
}

/** SUM-3: one panel for the candidate page (and the decision and judgement dialogs). */
export async function loadCandidatePanel(ref: string): Promise<CandidatePanel | null> {
  let p: ResolvedPanel;
  try {
    p = await resolvePanel(ref);
  } catch {
    return null;
  }
  const ids = p.records.map((s) => s.id);
  const [plans, answers, independent, track] = await Promise.all([db.plans.toArray(), db.answers.where('sessionId').anyOf(ids).toArray(), getIndependentScoring(), db.tracks.get(p.plan.trackId)]);
  const plansById = new Map(plans.map((x) => [x.id, x]));
  const data = panelData({
    key: p.panelKey,
    plan: p.plan,
    candidate: p.candidate,
    records: p.records,
    planned: p.planned,
    record: p.record ?? null,
    plansById,
    answers: groupAnswers(answers),
    independent,
    trackName: track?.name ?? p.plan.trackId,
  });
  const own = p.records.filter((s) => s.origin === 'local' && s.state === 'submitted').map((s) => s.id);
  const [results, transcripts] = await Promise.all([db.aiResults.where('sessionId').anyOf(own).toArray(), db.transcripts.where('sessionId').anyOf(own).toArray()]);
  const hashes = new Map(transcripts.map((t) => [t.sessionId, t.hash]));
  const ai = panelAiEntries(
    { entries: data.entries.map((e) => ({ ...e, answers: e.answers, scorecard: e.scorecard })) },
    plansById,
    new Map(results.map((r) => [r.sessionId, { result: r.result, transcriptHash: hashes.get(r.sessionId) ?? null }])),
  );
  const panelNames = uniqueNames([...data.expected, ...p.records.filter((s) => s.state === 'submitted').flatMap((s) => interviewersOf(s))]);
  return { data, ai, panelNames };
}

/** TEAM-12: the panel record (decision, summary) of the panel a record belongs to, or null. */
export async function panelRecordFor(sessionId: string): Promise<PanelRecord | null> {
  const s = await db.sessions.get(sessionId);
  if (!s) return null;
  const plan = await db.plans.get(s.planId);
  if (!plan?.fingerprint) return null;
  return (await db.panelRecords.where('panelKey').equals(keyOf(s.candidate, plan.fingerprint)).first()) ?? null;
}

/** For tests and the median button: each visible judgement's answers. */
export function memberAnswers(data: RoundPanelData): Answer[][] {
  return data.entries.filter((e) => !e.hidden && e.session.state === 'submitted' && e.answers).map((e) => e.answers!);
}

/** Recomputes a scorecard for an entry (helper for screens that only hold answers). */
export function scorecardOf(plan: InterviewPlan, answers: readonly Answer[]) {
  return computeScorecard(plan, answers);
}

export type { Score };
