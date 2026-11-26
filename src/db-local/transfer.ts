import { db } from './db';
import { RepoError, appendAudit } from './util';
import { auditCsv, exportFileName, planFile, scorecardCsv, scorecardMarkdown, sessionFile, toJson } from '../domain/export';
import { computeScorecard } from '../domain/scoring';
import { validatePlanFile, validateSessionFile } from '../domain/validation';
import type { AuditEvent } from '../domain/types';
import { queryAudit, type AuditFilter } from './audit';
import { isBlinded } from './panels';
import { getAiView } from './attachments';
import { buildAiReport } from '../domain/ai/report';
import { candidateKey } from '../domain/plan';
import { matchRecord, panelKey, type FileMatch } from '../domain/team';

const BLINDED = 'This panelist’s scores stay hidden until your own interview of this candidate, on the same plan, is submitted.';

export interface ExportedFile {
  fileName: string;
  mime: string;
  text: string;
}

const T = () => [db.plans, db.sessions, db.answers, db.audit, db.settings, db.transcripts, db.recordings, db.aiResults, db.plannedInterviews];

/** FLOW-9, DATA-4: export a locked plan so panelists share it. Audited (FLOW-32). */
export async function exportPlanFile(planId: string): Promise<ExportedFile> {
  return db.transaction('rw', T(), async () => {
    const plan = await db.plans.get(planId);
    if (!plan) throw new RepoError('not-found', 'Plan not found.');
    if (!plan.locked) throw new RepoError('not-locked', 'Only locked plans can be exported.');
    await appendAudit({ action: 'export', entity: 'plan', entityId: planId, after: { format: 'plan-json', fingerprint: plan.fingerprint } });
    return { fileName: exportFileName('plan', planId, 'json'), mime: 'application/json', text: toJson(planFile(plan)) };
  });
}

/**
 * FLOW-26, DATA-4: export a submitted session with its plan embedded. Audited (FLOW-32).
 * TR-3, AI-9: the file never carries the transcript, recording or AI result (they live in their
 * own tables), so panel files stay small and safe for blind scoring.
 */
export async function exportSessionFile(sessionId: string): Promise<ExportedFile> {
  return db.transaction('rw', T(), async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new RepoError('not-found', 'Interview not found.');
    if (session.state !== 'submitted') throw new RepoError('not-submitted', 'Only submitted interviews can be exported for the debrief.');
    if (await isBlinded(session)) throw new RepoError('blinded', BLINDED); // FLOW-27
    const plan = await db.plans.get(session.planId);
    if (!plan) throw new RepoError('not-found', 'The plan for this interview is missing.');
    const answers = await db.answers.where('sessionId').equals(sessionId).toArray();
    await appendAudit({ action: 'export', entity: 'session', entityId: sessionId, after: { format: 'session-json' } });
    return { fileName: exportFileName('session', sessionId, 'json'), mime: 'application/json', text: toJson(sessionFile(plan, session, answers)) };
  });
}

export type ScorecardFormat = 'markdown' | 'csv' | 'print';

/**
 * FLOW-31, FLOW-32: scorecard as Markdown or CSV, audited. For 'print', nothing is returned:
 * call it just before window.print() so the PDF export is recorded too.
 */
export async function exportScorecard(sessionId: string, format: 'markdown' | 'csv'): Promise<ExportedFile>;
export async function exportScorecard(sessionId: string, format: 'print'): Promise<null>;
export async function exportScorecard(sessionId: string, format: ScorecardFormat): Promise<ExportedFile | null> {
  return db.transaction('rw', T(), async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new RepoError('not-found', 'Interview not found.');
    if (await isBlinded(session)) throw new RepoError('blinded', BLINDED); // FLOW-27
    const plan = await db.plans.get(session.planId);
    if (!plan) throw new RepoError('not-found', 'The plan for this interview is missing.');
    const answers = await db.answers.where('sessionId').equals(sessionId).toArray();
    await appendAudit({ action: 'export', entity: 'session', entityId: sessionId, after: { format: `scorecard-${format}` } });
    if (format === 'print') return null;
    const sc = computeScorecard(plan, answers);
    // AI-9, AI-11: the AI second opinion is included, under its own label, only once the
    // interview is submitted (getAiView applies the rule).
    const view = await getAiView(sessionId);
    const ai = view.state === 'ready' ? buildAiReport(plan, sc, view.record.result, view.currentTranscriptHash) : null;
    return format === 'markdown'
      ? { fileName: exportFileName('scorecard', sessionId, 'md'), mime: 'text/markdown', text: scorecardMarkdown(plan, session, sc, ai) }
      : { fileName: exportFileName('scorecard', sessionId, 'csv'), mime: 'text/csv', text: scorecardCsv(sc, ai) };
  });
}

/** AUD-3: audit log as CSV (filtered like queryAudit). The export itself is audited. */
export async function exportAuditCsv(filter: AuditFilter = {}): Promise<ExportedFile> {
  const events: AuditEvent[] = await queryAudit(filter);
  // The scope must be an async function: Dexie only keeps the transaction alive across the
  // awaits inside appendAudit when it can track them ("Transaction committed too early" otherwise).
  await db.transaction('rw', [db.audit, db.settings], async () => {
    await appendAudit({ action: 'export', entity: 'audit', after: { format: 'audit-csv', rows: events.length } });
  });
  return { fileName: exportFileName('audit', 'log00000', 'csv'), mime: 'text/csv', text: auditCsv(events) };
}

/** FLOW-9, SEC-2: import a shared locked plan. Idempotent when the same plan is already here. */
export async function importPlanFile(json: unknown): Promise<{ planId: string; alreadyPresent: boolean }> {
  const v = validatePlanFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The question set file is not valid.', v.errors);
  const { plan } = v.value;
  return db.transaction('rw', T(), async () => {
    const existing = await db.plans.get(plan.id);
    if (existing) {
      if (existing.fingerprint !== plan.fingerprint) throw new RepoError('conflict', 'A different question set with the same id is already on this device.');
      return { planId: plan.id, alreadyPresent: true };
    }
    await db.plans.add(plan);
    await appendAudit({ action: 'import', entity: 'plan', entityId: plan.id, after: { format: 'plan-json', fingerprint: plan.fingerprint } });
    return { planId: plan.id, alreadyPresent: false };
  });
}

export interface SessionImportResult {
  sessionId: string;
  planId: string;
  /** TEAM-5: the interview on this device the record was matched to (or none, with the reason). */
  match: FileMatch;
  /** The same interviewer's file had been imported before and was replaced. */
  replaced: boolean;
}

/**
 * FLOW-26, FLOW-27, SEC-2, TEAM-5: import another interviewer's submitted interview file. The
 * session is stored with origin 'imported' (read-only); its embedded plan is added if this device
 * has not seen it. Re-importing the same file replaces the earlier copy. It is matched to an
 * interview here by its invitation id, else by candidate key and plan fingerprint; a file that
 * matches nothing is still kept (it shows as an interview from another device).
 */
export async function importSessionFile(json: unknown): Promise<SessionImportResult> {
  const v = validateSessionFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The interview file is not valid.', v.errors);
  const { plan, session, answers } = v.value;
  return db.transaction('rw', T(), async () => {
    const existingPlan = await db.plans.get(plan.id);
    if (existingPlan && existingPlan.fingerprint !== plan.fingerprint) {
      throw new RepoError('conflict', 'This interview’s questions clash with a different question set on this device.');
    }
    const existing = await db.sessions.get(session.id);
    if (existing?.origin === 'local') throw new RepoError('own-session', 'This is your own interview; it is already on this device.');
    if (!existingPlan) await db.plans.add(plan);
    await db.answers.where('sessionId').equals(session.id).delete();
    // AI-9, FLOW-27: an imported panelist session never carries a transcript, recording or AI result.
    await Promise.all([db.transcripts.delete(session.id), db.recordings.delete(session.id), db.aiResults.delete(session.id)]);
    await db.sessions.put({ ...session, origin: 'imported', timer: { ...session.timer, runningSince: null } });
    await db.answers.bulkPut(answers.map((a) => ({ ...a, timer: { accumulatedMs: a.timer?.accumulatedMs ?? a.elapsedSec * 1000, runningSince: null } })));
    await appendAudit({
      action: 'import',
      entity: 'session',
      entityId: session.id,
      after: { format: 'session-json', planFingerprint: plan.fingerprint, replaced: !!existing },
    });
    // TEAM-5: which interview it belongs to (grouping itself stays candidate key + fingerprint, FLOW-29).
    const planned = await db.plannedInterviews.toArray();
    const fpByPlan = new Map((await db.plans.toArray()).map((p) => [p.id, p.fingerprint]));
    const others = (await db.sessions.toArray()).filter((s) => s.id !== session.id);
    const keys = new Set(others.map((s) => panelKey(s.candidate, fpByPlan.get(s.planId))));
    const match = matchRecord({ invitationId: session.invitationId, candidateKey: candidateKey(session.candidate), fingerprint: plan.fingerprint! }, planned, keys);
    return { sessionId: session.id, planId: plan.id, match, replaced: !!existing };
  });
}
