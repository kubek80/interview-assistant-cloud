// TR-1…TR-4, AI-2, AI-3, AI-6, AI-8…AI-11: transcripts, recordings and the AI second opinion in the
// local database (fake IndexedDB). Screens use only these repository functions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachRecording,
  attachTranscript,
  confirmRecordingNotice,
  createSessionFromPlan,
  db,
  deleteCandidateData,
  eraseAllData,
  exportCandidateData,
  exportRecording,
  exportScorecard,
  exportSessionFile,
  getAiView,
  getRecordingNoticeDefault,
  getTranscript,
  importSessionFile,
  loadPanel,
  loadSeeds,
  lockPlan,
  createPlan,
  purgeExpired,
  queryAudit,
  recordAiRunFailed,
  removeRecording,
  removeTranscript,
  saveAiResult,
  setAiEnabled,
  setOverall,
  setScore,
  confirmConsent,
  startSession,
  submitSession,
  updatePlanDraft,
  addNote,
  type NewSessionInput,
} from './index';
import { clock } from './util';
import { makeTrackFile } from '../test/fixtures';
import { parseTranscriptText, type Transcript } from '../domain/transcript';
import { createSecondOpinion, pseudonymiseTranscript, suggestSpeakerMapping, type AiSecondOpinion } from '../domain/ai';
import { RECORDING_CONSENT_TEXT } from '../domain/plan';
import type { Session } from '../domain/types';
import { readFileSync } from 'node:fs';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;
const QIDS = ['tt-1', 'tt-2', 'tt-3'];

const TRANSCRIPT_TEXT = [
  '[00:00:03] Priya Natarajan: Thanks for joining, Sam. How do you decide what to automate first?',
  '[00:00:13] Sam Carter: I start from risk and map the critical user journeys first.',
  '[00:01:00] Priya Natarajan: Tell me about flaky tests.',
  '[00:01:10] Sam Carter: I quarantine the flaky test and fix the wait condition properly.',
  '[00:02:00] Priya Natarajan: And how do you report progress?',
  '[00:02:10] Sam Carter: A weekly dashboard of escaped defects and cycle time.',
].join('\n');

const details = (p: Partial<NewSessionInput> = {}): NewSessionInput => ({
  initials: 'sc',
  requisitionId: 'REQ-9',
  interviewerName: 'Ana Interviewer',
  otherInterviewers: [],
  retentionUntil: '2027-02-22',
  ...p,
});

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => now;
  await db.delete();
  await db.open();
  await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
});

afterEach(() => {
  clock.now = realNow;
});

async function newSession(input = details()) {
  const planId = await createPlan('tt');
  await updatePlanDraft(planId, { questionIds: QIDS });
  const { sessionId } = await lockPlan(planId, input);
  return { planId, sessionId };
}

async function submit(sessionId: string) {
  for (const q of QIDS) await setScore(sessionId, q, 3);
  await setScore(sessionId, 'tt-2', 1);
  await addNote(sessionId, 'tt-2', 'NOTE-TEXT-7781 the candidate struggled');
  await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'RATIONALE-TEXT-4410' });
  await submitSession(sessionId);
}

const transcript = (text = TRANSCRIPT_TEXT): Transcript => parseTranscriptText(text);

/** A validated AI result, built the way the screens build it (pseudonymise → helper reply → createSecondOpinion). */
async function aiResult(sessionId: string, scores: Array<1 | 2 | 3 | 4 | null> = [3, 4, null]): Promise<{ result: AiSecondOpinion; mapping: Record<string, string> }> {
  const session = (await db.sessions.get(sessionId))!;
  const plan = (await db.plans.get(session.planId))!;
  const t = (await getTranscript(sessionId))!.transcript;
  const mapping = suggestSpeakerMapping(t);
  const sent = pseudonymiseTranscript(t, mapping);
  const output = {
    questions: plan.questions.map((q, i) => ({
      questionId: q.id,
      covered: scores[i] != null,
      score: scores[i],
      keyPointsCovered: scores[i] != null ? [1] : [],
      redFlagsObserved: [],
      rationale: scores[i] != null ? `AI-RATIONALE-${i + 1}` : 'Not discussed.',
      quotes: scores[i] != null ? ['I start from risk', 'Thanks for joining'] : [],
    })),
  };
  const r = createSecondOpinion({ plan, sentTranscript: sent, response: { model: 'fake-model-1', output, durationMs: 1234 } });
  if (!r.ok) throw new Error(r.errors.join(' '));
  return { result: r.result, mapping };
}

describe('TR-4: recording and transcription consent', () => {
  it('TR-4 PRIV-4 DATA-6: the option chosen at setup is confirmed with the consent on the ready screen, with its time, and remembered per device; off by default', async () => {
    expect(await getRecordingNoticeDefault()).toBe(false);
    const off = await newSession();
    await confirmConsent(off.sessionId);
    expect((await db.sessions.get(off.sessionId))!.candidate.recordingConsent).toBeUndefined();
    const on = await newSession(details({ initials: 'on', recordingNotice: true }));
    expect((await db.sessions.get(on.sessionId))!.candidate).toMatchObject({ recordingNotice: true, consentAt: null });
    expect((await db.sessions.get(on.sessionId))!.candidate.recordingConsent).toBeUndefined();
    expect(await getRecordingNoticeDefault()).toBe(true);
    await confirmConsent(on.sessionId);
    const s = (await db.sessions.get(on.sessionId))!;
    expect(s.candidate.recordingConsent).toEqual({ at: s.candidate.consentAt, source: 'setup' });
    // A new interview with the same questions takes it too.
    const again = await createSessionFromPlan(on.planId, details({ initials: 'ag', recordingNotice: false }));
    await confirmConsent(again);
    expect((await db.sessions.get(again))!.candidate.recordingConsent).toBeUndefined();
    expect(await getRecordingNoticeDefault()).toBe(false);
  });

  it('TR-4: the consent sentence is the docs’ sentence, verbatim', () => {
    const doc = readFileSync(new URL('../../docs/11-interviewers-transcripts-ai.md', import.meta.url), 'utf8');
    expect(doc).toContain(`> ${RECORDING_CONSENT_TEXT}`);
  });

  it('TR-4 TR-1 TR-2: when the option was off, nothing is attached until an interviewer confirms the candidate has since been told; the time is stored and audited', async () => {
    const { sessionId } = await newSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await expect(attachTranscript(sessionId, transcript())).rejects.toMatchObject({ code: 'notice-required' });
    await expect(attachRecording(sessionId, { blob: new Blob(['x'], { type: 'audio/mpeg' }), name: 'a.mp3', type: 'audio/mpeg', size: 1 })).rejects.toMatchObject({ code: 'notice-required' });
    now += 60_000;
    await confirmRecordingNotice(sessionId);
    const s = (await db.sessions.get(sessionId))!;
    expect(s.candidate.recordingConsent).toEqual({ at: new Date(now).toISOString(), source: 'later' });
    const [entry] = await queryAudit({ actions: ['session.recording_notice_confirmed'] });
    expect(entry).toMatchObject({ entityId: sessionId, actor: 'Ana Interviewer' });
    await attachTranscript(sessionId, transcript());
    expect(await getTranscript(sessionId)).not.toBeNull();
  });
});

describe('TR-1, TR-2, TR-3: attachments', () => {
  it('TR-1: a transcript is attached once the interview has started (also after submission), replaced and removed; audited without content', async () => {
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await expect(attachTranscript(sessionId, transcript())).rejects.toMatchObject({ code: 'not-started' });
    await confirmConsent(sessionId);
    await startSession(sessionId);
    expect(await attachTranscript(sessionId, transcript())).toEqual({ replaced: false });
    const rec = (await getTranscript(sessionId))!;
    expect(rec.format).toBe('text');
    expect(rec.transcript.speakers).toEqual(['Priya Natarajan', 'Sam Carter']);
    expect(rec.transcript.segments[0]).toMatchObject({ speaker: 'Priya Natarajan', startSec: 3 });
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    await submit(sessionId);
    expect(await attachTranscript(sessionId, transcript(TRANSCRIPT_TEXT + '\n[00:03:00] Sam Carter: One more thing.'))).toEqual({ replaced: true });
    await removeTranscript(sessionId);
    expect(await getTranscript(sessionId)).toBeNull();
    const log = await queryAudit({ actions: ['transcript.attached', 'transcript.replaced', 'transcript.removed'] });
    expect(log.map((e) => e.action).reverse()).toEqual(['transcript.attached', 'transcript.replaced', 'transcript.removed']);
    expect(log[2].after).toMatchObject({ format: 'text', lines: 6, speakers: 2 });
    const text = JSON.stringify(log);
    for (const s of ['Priya', 'Sam Carter', 'critical user journeys', 'flaky']) expect(text).not.toContain(s);
  });

  it('TR-2: a recording (audio or video only) is stored on this device, replaced and removed; audited with type and size, never the file name', async () => {
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await expect(attachRecording(sessionId, { blob: new Blob(['x']), name: 'notes.pdf', type: 'application/pdf', size: 1 })).rejects.toMatchObject({ code: 'invalid' });
    const blob = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
    await attachRecording(sessionId, { blob, name: 'Sam Carter interview.webm', type: 'audio/webm', size: blob.size });
    const stored = (await db.recordings.get(sessionId))!;
    expect(stored).toMatchObject({ name: 'Sam Carter interview.webm', type: 'audio/webm', size: 2048 });
    expect((await stored.blob.arrayBuffer()).byteLength).toBe(2048);
    await attachRecording(sessionId, { blob: new Blob(['v'], { type: 'video/mp4' }), name: 'v.mp4', type: 'video/mp4', size: 1 });
    const out = await exportRecording(sessionId);
    expect(out.fileName).toMatch(/^interview-recording-[0-9a-f]{8}\.mp4$/);
    await removeRecording(sessionId);
    expect(await db.recordings.get(sessionId)).toBeUndefined();
    const log = await queryAudit({ actions: ['recording.attached', 'recording.replaced', 'recording.removed', 'export'] });
    expect(log.map((e) => e.action).reverse()).toEqual(['recording.attached', 'recording.replaced', 'export', 'recording.removed']);
    expect(JSON.stringify(log)).not.toContain('Sam Carter');
    expect(log[3].after).toEqual({ type: 'audio/webm', size: 2048 });
  });

  it('TR-2: a storage quota error stores nothing and says so', async () => {
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    const put = db.recordings.put.bind(db.recordings);
    db.recordings.put = (() => Promise.reject(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }))) as unknown as typeof db.recordings.put;
    try {
      await expect(attachRecording(sessionId, { blob: new Blob(['x'], { type: 'audio/mpeg' }), name: 'a.mp3', type: 'audio/mpeg', size: 1 })).rejects.toMatchObject({
        code: 'quota',
        message: expect.stringMatching(/not enough storage space/),
      });
    } finally {
      db.recordings.put = put;
    }
    expect(await db.recordings.count()).toBe(0);
    expect(await queryAudit({ actions: ['recording.attached'] })).toHaveLength(0);
  });

  it('TR-3: the retention purge, a deletion request and erase-all remove transcripts, recordings and AI results', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const make = async (initials: string, retentionUntil: string) => {
      const { sessionId } = await newSession(details({ initials, retentionUntil, recordingNotice: true }));
      await confirmConsent(sessionId);
      await startSession(sessionId);
      await attachTranscript(sessionId, transcript());
      await attachRecording(sessionId, { blob: new Blob(['x'], { type: 'audio/mpeg' }), name: 'a.mp3', type: 'audio/mpeg', size: 1 });
      const { result, mapping } = await aiResult(sessionId);
      await saveAiResult(sessionId, result, mapping);
      return sessionId;
    };
    const old = await make('ol', '2026-11-30');
    const del = await make('de', '2027-02-22');
    const keep = await make('ke', '2027-02-22');
    now = Date.UTC(2026, 11, 1, 9);
    expect(await purgeExpired('2026-12-01')).toBe(1);
    for (const t of [db.transcripts, db.recordings, db.aiResults]) expect(await t.get(old)).toBeUndefined();
    const [purge] = await queryAudit({ actions: ['retention.purged'] });
    expect(purge.after).toMatchObject({ transcriptsDeleted: 1, recordingsDeleted: 1, aiResultsDeleted: 1 });
    expect(await deleteCandidateData('DE', 'REQ-9')).toBe(1);
    for (const t of [db.transcripts, db.recordings, db.aiResults]) expect(await t.get(del)).toBeUndefined();
    for (const t of [db.transcripts, db.recordings, db.aiResults]) expect(await t.get(keep)).toBeDefined();
    await eraseAllData('ERASE');
    for (const t of [db.transcripts, db.recordings, db.aiResults]) expect(await t.count()).toBe(0);
  });

  it('TR-3 PRIV-6: an access request includes the transcript and says whether a recording is held; the recording is offered separately', async () => {
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    let f = await exportCandidateData('SC', 'REQ-9');
    let file = JSON.parse(f.text);
    expect(file.sessions[0].transcript.text).toContain('critical user journeys');
    expect(file.sessions[0].recording).toEqual({ held: false });
    expect(f.recordingSessionIds).toEqual([]);
    await attachRecording(sessionId, { blob: new Blob(['x'], { type: 'audio/mpeg' }), name: 'a.mp3', type: 'audio/mpeg', size: 1 });
    f = await exportCandidateData('SC', 'REQ-9');
    file = JSON.parse(f.text);
    expect(file.sessions[0].recording).toMatchObject({ held: true, type: 'audio/mpeg', size: 1 });
    expect(f.recordingSessionIds).toEqual([sessionId]);
    const [audit] = await queryAudit({ actions: ['privacy.access_request'] });
    expect(audit.after).toMatchObject({ transcripts: 1, recordingsHeld: 1 });
  });

  it('TR-3 AI-9 FLOW-26: session files for the panel carry no transcript, recording or AI result; an import never brings one', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    await attachRecording(sessionId, { blob: new Blob(['x'], { type: 'audio/mpeg' }), name: 'a.mp3', type: 'audio/mpeg', size: 1 });
    const { result, mapping } = await aiResult(sessionId);
    await saveAiResult(sessionId, result, mapping);
    await submit(sessionId);
    const f = await exportSessionFile(sessionId);
    for (const s of ['critical user journeys', 'Priya', 'fake-model-1', 'AI-RATIONALE', '"transcript', '"recording"', 'blob', 'aiResult', 'secondOpinion']) expect(f.text).not.toContain(s);
    // Only the TR-4 consent record (a flag and a time) travels with the session.
    expect(JSON.parse(f.text).session.candidate.recordingConsent).toMatchObject({ source: 'setup' });
    // The same session imported on another device (here: after deleting it) holds nothing attached.
    await deleteCandidateData('SC', 'REQ-9');
    const json = JSON.parse(f.text);
    await importSessionFile(json);
    expect(await getTranscript(sessionId)).toBeNull();
    expect(await getAiView(sessionId)).toEqual({ state: 'none' });
    await expect(attachTranscript(sessionId, transcript())).rejects.toMatchObject({ code: 'read-only' });
  });
});

describe('AI second opinion in the data layer', () => {
  it('AI-2: off by default; turning it on needs the notice acknowledged; both are audited; a result cannot be stored while it is off', async () => {
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    const { result, mapping } = await aiResult(sessionId);
    await expect(saveAiResult(sessionId, result, mapping)).rejects.toMatchObject({ code: 'ai-off' });
    await expect(setAiEnabled(true)).rejects.toMatchObject({ code: 'notice-required' });
    await setAiEnabled(true, { noticeAcknowledged: true });
    await saveAiResult(sessionId, result, mapping);
    await setAiEnabled(false);
    expect((await queryAudit({ actions: ['ai.enabled', 'ai.disabled'] })).map((e) => e.action)).toEqual(['ai.disabled', 'ai.enabled']);
  });

  it('AI-9: before submission the read path says only that it is ready, when and by which model; never the scores', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    expect(await getAiView(sessionId)).toEqual({ state: 'none' });
    const { result, mapping } = await aiResult(sessionId);
    await saveAiResult(sessionId, result, mapping);
    const pending = await getAiView(sessionId);
    expect(pending).toEqual({ state: 'pending', model: 'fake-model-1', createdAt: result.createdAt });
    expect(JSON.stringify(pending)).not.toMatch(/score|AI-RATIONALE|questions/);
    await submit(sessionId);
    const ready = await getAiView(sessionId);
    expect(ready.state).toBe('ready');
    if (ready.state === 'ready') {
      expect(ready.record.result.questions.map((q) => q.score)).toEqual([3, 4, null]);
      expect(ready.outOfDate).toBe(false);
    }
  });

  it('AI-3 AI-6 AI-8: each run is audited (who, when, model, number of questions; no content); a failed run stores nothing; a changed transcript marks the result out of date or rejects a stale save', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    await recordAiRunFailed(sessionId, 'invalid_output', 3);
    expect(await db.aiResults.count()).toBe(0);
    const { result, mapping } = await aiResult(sessionId);
    await saveAiResult(sessionId, result, { ...mapping, 'Not a speaker': 'Candidate' }, 1);
    const stored = (await db.aiResults.get(sessionId))!;
    expect(stored.speakerMapping).toEqual({ 'Priya Natarajan': 'Interviewer 1', 'Sam Carter': 'Candidate' });
    expect(stored.result).toMatchObject({ model: 'fake-model-1', transcriptHash: (await getTranscript(sessionId))!.hash });
    const log = await queryAudit({ actions: ['ai.run', 'ai.run_failed'] });
    expect(log.map((e) => e.action)).toEqual(['ai.run', 'ai.run_failed']);
    expect(log[0]).toMatchObject({ actor: 'Ana Interviewer', entityId: sessionId, after: { model: 'fake-model-1', questions: 3, notCovered: 1, sessionState: 'in_progress' } });
    expect(log[1].after).toEqual({ code: 'invalid_output', questions: 3 });
    for (const s of ['AI-RATIONALE', 'I start from risk', 'Priya', 'Sam']) expect(JSON.stringify(log)).not.toContain(s);

    // AI-8: a changed transcript marks the stored result out of date (after submission it is visible).
    await attachTranscript(sessionId, transcript(TRANSCRIPT_TEXT + '\n[00:04:00] Sam Carter: Added later.'));
    await submit(sessionId);
    const view = await getAiView(sessionId);
    expect(view.state === 'ready' && view.outOfDate).toBe(true);
    // A result computed against the old transcript can no longer be saved.
    await expect(saveAiResult(sessionId, result, mapping)).rejects.toMatchObject({ code: 'transcript-changed' });
  });

  it('AI-10 OV-4: storing a result changes no answer, overall assessment or recommendation; the debrief median and spread ignore it (AI-11: its own column)', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    await submit(sessionId);
    const answersBefore = await db.answers.where('sessionId').equals(sessionId).toArray();
    const sessionBefore: Session = (await db.sessions.get(sessionId))!;
    const panelBefore = (await loadPanel(sessionId))!;
    expect(panelBefore.ai).toEqual([]);
    const { result, mapping } = await aiResult(sessionId, [1, 1, 1]);
    await saveAiResult(sessionId, result, mapping);
    expect(await db.answers.where('sessionId').equals(sessionId).toArray()).toEqual(answersBefore);
    const sessionAfter = (await db.sessions.get(sessionId))!;
    expect(sessionAfter.overall).toEqual(sessionBefore.overall);
    expect(sessionAfter).toEqual(sessionBefore);
    const panelAfter = (await loadPanel(sessionId))!;
    expect(panelAfter.panel).toEqual(panelBefore.panel);
    expect(panelAfter.panel.members).toHaveLength(1);
    expect(panelAfter.ai).toHaveLength(1);
    expect(panelAfter.ai[0].scorecard.overallPct).toBe(0);
    expect(panelAfter.panel.median).not.toBe(0);
  });

  it('AI-11 AI-9: scorecard exports include the AI second opinion under its label only after submission; CSV columns are prefixed', async () => {
    await setAiEnabled(true, { noticeAcknowledged: true });
    const { sessionId } = await newSession(details({ recordingNotice: true }));
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await attachTranscript(sessionId, transcript());
    const { result, mapping } = await aiResult(sessionId, [3, 3, null]);
    await saveAiResult(sessionId, result, mapping);
    let md = await exportScorecard(sessionId, 'markdown');
    expect(md.text).not.toContain('AI second opinion');
    await submit(sessionId);
    md = await exportScorecard(sessionId, 'markdown');
    expect(md.text).toContain('## AI second opinion (fake-model-1), not a decision');
    expect(md.text).toContain('Worth discussing');
    expect(md.text).toMatch(/\| 2 \(worth discussing\) \| .* \| 1 \| 3 \| \+2 \|/);
    expect(md.text).toContain('Not covered');
    expect(md.text).toContain('"I start from risk" \\(line 2, Candidate, verified\\)');
    expect(md.text).toContain('Interviewer 1, verified, not the candidate’s words');
    const csv = await exportScorecard(sessionId, 'csv');
    const header = csv.text.split('\r\n')[0];
    expect(header).toContain('AI second opinion: score');
    expect(header.split(',').filter((h) => /score/i.test(h) && !/^AI second opinion/.test(h))).toEqual(['Score']);
  });
});
