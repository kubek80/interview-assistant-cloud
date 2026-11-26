// TEAM-13: panel files. Everything held for one or more panels (every judgement on this device,
// own, imported and entered by hand; the panel decision; the written summary), with the transcript
// and AI second opinion only when chosen; never recordings. Import merges with what is here.
import { db } from './db';
import { RepoError, appendAudit, clock, getSetting, newId, nowIso } from './util';
import { SETTINGS } from './db';
import { isBlinded } from './panels';
import { getAiView } from './attachments';
import { getDefaultRetentionDays } from './settings';
import { resolvePanel } from './decisions';
import { exportFileName, panelFile, toJson } from '../domain/export';
import { validatePanelFile } from '../domain/validation';
import { addDays, candidateKey, formatCandidateKey, isoDate } from '../domain/plan';
import { decisionChanges } from '../domain/decision';
import { panelKey as keyOf, uniqueNames } from '../domain/team';
import { interviewersOf } from '../domain/interviewers';
import type { Answer, InterviewPlan, PanelDecision, PanelFileEntry, PanelRecord, Session, SharedAttachment, WrittenSummary } from '../domain/types';
import type { ExportedFile } from './transfer';

const TABLES = () => [db.sessions, db.answers, db.plans, db.audit, db.settings, db.plannedInterviews, db.panelRecords, db.transcripts, db.recordings, db.aiResults, db.tracks];

export interface PanelExportOptions {
  /** Include this device's transcripts (and any that came with earlier panel files). Off by default. */
  transcript?: boolean;
  /** Include the AI second opinions. Off by default. */
  ai?: boolean;
}

function cleanPlan(p: InterviewPlan): InterviewPlan {
  const { id, trackId, trackVersion, name, questions, categories, timeBudgetMin, locked, lockedAt, fingerprint, createdAt } = p;
  return { id, trackId, trackVersion, name, questions, categories, timeBudgetMin, locked, lockedAt, fingerprint, createdAt };
}

/**
 * TEAM-13: one panel file for these panels (`refs`: any record of each panel, or its panel record).
 * Records still hidden by independent scoring (FLOW-27) are left out and counted. Audited.
 */
export async function exportPanelFile(refs: readonly string[], opts: PanelExportOptions = {}): Promise<ExportedFile & { panels: number; judgements: number; leftOut: number }> {
  if (!refs.length) throw new RepoError('invalid', 'Choose at least one interview.');
  return db.transaction('rw', TABLES(), async () => {
    const me = (await getSetting<string>(SETTINGS.interviewerName))?.trim() || 'Unknown';
    const entries: PanelFileEntry[] = [];
    const seen = new Set<string>();
    let leftOut = 0;
    let transcripts = 0;
    let ais = 0;
    for (const ref of refs) {
      const p = await resolvePanel(ref);
      if (seen.has(p.panelKey)) continue;
      seen.add(p.panelKey);
      const judgements: PanelFileEntry['judgements'] = [];
      const shared: SharedAttachment[] = [];
      for (const s of p.records.filter((r) => r.state === 'submitted').sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))) {
        if (await isBlinded(s)) {
          leftOut++;
          continue;
        }
        const answers = await db.answers.where('sessionId').equals(s.id).toArray();
        judgements.push({ session: { ...s, timer: { ...s.timer, runningSince: null } }, answers: answers.map((a) => ({ ...a, timer: { accumulatedMs: a.timer?.accumulatedMs ?? 0, runningSince: null } })) });
        if (s.origin !== 'local' || !(opts.transcript || opts.ai)) continue;
        const item: SharedAttachment = { sessionId: s.id, interviewers: interviewersOf(s) };
        if (opts.transcript) {
          const t = await db.transcripts.get(s.id);
          if (t) item.transcript = { format: t.format, text: t.transcript.text, speakers: [...t.transcript.speakers] };
        }
        if (opts.ai) {
          const view = await getAiView(s.id);
          if (view.state === 'ready') {
            const r = view.record.result;
            item.aiSecondOpinion = { model: r.model, createdAt: r.createdAt, questions: r.questions.map((q) => ({ questionId: q.questionId, covered: q.covered, score: q.score, rationale: q.rationale })) };
          }
        }
        if (item.transcript || item.aiSecondOpinion) shared.push(item);
      }
      // What came with earlier panel files travels on, under the same choices.
      for (const s of p.record?.shared ?? []) {
        if (shared.some((x) => x.sessionId === s.sessionId)) continue;
        const item: SharedAttachment = { sessionId: s.sessionId, interviewers: s.interviewers };
        if (opts.transcript && s.transcript) item.transcript = s.transcript;
        if (opts.ai && s.aiSecondOpinion) item.aiSecondOpinion = s.aiSecondOpinion;
        if (item.transcript || item.aiSecondOpinion) shared.push(item);
      }
      transcripts += shared.filter((x) => x.transcript).length;
      ais += shared.filter((x) => x.aiSecondOpinion).length;
      const dated = [...p.planned].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0];
      const retention = [...p.records.map((r) => r.candidate.retentionUntil), ...p.planned.map((x) => x.retentionUntil), p.record?.retentionUntil ?? ''].filter(Boolean).sort().pop()!;
      entries.push({
        plan: cleanPlan(p.plan),
        candidate: { initials: p.candidate.initials, requisitionId: p.candidate.requisitionId },
        retentionUntil: retention ?? isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays())),
        expected: uniqueNames([...p.planned.flatMap((x) => x.expected), ...(p.planned.length ? [] : (p.record?.expected ?? []))]),
        date: dated?.date ?? p.record?.date ?? null,
        time: dated?.date ? dated.time : (p.record?.time ?? null),
        judgements,
        decision: p.record?.decision ?? null,
        summary: p.record?.summary ?? null,
        ...(shared.length ? { shared } : {}),
      });
    }
    const count = entries.reduce((n, e) => n + e.judgements.length, 0);
    await appendAudit({
      action: 'export',
      entity: 'panel',
      entityId: null,
      after: { format: 'panel-json', panels: entries.length, judgements: count, decisions: entries.filter((e) => e.decision).length, transcripts, aiSecondOpinions: ais, leftOutHidden: leftOut },
    });
    const now = new Date(clock.now());
    return { fileName: exportFileName('panel', newId(), 'json', now), mime: 'application/json', text: toJson(panelFile(entries, me, now)), panels: entries.length, judgements: count, leftOut };
  });
}

export type PartOutcome = 'none' | 'added' | 'same' | 'conflict';

export interface PanelImportItem {
  /** The panel record here (for "keep mine / take theirs"). */
  panelId: string;
  /** Route id of the candidate page. */
  ref: string;
  candidate: string;
  added: number;
  updated: number;
  identical: number;
  /** Records that are this device's own (left as they are). */
  own: number;
  decision: PartOutcome;
  summary: PartOutcome;
  /** Theirs, when it differs from what is here (nothing was overwritten). */
  theirs: { decision?: PanelDecision; summary?: WrittenSummary };
  /** A panel not imported at all, and why. */
  problem?: string;
}

export interface PanelImportResult {
  exportedBy: string;
  items: PanelImportItem[];
}

const sameRecord = (a: Session, aAnswers: readonly Answer[], b: Session, bAnswers: readonly Answer[]) => {
  const pick = (s: Session) => JSON.stringify([s.overall, interviewersOf(s), s.state, s.submittedAt, s.origin === 'entered' ? s.enteredBy : null]);
  const ans = (xs: readonly Answer[]) => JSON.stringify([...xs].sort((x, y) => x.questionId.localeCompare(y.questionId)).map((a) => [a.questionId, a.score, a.skipped, a.skipReason, a.flagged, a.notes.map((n) => [n.text, n.by ?? null]), a.coveredKeyPoints, a.redFlagsSeen]));
  return pick(a) === pick(b) && ans(aAnswers) === ans(bAnswers);
};

/**
 * TEAM-13, SEC-2: imports a panel file (validated as a whole first). Per panel:
 *   - the questions are added when this device does not have them (a clash skips the panel);
 *   - judgements: new ones are added; identical ones are skipped; a different copy of one imported
 *     or entered before replaces it; this device's own records are never touched;
 *   - the panel decision and the written summary are taken when there is none here; when they
 *     differ from what is here, nothing is overwritten: the difference is reported, with theirs,
 *     so a person can keep theirs or keep this device's (resolvePanelConflict).
 * Audited.
 */
export async function importPanelFile(json: unknown): Promise<PanelImportResult> {
  const v = validatePanelFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The panel file is not valid.', v.errors);
  const file = v.value;
  return db.transaction('rw', TABLES(), async () => {
    const today = isoDate(new Date(clock.now()));
    const fallback = isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays()));
    const items: PanelImportItem[] = [];
    for (const e of file.panels) items.push(await importEntry(e, e.retentionUntil >= today ? e.retentionUntil : fallback));
    const sum = (k: 'added' | 'updated' | 'identical' | 'own') => items.reduce((n, i) => n + i[k], 0);
    await appendAudit({
      action: 'import',
      entity: 'panel',
      entityId: items.length === 1 ? items[0].panelId || null : null,
      after: {
        format: 'panel-json',
        panels: items.length,
        judgementsAdded: sum('added'),
        judgementsUpdated: sum('updated'),
        judgementsIdentical: sum('identical'),
        decisionsAdded: items.filter((i) => i.decision === 'added').length,
        decisionConflicts: items.filter((i) => i.decision === 'conflict').length,
        summaryConflicts: items.filter((i) => i.summary === 'conflict').length,
        skipped: items.filter((i) => i.problem).length,
      },
    });
    return { exportedBy: file.exportedBy, items };
  });
}

async function importEntry(e: PanelFileEntry, retentionUntil: string): Promise<PanelImportItem> {
  const item: PanelImportItem = { panelId: '', ref: '', candidate: formatCandidateKey(e.candidate), added: 0, updated: 0, identical: 0, own: 0, decision: 'none', summary: 'none', theirs: {} };
  const plan = cleanPlan(e.plan);
  const existingPlan = await db.plans.get(plan.id);
  if (existingPlan && existingPlan.fingerprint !== plan.fingerprint) return { ...item, problem: 'Its questions clash with a different question set on this device.' };
  if (!existingPlan) await db.plans.add(plan);
  const key = keyOf(e.candidate, plan.fingerprint);

  for (const j of e.judgements) {
    const existing = await db.sessions.get(j.session.id);
    if (existing?.origin === 'local') {
      item.own++;
      continue;
    }
    if (existing && candidateKey(existing.candidate) !== candidateKey(e.candidate)) {
      item.own++;
      continue;
    }
    const origin: Session['origin'] = j.session.origin === 'entered' ? 'entered' : 'imported';
    const session: Session = { ...j.session, origin, timer: { ...j.session.timer, runningSince: null } };
    if (origin !== 'entered') {
      delete session.enteredBy;
      delete session.enteredAt;
    }
    const answers = j.answers.map((a) => ({ ...a, timer: { accumulatedMs: a.timer?.accumulatedMs ?? a.elapsedSec * 1000, runningSince: null } }));
    if (existing) {
      const mine = await db.answers.where('sessionId').equals(existing.id).toArray();
      if (sameRecord(existing, mine, session, answers)) {
        item.identical++;
        continue;
      }
      item.updated++;
    } else item.added++;
    await db.answers.where('sessionId').equals(session.id).delete();
    await Promise.all([db.transcripts.delete(session.id), db.recordings.delete(session.id), db.aiResults.delete(session.id)]);
    await db.sessions.put(session);
    await db.answers.bulkPut(answers);
  }

  const now = nowIso();
  let record = await db.panelRecords.where('panelKey').equals(key).first();
  if (!record) {
    record = {
      id: newId(),
      panelKey: key,
      candidate: { initials: e.candidate.initials.trim().replace(/\s+/g, ' '), requisitionId: e.candidate.requisitionId?.trim() || null },
      fingerprint: plan.fingerprint!,
      planId: plan.id,
      retentionUntil,
      decision: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  const next: PanelRecord = { ...record, retentionUntil: record.retentionUntil > retentionUntil ? record.retentionUntil : retentionUntil };
  if (e.expected.length && !next.expected?.length) next.expected = uniqueNames(e.expected);
  if (e.date && !next.date) {
    next.date = e.date;
    next.time = e.time;
  }
  if (e.decision) {
    if (!next.decision) {
      next.decision = e.decision;
      item.decision = 'added';
    } else if (decisionChanges(next.decision, e.decision).length) {
      item.decision = 'conflict';
      item.theirs.decision = e.decision;
    } else item.decision = 'same';
  }
  if (e.summary?.text.trim()) {
    if (!next.summary?.text.trim()) {
      next.summary = e.summary;
      item.summary = 'added';
    } else if (next.summary.text.trim() !== e.summary.text.trim()) {
      item.summary = 'conflict';
      item.theirs.summary = e.summary;
    } else item.summary = 'same';
  }
  for (const s of e.shared ?? []) {
    const list = next.shared ?? [];
    const at = list.findIndex((x) => x.sessionId === s.sessionId);
    next.shared = at < 0 ? [...list, s] : list.map((x, i) => (i === at ? { ...x, ...s } : x));
  }
  if (JSON.stringify(next) !== JSON.stringify(record)) await db.panelRecords.put({ ...next, updatedAt: now });
  item.panelId = next.id;
  const first = await db.sessions.where('planId').equals(plan.id).filter((s) => candidateKey(s.candidate) === candidateKey(e.candidate)).first();
  item.ref = first?.id ?? next.id;
  return item;
}

/**
 * TEAM-13: after an import reported a different panel decision or summary, a person chooses:
 * "Keep mine" does nothing; "Take theirs" replaces this device's with theirs. Taking theirs is a
 * change: it is audited with the values before and after and the reason given.
 */
export async function takeTheirs(panelId: string, part: 'decision' | 'summary', theirs: PanelDecision | WrittenSummary, from: string): Promise<void> {
  await db.transaction('rw', TABLES(), async () => {
    const record = await db.panelRecords.get(panelId);
    if (!record) throw new RepoError('not-found', 'That interview is no longer on this device.');
    const now = nowIso();
    const reason = `Taken from a panel file from ${from}`;
    if (part === 'decision') {
      const d = theirs as PanelDecision;
      const fields = record.decision ? decisionChanges(record.decision, d) : (['recommendation', 'rationale', 'participants', 'rating', 'scores'] as const);
      await db.panelRecords.put({ ...record, decision: d, updatedAt: now });
      await appendAudit({
        action: 'decision.changed',
        entity: 'panel',
        entityId: record.id,
        before: record.decision ? Object.fromEntries(fields.map((f) => [f, record.decision![f]])) : null,
        after: Object.fromEntries(fields.map((f) => [f, d[f]])),
        reason,
      });
    } else {
      const s = theirs as WrittenSummary;
      await db.panelRecords.put({ ...record, summary: s, updatedAt: now });
      await appendAudit({ action: 'summary.saved', entity: 'panel', entityId: record.id, after: { characters: s.text.length }, reason });
    }
  });
}
