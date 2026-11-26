// TR-1…TR-4 and AI-2, AI-3, AI-8, AI-9: transcripts, recordings and the AI second opinion of an
// interview, stored against its session. Screens use these functions and the hooks below; they
// never read the tables directly, so the AI-9 rule (no AI scores before submission) holds in one place.
//
// Audit entries (TR-3, AI-3) record who, when and sizes/counts only: never transcript text, file
// names (they can contain a candidate's name), the AI's scores, rationale or quotations.
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type AiResultRecord, type RecordingRecord, type TranscriptRecord } from './db';
import { RepoError, appendAudit, getSetting, nowIso, setSetting } from './util';
import { DEVICE_SETTINGS } from './settings';
import { buildTranscript } from '../domain/transcript/parse';
import { TranscriptError, type Transcript } from '../domain/transcript/types';
import type { AiSecondOpinion } from '../domain/ai/types';
import type { SpeakerMapping } from '../domain/ai/pseudonymise';
import type { Session } from '../domain/types';

export type { TranscriptRecord, RecordingRecord, AiResultRecord } from './db';

/** TR-2: the app asks before storing a recording larger than this. */
export const RECORDING_WARN_BYTES = 200 * 1024 * 1024;

const T = () => [db.sessions, db.plans, db.transcripts, db.recordings, db.aiResults, db.audit, db.settings];

async function loadSession(sessionId: string): Promise<Session> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new RepoError('not-found', 'Interview not found.');
  return session;
}

/** TR-1, TR-2: attachments belong to this device's own interviews, once they have started. */
function assertAttachable(session: Session): void {
  if (session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only: nothing can be attached to them.');
  if (session.state === 'planned') throw new RepoError('not-started', 'A transcript or recording can be attached once the interview has started.');
}

/** TR-4: nothing is attached unless the candidate was told. */
function assertTold(session: Session): void {
  if (!session.candidate.recordingConsent) {
    throw new RepoError('notice-required', 'First confirm that the candidate has been told the interview is recorded or transcribed.');
  }
}

/** TR-4: whether the candidate was told (at setup or confirmed later). */
export function recordingNoticeGiven(session: Pick<Session, 'candidate'>): boolean {
  return !!session.candidate.recordingConsent;
}

/**
 * TR-4: an interviewer confirms that the candidate has since been told the interview is recorded
 * or transcribed (when the option was off at setup). Stores the time; audited. Does nothing when
 * the candidate was already told.
 */
export async function confirmRecordingNotice(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const session = await loadSession(sessionId);
    assertAttachable(session);
    if (session.candidate.recordingConsent) return;
    const at = nowIso();
    await db.sessions.update(sessionId, { candidate: { ...session.candidate, recordingConsent: { at, source: 'later' } } });
    await appendAudit({ action: 'session.recording_notice_confirmed', entity: 'session', entityId: sessionId, after: { at } });
  });
}

function transcriptFacts(t: Transcript) {
  return {
    format: t.format,
    lines: t.segments.length,
    words: t.wordCount,
    characters: t.text.length,
    speakers: t.speakers.length,
    timestamps: t.segments.some((s) => s.startSec !== undefined),
  };
}

/**
 * TR-1: attaches (or replaces) the interview's transcript. The parsed structure is normalised and
 * its fingerprint recomputed here. Audited without content (TR-3). An AI result based on an
 * earlier transcript is kept and shows as out of date (AI-8).
 */
export async function attachTranscript(sessionId: string, transcript: Transcript): Promise<{ replaced: boolean }> {
  let normalised: Transcript;
  try {
    normalised = buildTranscript(transcript.format, transcript.segments);
  } catch (e) {
    throw new RepoError('invalid', e instanceof TranscriptError ? e.message : 'The transcript could not be read.');
  }
  return db.transaction('rw', T(), async () => {
    const session = await loadSession(sessionId);
    assertAttachable(session);
    assertTold(session);
    const existing = await db.transcripts.get(sessionId);
    const record: TranscriptRecord = { sessionId, transcript: normalised, format: normalised.format, hash: normalised.hash, attachedAt: nowIso() };
    await db.transcripts.put(record);
    await appendAudit({
      action: existing ? 'transcript.replaced' : 'transcript.attached',
      entity: 'session',
      entityId: sessionId,
      before: existing ? transcriptFacts(existing.transcript) : null,
      after: transcriptFacts(normalised),
    });
    return { replaced: !!existing };
  });
}

/** TR-1, TR-3: removes the transcript. Audited without content. */
export async function removeTranscript(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const session = await loadSession(sessionId);
    if (session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only.');
    const existing = await db.transcripts.get(sessionId);
    if (!existing) return;
    await db.transcripts.delete(sessionId);
    await appendAudit({ action: 'transcript.removed', entity: 'session', entityId: sessionId, before: transcriptFacts(existing.transcript) });
  });
}

export interface RecordingInput {
  blob: Blob;
  name: string;
  type: string;
  size: number;
}

export function isMediaType(type: string): boolean {
  return /^(audio|video)\//i.test(type);
}

function isQuotaError(e: unknown): boolean {
  const names = [e, (e as { inner?: unknown })?.inner].map((x) => (x as { name?: string } | undefined)?.name);
  return names.some((n) => n === 'QuotaExceededError') || /quota/i.test(String((e as Error)?.message ?? ''));
}

/**
 * TR-2: attaches (or replaces) a recording for playback. Stored on this device only, never sent
 * anywhere and never transcribed. Audited with its type and size only (TR-3): a file name can
 * contain the candidate's name. Throws RepoError 'quota' when the device has no room for it.
 */
export async function attachRecording(sessionId: string, input: RecordingInput): Promise<{ replaced: boolean }> {
  const type = input.type || input.blob.type;
  if (!isMediaType(type)) throw new RepoError('invalid', 'Choose an audio or video file.');
  if (!(input.size > 0)) throw new RepoError('invalid', 'The file is empty.');
  try {
    return await db.transaction('rw', T(), async () => {
      const session = await loadSession(sessionId);
      assertAttachable(session);
      assertTold(session);
      const existing = await db.recordings.get(sessionId);
      const record: RecordingRecord = { sessionId, blob: input.blob, name: input.name.slice(0, 255), type, size: input.size, attachedAt: nowIso() };
      await db.recordings.put(record);
      await appendAudit({
        action: existing ? 'recording.replaced' : 'recording.attached',
        entity: 'session',
        entityId: sessionId,
        before: existing ? { type: existing.type, size: existing.size } : null,
        after: { type, size: input.size },
      });
      return { replaced: !!existing };
    });
  } catch (e) {
    if (e instanceof RepoError) throw e;
    if (isQuotaError(e)) {
      throw new RepoError('quota', 'There is not enough storage space for this recording on this device. Nothing was stored. Free some space, or attach a smaller file.');
    }
    throw new RepoError('failed', 'The recording could not be stored. Nothing was changed.');
  }
}

/** TR-2, TR-3: removes the recording. Audited. */
export async function removeRecording(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const session = await loadSession(sessionId);
    if (session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only.');
    const existing = await db.recordings.get(sessionId);
    if (!existing) return;
    await db.recordings.delete(sessionId);
    await appendAudit({ action: 'recording.removed', entity: 'session', entityId: sessionId, before: { type: existing.type, size: existing.size } });
  });
}

/**
 * TR-3, PRIV-6: the recording of one interview, for the access request's separate download.
 * Audited as an export (FLOW-32).
 */
export async function exportRecording(sessionId: string): Promise<{ blob: Blob; fileName: string }> {
  return db.transaction('rw', T(), async () => {
    const rec = await db.recordings.get(sessionId);
    if (!rec) throw new RepoError('not-found', 'No recording is held for this interview.');
    const ext = /\.([a-z0-9]{1,5})$/i.exec(rec.name)?.[1] ?? (rec.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    await appendAudit({ action: 'export', entity: 'session', entityId: sessionId, after: { format: 'recording', type: rec.type, size: rec.size } });
    // A random-id file name (PRIV-3): the original name can contain the candidate's name.
    return { blob: rec.blob, fileName: `interview-recording-${sessionId.slice(0, 8)}.${ext.toLowerCase()}` };
  });
}

// ------------------------------------------------------------------------------------------------
// AI second opinion

export interface AiSettings {
  /** AI-2: off until turned on for this device in Admin. */
  enabled: boolean;
  /** When the privacy notice was acknowledged (the last time it was turned on). */
  acknowledgedAt: string | null;
}

function readAiSettings(v: unknown): AiSettings {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { enabled: o.enabled === true, acknowledgedAt: typeof o.acknowledgedAt === 'string' ? o.acknowledgedAt : null };
}

export async function getAiSettings(): Promise<AiSettings> {
  return readAiSettings(await getSetting(DEVICE_SETTINGS.aiSecondOpinion));
}

/** AI-2: turning it on requires acknowledging the privacy notice. Audited. */
export async function setAiEnabled(enabled: boolean, opts: { noticeAcknowledged?: boolean } = {}): Promise<void> {
  if (enabled && opts.noticeAcknowledged !== true) throw new RepoError('notice-required', 'Read and acknowledge the privacy notice to turn the AI second opinion on.');
  await db.transaction('rw', [db.settings, db.audit], async () => {
    const current = await getAiSettings();
    if (current.enabled === enabled) return;
    const next: AiSettings = { enabled, acknowledgedAt: enabled ? nowIso() : current.acknowledgedAt };
    await setSetting(DEVICE_SETTINGS.aiSecondOpinion, next);
    await appendAudit({ action: enabled ? 'ai.enabled' : 'ai.disabled', entity: 'device', after: enabled ? { noticeAcknowledgedAt: next.acknowledgedAt } : null });
  });
}

/**
 * AI-3, AI-6, AI-8: stores the AI second opinion of an interview (replacing any earlier one).
 * `result` comes from createSecondOpinion, so it has been validated. It is refused when the
 * feature is off, the transcript has changed since the run, or the result does not match the plan.
 * Audited with who, when, the model and the number of questions; never the content.
 *
 * AI-10: this writes only the aiResults table. Nothing here (or anywhere) copies an AI value into
 * an answer, the overall assessment or the recommendation.
 */
export async function saveAiResult(sessionId: string, result: AiSecondOpinion, speakerMapping: SpeakerMapping, extraNameCount = 0): Promise<void> {
  await db.transaction('rw', T(), async () => {
    if (!(await getAiSettings()).enabled) throw new RepoError('ai-off', 'The AI second opinion is turned off on this device (Admin › AI second opinion).');
    const session = await loadSession(sessionId);
    assertAttachable(session);
    const plan = await db.plans.get(session.planId);
    if (!plan) throw new RepoError('not-found', 'The plan for this interview is missing.');
    const transcript = await db.transcripts.get(sessionId);
    if (!transcript || transcript.hash !== result.transcriptHash) {
      throw new RepoError('transcript-changed', 'The transcript changed while the AI second opinion was running, so the result was not kept. Run it again.');
    }
    if (result.kind !== 'ai-second-opinion' || (plan.fingerprint ?? null) !== result.planFingerprint) throw new RepoError('invalid', 'The AI result does not belong to this interview’s plan.');
    const ids = plan.questions.map((q) => q.id);
    if (result.questions.length !== ids.length || result.questions.some((q, i) => q.questionId !== ids[i])) {
      throw new RepoError('invalid', 'The AI result does not cover this interview’s questions.');
    }
    const mapping: SpeakerMapping = {};
    for (const sp of transcript.transcript.speakers) if (typeof speakerMapping[sp] === 'string') mapping[sp] = speakerMapping[sp];
    const existing = await db.aiResults.get(sessionId);
    const record: AiResultRecord = { sessionId, result: structuredClone(result), speakerMapping: mapping, extraNameCount: Math.max(0, Math.floor(extraNameCount)) };
    await db.aiResults.put(record);
    await appendAudit({
      action: 'ai.run',
      entity: 'session',
      entityId: sessionId,
      after: {
        model: result.model,
        questions: result.questions.length,
        notCovered: result.questions.filter((q) => !q.covered).length,
        unverifiedQuotations: result.unverifiedQuoteCount,
        durationMs: result.durationMs,
        replaced: !!existing,
        sessionState: session.state,
      },
    });
  });
}

/**
 * AI-3, AI-6: records a run that produced nothing to keep (the helper failed, or its reply was
 * rejected). Only the error code and the number of questions are logged.
 */
export async function recordAiRunFailed(sessionId: string, code: string, questions: number): Promise<void> {
  await db.transaction('rw', [db.audit, db.settings], async () => {
    await appendAudit({ action: 'ai.run_failed', entity: 'session', entityId: sessionId, after: { code: code.slice(0, 40), questions } });
  });
}

/**
 * AI-9: what the screens may know about an interview's AI second opinion.
 * - `none`: there is none (always for an imported panelist session: FLOW-27);
 * - `pending`: there is one, but the interview is not submitted: only that it is ready, when and
 *   by which model; never the scores;
 * - `ready`: the interview is submitted: the full result, with `outOfDate` (AI-8).
 */
export type AiView =
  | { state: 'none' }
  | { state: 'pending'; model: string; createdAt: string }
  | { state: 'ready'; record: AiResultRecord; outOfDate: boolean; currentTranscriptHash: string | null };

export async function getAiView(sessionId: string): Promise<AiView> {
  const session = await db.sessions.get(sessionId);
  if (!session || session.origin !== 'local') return { state: 'none' };
  const record = await db.aiResults.get(sessionId);
  if (!record) return { state: 'none' };
  if (session.state !== 'submitted') return { state: 'pending', model: record.result.model, createdAt: record.result.createdAt };
  const transcript = await db.transcripts.get(sessionId);
  const currentTranscriptHash = transcript?.hash ?? null;
  return { state: 'ready', record, outOfDate: currentTranscriptHash !== record.result.transcriptHash, currentTranscriptHash };
}

/** TR-1: the transcript of one of this device's interviews (null for imported sessions). */
export async function getTranscript(sessionId: string): Promise<TranscriptRecord | null> {
  const session = await db.sessions.get(sessionId);
  if (!session || session.origin !== 'local') return null;
  return (await db.transcripts.get(sessionId)) ?? null;
}

/** TR-2: the recording of one of this device's interviews (null for imported sessions). */
export async function getRecording(sessionId: string): Promise<RecordingRecord | null> {
  const session = await db.sessions.get(sessionId);
  if (!session || session.origin !== 'local') return null;
  return (await db.recordings.get(sessionId)) ?? null;
}

/** TR-3, PRIV-6: recordings held for a set of sessions (for the access request's separate download). */
export async function recordingsFor(sessionIds: readonly string[]): Promise<Array<Pick<RecordingRecord, 'sessionId' | 'type' | 'size' | 'attachedAt'>>> {
  if (!sessionIds.length) return [];
  const recs = await db.recordings.where('sessionId').anyOf([...sessionIds]).toArray();
  return recs.map(({ sessionId, type, size, attachedAt }) => ({ sessionId, type, size, attachedAt }));
}

// ------------------------------------------------------------------------------------------------
// Hooks (undefined while loading)

export function useTranscript(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? getTranscript(sessionId) : Promise.resolve(null)), [sessionId]);
}

export function useRecording(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? getRecording(sessionId) : Promise.resolve(null)), [sessionId]);
}

/** AI-9: the AI second opinion as the screens may see it. */
export function useAiSecondOpinion(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? getAiView(sessionId) : Promise.resolve<AiView>({ state: 'none' })), [sessionId]);
}

export function useAiSettings() {
  return useLiveQuery(() => getAiSettings(), []);
}

/** TR-3, PRIV-6: recordings held for these sessions (no blobs). */
export function useRecordingsFor(sessionIds: readonly string[]) {
  return useLiveQuery(() => recordingsFor(sessionIds), [sessionIds.join(',')]);
}
