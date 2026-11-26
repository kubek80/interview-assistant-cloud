import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeScorecard } from '../scoring';
import { parseTranscriptText } from '../transcript';
import { makeQuestion, scored, skipped, workedExamplePlan } from '../../test/fixtures';
import type { Question, TrackFile } from '../types';
import {
  AI_DISCUSS_DIFFERENCE,
  AI_LIMITS,
  AiRequestError,
  buildQuoteIndex,
  buildSecondOpinionRequest,
  checkSpeakerMapping,
  compareWithAi,
  computeAiScorecard,
  createSecondOpinion,
  describePayload,
  isOutOfDate,
  nameVariants,
  normaliseForMatch,
  pseudonymiseTranscript,
  suggestSpeakerMapping,
  validateSecondOpinionOutput,
  verifyQuotation,
  type AiModelOutput,
  type AiModelQuestionOutput,
  type AiSecondOpinion,
} from './index';

const TRANSCRIPT = [
  'Priya Natarajan: Thanks for coming in, Sam. How do you decide what to automate first?',
  "Sam O'Neill: I start from risk. Priya asked me this at my last place too, funnily enough.",
  "Sam O'Neill: I map the critical journeys - checkout, login, payments - and automate those first, because they break most often and cost the most.",
  'Will Turner: Will you say more about flaky tests? I will take notes.',
  "Sam O'Neill: Sure. I quarantine a flaky test, fix the wait, and track the flake rate weekly.",
].join('\n');

const transcript = () => parseTranscriptText(TRANSCRIPT);
const mapping = { 'Priya Natarajan': 'Interviewer 1', "Sam O'Neill": 'Candidate', 'Will Turner': 'Interviewer 2' };

describe('AI-5 speaker pseudonymisation', () => {
  it('AI-5: suggests the speaker with the most words as the candidate (a suggestion only)', () => {
    expect(suggestSpeakerMapping(transcript())).toEqual(mapping);
  });

  it('AI-5: replaces speaker labels and names in the spoken text, whole-word and case-insensitive', () => {
    const p = pseudonymiseTranscript(transcript(), mapping);
    expect(p.speakers).toEqual(['Interviewer 1', 'Candidate', 'Interviewer 2']);
    expect(p.text).not.toMatch(/Priya|Natarajan|O'Neill|\bSam\b|Turner/i);
    const lines = p.text.split('\n');
    expect(lines[0]).toBe('Interviewer 1: Thanks for coming in, Candidate. How do you decide what to automate first?');
    expect(lines[1]).toBe('Candidate: I start from risk. Interviewer 1 asked me this at my last place too, funnily enough.');
    expect(p.replacedNameCount).toBeGreaterThanOrEqual(3);
  });

  it('AI-5: a name part that is a common word ("Will") is replaced only when capitalised', () => {
    const line = pseudonymiseTranscript(transcript(), mapping).text.split('\n')[3];
    expect(line).toBe('Interviewer 2: Interviewer 2 you say more about flaky tests? I will take notes.');
  });

  it('AI-5: keeps one line per segment so line numbers stay stable', () => {
    const t = transcript();
    const p = pseudonymiseTranscript(t, mapping);
    expect(p.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5]);
    expect(p.text.split('\n')).toHaveLength(t.segments.length);
    expect(p.sourceHash).toBe(t.hash);
  });

  it('AI-5: handles "Last, First" names, decorations and extra names', () => {
    expect(nameVariants('Natarajan, Priya (Guest)')).toEqual({ phrases: ['Natarajan Priya', 'Priya Natarajan'], parts: ['Natarajan', 'Priya'] });
    const t = parseTranscriptText('Guest: hello, I am Jo Bloggs.\nHost: welcome Jo.');
    const p = pseudonymiseTranscript(t, { Guest: 'Candidate', Host: 'Interviewer 1' }, [{ name: 'Jo Bloggs', label: 'Candidate' }]);
    expect(p.text).toBe('Candidate: hello, I am Candidate.\nInterviewer 1: welcome Candidate.');
  });

  it('AI-5: rejects incomplete or invalid mappings', () => {
    const t = transcript();
    expect(checkSpeakerMapping(t, { 'Priya Natarajan': 'Interviewer 1' }).map((p) => p.code)).toEqual(['unmapped-speaker', 'unmapped-speaker', 'no-candidate']);
    expect(checkSpeakerMapping(t, { ...mapping, 'Priya Natarajan': 'Priya' }).map((p) => p.code)).toEqual(['invalid-label']);
    expect(() => pseudonymiseTranscript(t, { ...mapping, "Sam O'Neill": 'Interviewer 3' })).toThrow(/candidate/);
    expect(checkSpeakerMapping(t, mapping)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const qaQuestions = (): Question[] => [
  makeQuestion({
    id: 'qa-1',
    text: 'How do you decide what to automate first?',
    description: 'Risk-based prioritisation of automation.',
    lookFor: ['Risk-based', 'Critical journeys', 'Cost of failure'],
    redFlags: ['Automate everything'],
    probes: ['What would you not automate?'],
    rubricOverride: { '4': 'Prioritises by risk with data on failure cost.' },
  }),
  makeQuestion({ id: 'qa-2', text: 'Tell me about flaky tests.', lookFor: ['Quarantine', 'Root cause', 'Metrics'], redFlags: ['Retry until green'], probes: [] }),
  makeQuestion({ id: 'qa-3', text: 'How do you test a payments API?', lookFor: ['Contract tests', 'Idempotency'], redFlags: [], probes: [] }),
];

const sent = () => pseudonymiseTranscript(transcript(), mapping);

describe('AI-5 / AI-3 request building and disclosure', () => {
  it('AI-5: sends question text, description, key points, red flags, probes and the resolved rubric', () => {
    const req = buildSecondOpinionRequest({ questions: qaQuestions(), transcript: sent() });
    expect(req.version).toBe(1);
    expect(req.questions[0]).toEqual({
      id: 'qa-1',
      text: 'How do you decide what to automate first?',
      description: 'Risk-based prioritisation of automation.',
      keyPoints: ['Risk-based', 'Critical journeys', 'Cost of failure'],
      redFlags: ['Automate everything'],
      probes: ['What would you not automate?'],
      rubric: [
        { score: 1, label: 'Poor', description: expect.stringMatching(/^Any red flag/) },
        { score: 2, label: 'Partial', description: expect.any(String) },
        { score: 3, label: 'Solid senior', description: expect.any(String) },
        { score: 4, label: 'Exceptional', description: 'Prioritises by risk with data on failure cost.' },
      ],
    });
    expect(req.transcript).toEqual({ text: sent().text, speakers: ['Interviewer 1', 'Candidate', 'Interviewer 2'] });
  });

  it('AI-5 PRIV-1: the candidate’s name or initials, requisition id, interviewer names and human scores, ticks and notes cannot enter the payload', () => {
    const plan = { ...workedExamplePlan(), questions: qaQuestions() };
    const session = { candidate: { initials: 'Zxqw Okafor-Lindqvist', requisitionId: 'REQ-98765' }, interviewer: { name: 'Priya Natarajan' } };
    const answer = { ...scored('qa-1', 4, { notes: [{ atSec: 5, text: 'SECRET-NOTE' }], coveredKeyPoints: [2] }), probeHandled: true };
    // Even a caller who smuggles everything into the question objects gets only the named fields.
    const smuggled = plan.questions.map((q) => ({ ...q, ...session, ...answer, id: q.id, rationale: 'HUMAN-RATIONALE' }));
    const req = buildSecondOpinionRequest({ questions: smuggled, transcript: { ...sent(), ...session } as never });
    const body = describePayload(req).body;
    for (const forbidden of ['Zxqw', 'Okafor', 'Lindqvist', 'REQ-98765', 'Priya', 'Natarajan', 'SECRET-NOTE', 'HUMAN-RATIONALE', 'initials', 'requisition', 'interviewer"', '"coveredKeyPoints"', '"probeHandled"', '"notes"', '"skipped"', '"candidate"']) {
      expect(body).not.toContain(forbidden);
    }
    expect(Object.keys(req)).toEqual(['version', 'questions', 'transcript']);
    expect(Object.keys(req.transcript)).toEqual(['text', 'speakers']);
    for (const q of req.questions) expect(Object.keys(q)).toEqual(['id', 'text', 'description', 'keyPoints', 'redFlags', 'probes', 'rubric']);
  });

  it('AI-5: refuses a transcript that has not been pseudonymised, and oversized input', () => {
    const raw = transcript();
    expect(() => buildSecondOpinionRequest({ questions: qaQuestions(), transcript: { text: raw.text, speakers: raw.speakers } })).toThrow(AiRequestError);
    expect(() => buildSecondOpinionRequest({ questions: [], transcript: sent() })).toThrow(/no questions/);
    expect(() => buildSecondOpinionRequest({ questions: qaQuestions(), transcript: { text: 'x'.repeat(AI_LIMITS.maxTranscriptChars + 1), speakers: [] } })).toThrow(/longer/);
    expect(() => buildSecondOpinionRequest({ questions: [makeQuestion({ id: 'q-1', text: 'x'.repeat(5000) })], transcript: sent() })).toThrow(/too long/);
  });

  it('AI-4 AI-5 BANK-15: the largest possible bundled plan (every question of the largest track, sentence-length key points and red flags) with a transcript at its size limit still fits the helper limits', () => {
    const tracks = ['web', 'qa', 'edge', 'aks'].map((id) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../seed/${id}.json`, import.meta.url)), 'utf8')) as TrackFile);
    const bytes = (f: TrackFile) => JSON.stringify(f.questions).length;
    const largest = [...tracks].sort((a, b) => bytes(b) - bytes(a))[0];
    const questions = largest.questions.map((q) => ({ ...q, trackId: largest.track.id }));
    expect(questions.length).toBeGreaterThanOrEqual(50);
    expect(questions.length).toBeLessThanOrEqual(AI_LIMITS.maxQuestions);
    const longest = Math.max(...tracks.flatMap((f) => f.questions.flatMap((q) => [...q.lookFor, ...q.redFlags, ...q.probes].map((x) => x.length))));
    expect(longest).toBeLessThanOrEqual(AI_LIMITS.maxListItemChars);
    // A transcript at the character limit, with multi-byte characters to be safe.
    const line = 'Candidate: I’d measure it first — then fix it.\n';
    const text = line.repeat(Math.floor(AI_LIMITS.maxTranscriptChars / line.length));
    const req = buildSecondOpinionRequest({ questions, transcript: { text, speakers: ['Candidate'] } });
    const d = describePayload(req);
    expect(d.questionCount).toBe(questions.length);
    expect(d.keyPointCount).toBe(questions.reduce((n, q) => n + q.lookFor.length, 0));
    expect(d.totalBytes).toBeLessThan(AI_LIMITS.maxRequestBytes);
    // The questions alone stay small next to the transcript.
    expect(new TextEncoder().encode(JSON.stringify(req.questions)).length).toBeLessThan(200 * 1024);
  });

  it('AI-3: describePayload says exactly what is sent, where, and what is not sent', () => {
    const req = buildSecondOpinionRequest({ questions: qaQuestions(), transcript: sent() });
    const d = describePayload(req);
    expect(d.body).toBe(JSON.stringify(req));
    expect(d.totalBytes).toBe(new TextEncoder().encode(d.body).length);
    expect(d.questionCount).toBe(3);
    expect(d.keyPointCount).toBe(8);
    expect(d.redFlagCount).toBe(2);
    expect(d.probeCount).toBe(1);
    expect(d.transcriptLines).toBe(5);
    expect(d.speakerLabels).toEqual(['Interviewer 1', 'Candidate', 'Interviewer 2']);
    expect(d.destination).toMatch(/Claude Code.*Anthropic/);
    expect(d.endpoint).toBe('api/ai/second-opinion');
    expect(d.sent.map((c) => c.label)).toEqual(['Transcript', 'Questions from the plan']);
    expect(d.notSent.join(' ')).toMatch(/initials.*requisition.*names.*score, tick or note.*recording/);
  });
});

// ---------------------------------------------------------------------------------------------

const entry = (p: Partial<AiModelQuestionOutput> & { questionId: string }): AiModelQuestionOutput => ({
  covered: true,
  score: 3,
  keyPointsCovered: [1],
  redFlagsObserved: [],
  rationale: 'Clear, risk-based answer.',
  quotes: [],
  ...p,
});
const goodOutput = (): AiModelOutput => ({
  questions: [
    entry({ questionId: 'qa-2', score: 2, keyPointsCovered: [1], quotes: ['I quarantine a flaky test, fix the wait'] }),
    entry({ questionId: 'qa-1', score: 4, keyPointsCovered: [3, 1, 2], quotes: ['I map the critical journeys ... automate those first'] }),
    entry({ questionId: 'qa-3', covered: false, score: null, keyPointsCovered: [], rationale: '', quotes: [] }),
  ],
});

describe('AI-6 response validation', () => {
  it('AI-6: accepts a well-formed reply, returns plan order and 0-based indexes', () => {
    const v = validateSecondOpinionOutput(goodOutput(), qaQuestions());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.questions.map((q) => q.questionId)).toEqual(['qa-1', 'qa-2', 'qa-3']);
    expect(v.questions[0].coveredKeyPoints).toEqual([0, 1, 2]);
    expect(v.questions[2]).toMatchObject({ covered: false, score: null });
  });

  const reject = (mutate: (o: AiModelOutput & Record<string, unknown>) => unknown, pattern: RegExp) => {
    const o = goodOutput() as AiModelOutput & Record<string, unknown>;
    const res = mutate(o);
    const v = validateSecondOpinionOutput(res === undefined ? o : res, qaQuestions());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toMatch(pattern);
  };

  it('AI-6: rejects anything that does not fit, with readable errors', () => {
    reject(() => 'scores: 4', /not a JSON object/);
    reject(() => ({}), /no list of questions/);
    reject((o) => void (o.extra = 1), /unexpected fields: extra/);
    reject((o) => void o.questions.pop(), /no entry for question 3/);
    reject((o) => void o.questions.push(entry({ questionId: 'qa-1' })), /Question 1 appears more than once/);
    reject((o) => void o.questions.push(entry({ questionId: 'qa-99' })), /not in the plan/);
    reject((o) => void (o.questions[0].score = 5 as never), /whole number from 1 to 4/);
    reject((o) => void (o.questions[0].score = 2.5 as never), /whole number from 1 to 4/);
    reject((o) => void (o.questions[0].score = null), /whole number from 1 to 4/);
    reject((o) => void (o.questions[2].score = 2), /not covered must have no score/);
    reject((o) => void (o.questions[2].keyPointsCovered = [1]), /not covered cannot have key points/);
    reject((o) => void (o.questions[0].keyPointsCovered = [4]), /between 1 and 3/);
    reject((o) => void (o.questions[0].keyPointsCovered = [0]), /between 1 and 3/);
    reject((o) => void (o.questions[0].keyPointsCovered = [1, 1]), /same item twice/);
    reject((o) => void (o.questions[0].redFlagsObserved = [2]), /between 1 and 1/);
    reject((o) => void (o.questions[0].rationale = 'x'.repeat(AI_LIMITS.maxRationaleChars + 1)), /rationale is longer/);
    reject((o) => void (o.questions[0].rationale = ' '), /rationale is empty/);
    reject((o) => void (o.questions[0].quotes = ['a', 'b', 'c', 'd']), /more than 3 quotations/);
    reject((o) => void (o.questions[0].quotes = ['x'.repeat(AI_LIMITS.maxQuoteChars + 1)]), /each quotation/);
    reject((o) => void ((o.questions[0] as unknown as Record<string, unknown>).confidence = 0.9), /unexpected fields: confidence/);
    reject((o) => void delete (o.questions[0] as Partial<AiModelQuestionOutput>).rationale, /missing: rationale/);
    reject((o) => void (o.questions[0].covered = 'yes' as never), /true or false/);
  });

  it('AI-6: error messages never repeat the model text', () => {
    const o = goodOutput();
    o.questions[0].rationale = `<script>${'x'.repeat(700)}`;
    const v = validateSecondOpinionOutput(o, qaQuestions());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).not.toContain('<script>');
  });
});

describe('AI-6 quotation verification', () => {
  const index = () => buildQuoteIndex(sent().lines);

  it('AI-6: verifies quotations ignoring case, punctuation and whitespace, with the line number', () => {
    expect(verifyQuotation('i START from risk', index())).toEqual({ text: 'i START from risk', status: 'verified', line: 2, speaker: 'Candidate' });
    expect(verifyQuotation('"critical journeys: checkout, login, payments"', index())).toMatchObject({ status: 'verified', line: 3 });
    expect(verifyQuotation('I quarantine a flaky test fix the wait', index())).toMatchObject({ status: 'verified', line: 5, speaker: 'Candidate' });
  });

  it('AI-6: tolerates ellipses joining two real spans, in order', () => {
    expect(verifyQuotation('I map the critical journeys … because they break most often', index())).toMatchObject({ status: 'verified', line: 3 });
    expect(verifyQuotation('I map the critical journeys [...] automate those first', index())).toMatchObject({ status: 'verified' });
    expect(verifyQuotation('because they break most often ... I map the critical journeys', index()).status).toBe('unverified');
  });

  it('AI-6: marks invented or altered quotations as unverified', () => {
    expect(verifyQuotation('I always automate everything', index())).toEqual({ text: 'I always automate everything', status: 'unverified', line: null, speaker: null });
    expect(verifyQuotation('start from risks', index()).status).toBe('unverified'); // no partial-word matches
    expect(verifyQuotation('...', index()).status).toBe('unverified');
  });

  it('AI-6: a quotation may run across two consecutive lines', () => {
    expect(verifyQuotation('funnily enough. I map the critical journeys', index())).toMatchObject({ status: 'verified', line: 2 });
    expect(normaliseForMatch("Don't  — WAIT…")).toBe('dont wait');
  });
});

// ---------------------------------------------------------------------------------------------

const workedAiResult = (scores: Array<1 | 2 | 3 | 4 | null>): Pick<AiSecondOpinion, 'questions'> => ({
  questions: scores.map((s, i) => ({
    questionId: `t-${i + 1}`,
    covered: s != null,
    score: s,
    coveredKeyPoints: [],
    redFlagsSeen: [],
    rationale: s == null ? '' : 'r',
    quotes: [],
  })),
});

describe('AI-7 AI scorecard uses the human maths', () => {
  it('AI-7: the docs/04 worked example gives 59.72%, coverage 76%, Lean no hire', () => {
    const plan = workedExamplePlan();
    const ai = computeAiScorecard(plan, workedAiResult([4, 3, 2, null]));
    const human = computeScorecard(plan, [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), skipped('t-4')]);
    expect(ai.overallPct).toBeCloseTo(59.72, 2);
    expect(ai.coverage).toBeCloseTo(0.762, 3);
    expect(ai.band).toBe('lean_no_hire');
    expect(ai.overallPct).toBe(human.overallPct);
    expect(ai.band).toBe(human.band);
    expect(ai.skipped.map((q) => q.skipReason)).toEqual(['Not covered in the transcript']);
  });

  it('AI-7: "not covered" lowers coverage like a skip (SCORE-6 Insufficient evidence)', () => {
    const ai = computeAiScorecard(workedExamplePlan(), workedAiResult([4, 3, null, null]));
    expect(ai.coverage).toBeCloseTo(0.444, 3);
    expect(ai.insufficientEvidence).toBe(true);
    expect(ai.band).toBeNull();
  });

  it('AI-7: the must-have cap (SCORE-8) applies to the AI band too', () => {
    const ai = computeAiScorecard(workedExamplePlan(true), workedAiResult([4, 1, 4, 4]));
    expect(ai.overallPct).toBeCloseTo(71.43, 2);
    expect(ai.capApplied).toBe(true);
    expect(ai.band).toBe('lean_no_hire');
  });
});

describe('AI-6 / AI-8 result record', () => {
  const plan = () => ({ ...workedExamplePlan(), questions: qaQuestions() });

  it('AI-8: records the model, time, transcript fingerprint and verified quotations', () => {
    const res = createSecondOpinion({ plan: plan(), sentTranscript: sent(), response: { model: 'claude-test-1', output: goodOutput(), durationMs: 1234 }, createdAt: '2026-11-24T10:00:00.000Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result;
    expect(r).toMatchObject({ kind: 'ai-second-opinion', formatVersion: 1, model: 'claude-test-1', createdAt: '2026-11-24T10:00:00.000Z', transcriptHash: transcript().hash, planFingerprint: plan().fingerprint, durationMs: 1234 });
    expect(r.questions.map((q) => q.questionId)).toEqual(['qa-1', 'qa-2', 'qa-3']);
    expect(r.questions[0].quotes).toEqual([{ text: 'I map the critical journeys ... automate those first', status: 'verified', line: 3, speaker: 'Candidate' }]);
    expect(r.unverifiedQuoteCount).toBe(0);
  });

  it('AI-6: an invalid reply produces errors, never a result', () => {
    const res = createSecondOpinion({ plan: plan(), sentTranscript: sent(), response: { model: 'm', output: { questions: [] } } });
    expect(res.ok).toBe(false);
  });

  it('AI-6: unverified quotations are counted', () => {
    const o = goodOutput();
    o.questions[0].quotes = ['Something the candidate never said'];
    const res = createSecondOpinion({ plan: plan(), sentTranscript: sent(), response: { model: 'm', output: o } });
    expect(res.ok && res.result.unverifiedQuoteCount).toBe(1);
  });

  it('AI-8: a result is out of date when the transcript changed or was removed', () => {
    const r = { transcriptHash: transcript().hash };
    expect(isOutOfDate(r, transcript().hash)).toBe(false);
    expect(isOutOfDate(r, parseTranscriptText(`${TRANSCRIPT}\nPriya Natarajan: Thanks.`).hash)).toBe(true);
    expect(isOutOfDate(r, null)).toBe(true);
  });
});

describe('AI-11 comparison with an interviewer', () => {
  it('AI-11: lists questions where the AI and the interviewer differ by two points or more', () => {
    const plan = workedExamplePlan();
    const human = computeScorecard(plan, [scored('t-1', 4), scored('t-2', 1), scored('t-3', 2), skipped('t-4')]);
    const cmp = compareWithAi(human, workedAiResult([2, 3, 3, 4]));
    expect(AI_DISCUSS_DIFFERENCE).toBe(2);
    expect(cmp.rows.map((r) => r.difference)).toEqual([-2, 2, 1, null]);
    expect(cmp.worthDiscussing.map((r) => r.question.id)).toEqual(['t-1', 't-2']);
    expect(cmp.rows[3]).toMatchObject({ humanScore: null, aiScore: 4, worthDiscussing: false });
    expect(cmp.rows[0].ai?.rationale).toBe('r');
  });

  it('AI-11: a question the AI marked not covered has no difference', () => {
    const plan = workedExamplePlan();
    const human = computeScorecard(plan, [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), scored('t-4', 1)]);
    const cmp = compareWithAi(human, workedAiResult([4, 3, 2, null]));
    expect(cmp.rows[3]).toMatchObject({ humanScore: 1, aiScore: null, aiCovered: false, difference: null });
    expect(cmp.worthDiscussing).toEqual([]);
  });
});
