import { allTables, attachmentTables, db } from './db';
import { RepoError, appendAudit, clock, currentActor, nowIso } from './util';
import { loadSeeds } from './bank';
import { candidateKey, isoDate } from '../domain/plan';
import { exportFileName, toJson } from '../domain/export';
import type { AuditEvent, CandidateDataFile, Session } from '../domain/types';
import type { ExportedFile } from './transfer';

/** Placeholder for audit text that could hold candidate-entered content. */
export const REDACTED = '[redacted]';

/**
 * PRIV-5, PRIV-6 vs AUD-1: when a session is deleted (retention purge or deletion request), the
 * before/after values and reason of its "edited after submission" audit entries can hold note or
 * rationale text about the candidate. Those values are replaced by a marker listing only which
 * fields changed; the entry itself (id, time, actor, action, entity, entity id) is kept, so the
 * log still shows that an amendment happened. Returns the number of entries redacted.
 */
export async function redactAuditForSessions(sessionIds: readonly string[]): Promise<number> {
  if (!sessionIds.length) return 0;
  const entries = await db.audit.where('entityId').anyOf([...sessionIds]).toArray();
  let n = 0;
  for (const e of entries) {
    // TEAM-11: a changed panel decision keeps its rationale before and after, like an amendment.
    if (e.action !== 'session.amended' && e.action !== 'decision.changed') continue;
    const fields = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v).filter((k) => k !== 'questionId') : []);
    const questionId = (v: unknown) => (v && typeof v === 'object' && 'questionId' in v ? (v as { questionId: unknown }).questionId : undefined);
    const redacted = (v: unknown) => ({ redacted: true, ...(questionId(v) ? { questionId: questionId(v) } : {}), fields: fields(v) });
    const next: Partial<AuditEvent> = { before: redacted(e.before), after: redacted(e.after), reason: e.reason == null ? null : REDACTED };
    await db.audit.update(e.id!, next);
    n++;
  }
  return n;
}

/** Draft candidate details (not yet locked) whose candidate key matches. */
/** TR-3: removes the transcripts, recordings and AI results of deleted sessions; returns counts. */
async function deleteAttachments(ids: readonly string[]): Promise<{ transcripts: number; recordings: number; aiResults: number }> {
  if (!ids.length) return { transcripts: 0, recordings: 0, aiResults: 0 };
  const list = [...ids];
  return {
    transcripts: await db.transcripts.where('sessionId').anyOf(list).delete(),
    recordings: await db.recordings.where('sessionId').anyOf(list).delete(),
    aiResults: await db.aiResults.where('sessionId').anyOf(list).delete(),
  };
}

async function draftsFor(key: string) {
  return (await db.candidateDrafts.toArray()).filter((d) => candidateKey({ initials: d.initials, requisitionId: d.requisitionId || null }) === key && d.initials.trim());
}

/**
 * PRIV-5: delete sessions whose retention date has passed (run on every app start). The audit
 * entry records only counts and random ids, never candidate details.
 */
export async function purgeExpired(today: string = isoDate(new Date(clock.now()))): Promise<number> {
  return db.transaction('rw', [db.sessions, db.answers, db.audit, db.settings, db.candidateDrafts, db.plannedInterviews, db.panelRecords, ...attachmentTables()], async () => {
    // The retention date is the last day a session is kept: it is purged from the next day on.
    const expired = await db.sessions.where('candidate.retentionUntil').below(today).toArray();
    // Draft candidate details of plans never locked follow the same rule (their own retention date).
    const drafts = (await db.candidateDrafts.toArray()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.retentionUntil) && d.retentionUntil < today);
    // TEAM-14: planned interviews follow their own retention date, and go with their record.
    const expiredIds = new Set(expired.map((s) => s.id));
    const planned = (await db.plannedInterviews.toArray()).filter((p) => p.retentionUntil < today || expiredIds.has(p.sessionId));
    // TEAM-14: panel decisions, written summaries and shared panel files follow their own retention date.
    const panels = await db.panelRecords.where('retentionUntil').below(today).toArray();
    if (!expired.length && !drafts.length && !planned.length && !panels.length) return 0;
    await db.plannedInterviews.bulkDelete(planned.map((p) => p.id));
    await db.panelRecords.bulkDelete(panels.map((p) => p.id));
    const ids = expired.map((s) => s.id);
    await db.answers.where('sessionId').anyOf(ids).delete();
    await db.sessions.bulkDelete(ids);
    await db.candidateDrafts.bulkDelete(drafts.map((d) => d.planId));
    // TR-3: attachments and AI results follow the record's retention date.
    const attachments = await deleteAttachments(ids);
    const auditRedacted = await redactAuditForSessions([...ids, ...panels.map((p) => p.id)]);
    await appendAudit({
      action: 'retention.purged',
      entity: 'session',
      after: { sessionsDeleted: ids.length, sessionIds: ids, draftsDeleted: drafts.length, ...(planned.length ? { plannedInterviewsDeleted: planned.length } : {}), ...(panels.length ? { panelRecordsDeleted: panels.length } : {}), auditEntriesRedacted: auditRedacted, ...attachmentCounts(attachments) },
    });
    return ids.length;
  });
}

/** TEAM-14: planned interviews for one candidate key. */
async function plannedFor(key: string) {
  return (await db.plannedInterviews.toArray()).filter((p) => candidateKey(p.candidate) === key);
}

/** TEAM-14: panel decisions, written summaries and shared panel files for one candidate key. */
async function panelsFor(key: string) {
  return (await db.panelRecords.toArray()).filter((p) => candidateKey(p.candidate) === key);
}

function attachmentCounts(c: { transcripts: number; recordings: number; aiResults: number }) {
  return c.transcripts || c.recordings || c.aiResults ? { transcriptsDeleted: c.transcripts, recordingsDeleted: c.recordings, aiResultsDeleted: c.aiResults } : {};
}

async function sessionsFor(key: string): Promise<Session[]> {
  return (await db.sessions.toArray()).filter((s) => candidateKey(s.candidate) === key);
}

/** PRIV-6 access request: everything held about one candidate key. Audited without candidate details. */
export async function exportCandidateData(
  initials: string,
  requisitionId: string | null,
): Promise<ExportedFile & { sessionCount: number; /** TR-3: interviews whose recording can be downloaded separately (exportRecording). */ recordingSessionIds: string[] }> {
  const key = candidateKey({ initials, requisitionId });
  return db.transaction('rw', [db.sessions, db.answers, db.plans, db.audit, db.settings, db.candidateDrafts, db.plannedInterviews, db.panelRecords, ...attachmentTables()], async () => {
    const sessions = await sessionsFor(key);
    const plannedInterviews = await plannedFor(key);
    const panels = await panelsFor(key);
    const ids = new Set(sessions.map((s) => s.id));
    for (const p of plannedInterviews) ids.add(p.id);
    for (const p of panels) ids.add(p.id);
    const audit = (await db.audit.toArray()).filter((e) => e.entityId != null && ids.has(e.entityId));
    const drafts = (await draftsFor(key)).map(({ planId, initials, requisitionId, interviewerName, retentionUntil, updatedAt }) => ({
      planId,
      initials,
      requisitionId,
      interviewerName,
      retentionUntil,
      updatedAt,
    }));
    const file: CandidateDataFile = {
      kind: 'candidate-data',
      formatVersion: 1,
      exportedAt: nowIso(),
      candidateKey: key,
      sessions: await Promise.all(
        sessions.map(async (session) => {
          const [transcript, recording, ai] = await Promise.all([db.transcripts.get(session.id), db.recordings.get(session.id), db.aiResults.get(session.id)]);
          return {
            session,
            plan: (await db.plans.get(session.planId)) ?? null,
            answers: await db.answers.where('sessionId').equals(session.id).toArray(),
            // TR-3: the transcript is included; for a recording, whether one is held (it is
            // downloaded separately from Admin, so this file stays text).
            transcript: transcript
              ? { format: transcript.format, attachedAt: transcript.attachedAt, hash: transcript.hash, speakers: [...transcript.transcript.speakers], text: transcript.transcript.text }
              : null,
            recording: recording ? { held: true, name: recording.name, type: recording.type, size: recording.size, attachedAt: recording.attachedAt } : { held: false },
            aiSecondOpinion: ai ? { ...ai.result, speakerMapping: ai.speakerMapping } : null,
          };
        }),
      ),
      audit,
      plannedInterviews,
      panels,
      drafts,
    };
    const requestId = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
    const recordingSessionIds = file.sessions.filter((s) => s.recording?.held).map((s) => s.session.id);
    const transcripts = file.sessions.filter((s) => s.transcript).length;
    await appendAudit({
      action: 'privacy.access_request',
      entity: 'session',
      entityId: null,
      after: { requestId, sessionsFound: sessions.length, ...(plannedInterviews.length ? { plannedInterviews: plannedInterviews.length } : {}), ...(panels.length ? { panelRecords: panels.length } : {}), ...(transcripts ? { transcripts } : {}), ...(recordingSessionIds.length ? { recordingsHeld: recordingSessionIds.length } : {}) },
    });
    return {
      fileName: exportFileName('candidate-data', requestId, 'json'),
      mime: 'application/json',
      text: toJson(file),
      sessionCount: sessions.length,
      recordingSessionIds,
    };
  });
}

/**
 * PRIV-6 deletion request: removes every session, answer, transcript, recording, AI result
 * (TR-3) and draft candidate detail for one candidate key. Plans hold no candidate data and are kept. Audit entries are kept, but the
 * candidate-entered text in amendment entries of the deleted sessions is redacted
 * (redactAuditForSessions).
 */
export async function deleteCandidateData(initials: string, requisitionId: string | null): Promise<number> {
  const key = candidateKey({ initials, requisitionId });
  return db.transaction('rw', [db.sessions, db.answers, db.audit, db.settings, db.candidateDrafts, db.plannedInterviews, db.panelRecords, ...attachmentTables()], async () => {
    // TEAM-14: judgements entered by hand are records like any other, so they go with the sessions.
    const ids = (await sessionsFor(key)).map((s) => s.id);
    const drafts = await draftsFor(key);
    const planned = await plannedFor(key); // TEAM-14
    const panels = await panelsFor(key); // TEAM-14: panel decisions and written summaries
    await db.plannedInterviews.bulkDelete(planned.map((p) => p.id));
    await db.panelRecords.bulkDelete(panels.map((p) => p.id));
    await db.answers.where('sessionId').anyOf(ids).delete();
    await db.sessions.bulkDelete(ids);
    await db.candidateDrafts.bulkDelete(drafts.map((d) => d.planId));
    const attachments = await deleteAttachments(ids); // TR-3
    const auditRedacted = await redactAuditForSessions([...ids, ...panels.map((p) => p.id)]);
    await appendAudit({
      action: 'privacy.deletion_request',
      entity: 'session',
      after: { sessionsDeleted: ids.length, sessionIds: ids, draftsDeleted: drafts.length, ...(planned.length ? { plannedInterviewsDeleted: planned.length } : {}), ...(panels.length ? { panelRecordsDeleted: panels.length } : {}), auditEntriesRedacted: auditRedacted, ...attachmentCounts(attachments) },
    });
    return ids.length;
  });
}

/**
 * PRIV-6 erase all: clears every table on this device, INCLUDING the audit log (the only path
 * that removes audit entries; AUD-1). A single "data.erased" entry is then written so the log
 * shows that an erase happened. The bundled question bank is then reloaded.
 */
export async function eraseAllData(confirmation: 'ERASE'): Promise<void> {
  if (confirmation !== 'ERASE') throw new RepoError('confirmation-required', 'Confirm erasing all data.');
  await db.transaction('rw', allTables(), async () => {
    const actor = await currentActor();
    const counts = { sessions: await db.sessions.count(), plans: await db.plans.count(), auditEntries: await db.audit.count() };
    for (const t of allTables()) await t.clear();
    await appendAudit({ action: 'data.erased', entity: 'device', after: counts, actorFallback: actor });
  });
  await loadSeeds();
}
