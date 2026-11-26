import { describe, expect, it } from 'vitest';
import { makeAnswer, makeQuestion } from '../../test/fixtures';
import { suggestScore } from '../../domain/rubric';
import type { Score } from '../../domain/types';
import {
  activeShortcutKeys,
  candidateDisplay,
  describeAnswerAmendment,
  draftFromAnswer,
  draftNotes,
  explainSuggestion,
  finishSummary,
  formatPositions,
  progressCounts,
  unresolvedSentence,
  progressItems,
  shortRole,
  timerChangeAnnouncement,
  type TimerSnapshot,
} from './logic';

const q5 = makeQuestion({ id: 't-1', lookFor: ['a', 'b', 'c', 'd', 'e'], redFlags: ['x', 'y'] });
const ticks = (covered: number[], flags: number[] = [], probe = false) => ({ coveredKeyPoints: covered, redFlagsSeen: flags, probeHandled: probe });

describe('explainSuggestion (RUB-3)', () => {
  it('RUB-3: no suggestion until at least one box is ticked', () => {
    expect(explainSuggestion(q5, ticks([]))).toBeNull();
    expect(explainSuggestion(q5, null)).toBeNull();
  });

  it('RUB-3 row 1: any red flag ticked suggests 1, even with every key point and the probe', () => {
    const s = explainSuggestion(q5, ticks([0, 1, 2, 3, 4], [1], true));
    expect(s?.score).toBe(1);
    expect(s?.reason).toMatch(/red flag/);
  });

  it('RUB-3 row 2: fewer than 25% of key points suggests 1', () => {
    const s = explainSuggestion(q5, ticks([0])); // 20%
    expect(s).toEqual({ score: 1, reason: '1 of 5 key points (20%): fewer than 25%.' });
    // Only the probe ticked: 0% of key points.
    expect(explainSuggestion(q5, ticks([], [], true))?.score).toBe(1);
  });

  it('RUB-3 row 3: fewer than 60% suggests 2 (25% exactly is not under 25%)', () => {
    const q4 = makeQuestion({ id: 't-2', lookFor: ['a', 'b', 'c', 'd'] });
    expect(explainSuggestion(q4, ticks([0]))?.score).toBe(2); // 25%
    expect(explainSuggestion(q5, ticks([0, 1]))).toEqual({ score: 2, reason: '2 of 5 key points (40%): fewer than 60%.' });
  });

  it('RUB-3 row 4: all key points and the probe handled suggests 4', () => {
    expect(explainSuggestion(q5, ticks([0, 1, 2, 3, 4], [], true))).toEqual({
      score: 4,
      reason: 'All 5 key points, and the probe was handled without help.',
    });
  });

  it('RUB-3 row 5: otherwise 3 (60% exactly, or all key points without the probe)', () => {
    expect(explainSuggestion(q5, ticks([0, 1, 2]))?.reason).toBe('3 of 5 key points (60%): at least 60% but not all.');
    expect(explainSuggestion(q5, ticks([0, 1, 2]))?.score).toBe(3);
    expect(explainSuggestion(q5, ticks([0, 1, 2, 3, 4]))?.score).toBe(3);
    expect(explainSuggestion(q5, ticks([0, 1, 2, 3, 4]))?.reason).toMatch(/probe is not ticked/);
  });

  it('RUB-3: always agrees with the domain rule for every combination of ticks', () => {
    for (let n = 1; n <= 7; n++) {
      const q = makeQuestion({ id: `t-${n}`, lookFor: Array.from({ length: n }, (_, i) => `k${i}`) });
      for (let mask = 0; mask < 1 << n; mask++) {
        const covered = Array.from({ length: n }, (_, i) => i).filter((i) => mask & (1 << i));
        for (const flags of [[], [0]]) {
          for (const probe of [false, true]) {
            const t = ticks(covered, flags, probe);
            expect(explainSuggestion(q, t)?.score ?? null).toBe(suggestScore({ ...t, keyPointCount: n }));
          }
        }
      }
    }
  });
});

describe('progressItems (FLOW-20, FLOW-16)', () => {
  const plan = { questions: [makeQuestion({ id: 't-1' }), makeQuestion({ id: 't-2' }), makeQuestion({ id: 't-3' }), makeQuestion({ id: 't-4' })] };

  it('FLOW-20: unanswered, scored with score, skipped and flagged; FLOW-16 needs-note', () => {
    const items = progressItems(plan, [
      makeAnswer('t-1', { score: 3 }),
      makeAnswer('t-2', { skipped: true, skipReason: 'time', flagged: true }),
      makeAnswer('t-3', { score: 4 }),
    ]);
    expect(items.map((i) => [i.position, i.status, i.score, i.flagged, i.needsNote])).toEqual([
      [1, 'scored', 3, false, false],
      [2, 'skipped', null, true, false],
      [3, 'scored', 4, false, true],
      [4, 'unanswered', null, false, false],
    ]);
    expect(items[2].summary).toBe('Scored 4 (Exceptional), needs a note');
    expect(items[1].summary).toBe('Skipped, flagged');
    expect(progressCounts(items)).toEqual({ total: 4, scored: 2, skipped: 1, resolved: 3, flagged: 1, needsNote: 1 });
  });

  it('FLOW-16: a 1 with a note does not need one', () => {
    const [it1] = progressItems({ questions: [plan.questions[0]] }, [makeAnswer('t-1', { score: 1, notes: [{ atSec: 5, text: 'said X' }] })]);
    expect(it1.needsNote).toBe(false);
  });
});

describe('timerChangeAnnouncement (A11Y-4)', () => {
  const base: TimerSnapshot = { questionId: 'q1', overall: 'normal', question: 'normal', paused: false };

  it('A11Y-4: nothing on first render or when nothing changed (ticking is never announced)', () => {
    expect(timerChangeAnnouncement(null, { ...base, overall: 'red' })).toBeNull();
    expect(timerChangeAnnouncement(base, { ...base })).toBeNull();
  });

  it('A11Y-4 / FLOW-19: overall amber at 80% and red when over are announced once each', () => {
    expect(timerChangeAnnouncement(base, { ...base, overall: 'amber' })).toMatch(/nearly out of time/);
    expect(timerChangeAnnouncement({ ...base, overall: 'amber' }, { ...base, overall: 'red' })).toMatch(/over time/);
  });

  it('A11Y-4: the question timer turning amber is announced, but not moving to a question that is already amber', () => {
    expect(timerChangeAnnouncement(base, { ...base, question: 'amber' })).toMatch(/estimate/);
    expect(timerChangeAnnouncement(base, { ...base, questionId: 'q2', question: 'amber' })).toBeNull();
    expect(timerChangeAnnouncement({ ...base, question: 'amber' }, { ...base, question: 'amber', paused: true })).toBeNull();
  });
});

describe('describeAnswerAmendment (AUD-4)', () => {
  const answer = makeAnswer('t-1', {
    score: 3 as Score,
    notes: [
      { atSec: 10, text: 'first' },
      { atSec: 20, text: 'second' },
    ],
  });

  it('AUD-4: no change gives an empty list', () => {
    expect(describeAnswerAmendment(answer, draftFromAnswer(answer))).toEqual([]);
  });

  it('AUD-4: lists score, edited, deleted and added notes', () => {
    const d = draftFromAnswer(answer);
    d.score = 4;
    d.notes[0] = { ...d.notes[0], text: 'first, corrected' };
    d.notes.splice(1, 1);
    d.notes.push({ atSec: 99, text: 'added later', orig: null });
    expect(describeAnswerAmendment(answer, d)).toEqual([
      'Score: 3 (Solid senior) → 4 (Exceptional)',
      'Note 1 edited: “first, corrected”',
      'Note 2 deleted: “second”',
      'Note added: “added later”',
    ]);
    expect(draftNotes(d)).toEqual([
      { atSec: 10, text: 'first, corrected' },
      { atSec: 99, text: 'added later' },
    ]);
  });

  it('AUD-4: an emptied note counts as deleted and blank new notes are ignored', () => {
    const d = draftFromAnswer(answer);
    d.notes[1] = { ...d.notes[1], text: '   ' };
    d.notes.push({ atSec: 99, text: '', orig: null });
    expect(describeAnswerAmendment(answer, d)).toEqual(['Note 2 deleted: “second”']);
    expect(draftNotes(d)).toEqual([{ atSec: 10, text: 'first' }]);
  });
});

describe('candidateDisplay (FLOW-11)', () => {
  const plan = { questions: [makeQuestion({ id: 't-1', text: 'First?' }), makeQuestion({ id: 't-2', text: 'Second?' })] };
  const s = (state: 'planned' | 'in_progress' | 'paused' | 'submitted', origin: 'local' | 'imported' = 'local') => ({
    state,
    currentQuestionId: 't-2',
    origin,
  });

  it('FLOW-11: only the number and text of the current question while running', () => {
    expect(candidateDisplay(s('in_progress'), plan)).toEqual({ kind: 'question', position: 2, total: 2, text: 'Second?' });
  });

  it('FLOW-11: a neutral message before the start, while paused, after submission, and for imported sessions', () => {
    for (const st of ['planned', 'paused', 'submitted'] as const) expect(candidateDisplay(s(st), plan).kind).toBe('waiting');
    expect(candidateDisplay(s('in_progress', 'imported'), plan).kind).toBe('waiting');
    expect(candidateDisplay(null, plan).kind).toBe('waiting');
  });
});

describe('activeShortcutKeys (KEY-1)', () => {
  it('KEY-1: all shortcuts in a live interview', () => {
    expect(activeShortcutKeys({ state: 'live', candidateView: false }).sort()).toEqual(
      ['/', '1', '2', '3', '4', '?', 'Escape', 'c', 'f', 'n', 'p', 's'].sort(),
    );
  });
  it('FLOW-11 / KEY-1: only navigation, the toggle and help in the candidate view; read-only records cannot be scored', () => {
    expect(activeShortcutKeys({ state: 'live', candidateView: true })).toEqual(['n', 'p', 'c', '?']);
    expect(activeShortcutKeys({ state: 'readonly', candidateView: false })).not.toContain('1');
    expect(activeShortcutKeys({ state: 'planned', candidateView: false })).toEqual(['?']);
  });
});

describe('finish summary (UX-6)', () => {
  it('UX-6: positions are written as short ranges', () => {
    expect(formatPositions([])).toBe('');
    expect(formatPositions([3])).toBe('3');
    expect(formatPositions([3, 4])).toBe('3 and 4');
    expect(formatPositions([5, 3])).toBe('3 and 5');
    expect(formatPositions([3, 4, 5, 6, 9])).toBe('3–6 and 9');
    expect(formatPositions([2, 4, 6, 7, 8, 9])).toBe('2, 4 and 6–9');
    expect(formatPositions([1, 2, 4, 5])).toBe('1, 2, 4 and 5');
  });

  it('UX-6 FLOW-16 FLOW-22: unanswered questions are summarised in one sentence; a 1 or 4 without a note is listed separately', () => {
    const questions = Array.from({ length: 14 }, (_, i) => makeQuestion({ id: `q${i + 1}` }));
    const answers = [
      makeAnswer('q1', { score: 3 }),
      makeAnswer('q2', { score: 4 }),
      makeAnswer('q3', { skipped: true, skipReason: 'x' }),
      makeAnswer('q5', { score: 1, notes: [{ atSec: 1, text: 'why' }] }),
    ];
    const s = finishSummary({ questions }, answers);
    expect(s.unresolved.map((u) => u.position)).toEqual([4, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(s.needsNote).toEqual([{ questionId: 'q2', position: 2, score: 4 }]);
    expect(s.questionCount).toBe(11);
    expect(unresolvedSentence(s.unresolved)).toBe('Not scored or skipped yet: questions 4 and 6–14.');
    expect(unresolvedSentence(s.unresolved.slice(0, 1))).toBe('Not scored or skipped yet: question 4.');
  });
});

describe('shortRole (UX-5)', () => {
  it('UX-5: the top bar names the role by the part that tells the roles apart', () => {
    expect(shortRole('Senior Platform Engineer (AKS with Azure)')).toBe('AKS with Azure');
    expect(shortRole('Senior QA Engineer')).toBe('Senior QA Engineer');
    expect(shortRole('Odd ( )')).toBe('Odd ( )');
  });
});
