import { describe, expect, it } from 'vitest';
import {
  EMPTY_OVERALL,
  adjacentQuestion,
  applyRecordOp,
  applyRecordOps,
  clockOffset,
  initialsOf,
  isComplete,
  isPresent,
  moveOutcome,
  moveTimers,
  movesEveryone,
  pauseTimers,
  PRESENCE_TTL_MS,
  questionSeconds,
  recordOpProblem,
  resolvedQuestions,
  resumeTimers,
  startTimers,
  stopAllTimers,
  toDomainAnswers,
  waitingFor,
} from './live';
import { computeScorecard } from './scoring';
import type { RecordData, RecordOp } from '../shared/api';

const empty: RecordData = { answers: [], notes: [], overall: EMPTY_OVERALL };
const q = { id: 'q1', lookFor: ['a', 'b', 'c', 'd'], redFlags: ['x', 'y'] };

describe('a record’s changes (LIVE-1, RES-1, HOST-6)', () => {
  it('LIVE-1 FLOW-13 FLOW-17 FLOW-18: ops set values; a score undoes a skip; a skip clears the score', () => {
    let r = applyRecordOps(empty, [
      { t: 'kp', q: 'q1', i: 2, on: true },
      { t: 'kp', q: 'q1', i: 0, on: true },
      { t: 'rf', q: 'q1', i: 1, on: true },
      { t: 'probe', q: 'q1', on: true },
      { t: 'flag', q: 'q1', on: true },
      { t: 'score', q: 'q1', v: 3 },
    ]);
    expect(r.answers).toEqual([{ questionId: 'q1', score: 3, coveredKeyPoints: [0, 2], redFlagsSeen: [1], probeHandled: true, flagged: true, skipped: false, skipReason: null }]);
    r = applyRecordOp(r, { t: 'skip', q: 'q1', reason: '  No time ' });
    expect(r.answers[0]).toMatchObject({ skipped: true, skipReason: 'No time', score: null });
    r = applyRecordOp(r, { t: 'score', q: 'q1', v: 2 });
    expect(r.answers[0]).toMatchObject({ skipped: false, skipReason: null, score: 2 });
    r = applyRecordOp(r, { t: 'kp', q: 'q1', i: 0, on: false });
    expect(r.answers[0].coveredKeyPoints).toEqual([2]);
  });

  it('HOST-6: applying the same ops twice gives the same record (a resend after a lost reply is harmless)', () => {
    const ops: RecordOp[] = [
      { t: 'kp', q: 'q1', i: 1, on: true },
      { t: 'note.add', id: 'n1', q: 'q1', atSec: 61.7, text: 'Said X', by: null },
      { t: 'note.edit', id: 'n1', text: 'Said X and Y' },
      { t: 'overall', rating: 3, rationale: 'ok' },
    ];
    const once = applyRecordOps(empty, ops);
    expect(applyRecordOps(once, ops)).toEqual(once);
    expect(once.notes).toEqual([{ id: 'n1', questionId: 'q1', atSec: 61, text: 'Said X and Y', by: null }]);
    expect(once.overall).toEqual({ rating: 3, recommendation: null, rationale: 'ok' });
    // Edits and deletes of a note that is gone change nothing.
    expect(applyRecordOp(once, { t: 'note.edit', id: 'nope', text: 'x' })).toBe(once);
    expect(applyRecordOps(once, [{ t: 'note.del', id: 'n1' }, { t: 'note.del', id: 'n1' }]).notes).toEqual([]);
  });

  it('HOST-6: two tabs ticking different key points never undo each other, whichever arrives first', () => {
    const a: RecordOp = { t: 'kp', q: 'q1', i: 0, on: true };
    const b: RecordOp = { t: 'kp', q: 'q1', i: 3, on: true };
    expect(applyRecordOps(empty, [a, b])).toEqual(applyRecordOps(empty, [b, a]));
    expect(applyRecordOps(empty, [a, b]).answers[0].coveredKeyPoints).toEqual([0, 3]);
  });

  it('SEC-2: ops are checked against the question set before they are applied', () => {
    expect(recordOpProblem({ t: 'score', q: 'q9', v: 3 }, [q])).toMatch(/not in this interview/);
    expect(recordOpProblem({ t: 'kp', q: 'q1', i: 4, on: true }, [q])).toMatch(/key point/);
    expect(recordOpProblem({ t: 'rf', q: 'q1', i: 2, on: true }, [q])).toMatch(/red flag/);
    expect(recordOpProblem({ t: 'skip', q: 'q1', reason: ' ' }, [q])).toMatch(/reason/);
    expect(recordOpProblem({ t: 'note.add', id: 'n', q: 'q1', atSec: 0, text: ' ', by: null }, [q])).toMatch(/text/);
    expect(recordOpProblem({ t: 'kp', q: 'q1', i: 3, on: true }, [q])).toBeNull();
    expect(recordOpProblem({ t: 'overall', rating: 2 }, [q])).toBeNull();
  });

  it('LIVE-3: the questions a record has resolved are the scored and skipped ones', () => {
    const r = applyRecordOps(empty, [
      { t: 'score', q: 'a', v: 1 },
      { t: 'skip', q: 'b', reason: 'x' },
      { t: 'kp', q: 'c', i: 0, on: true },
    ]);
    expect(resolvedQuestions(r)).toEqual(['a', 'b']);
  });

  it('SCORE-3 FLOW-22: a record converts to the scoring module’s shapes unchanged (notes in order, time per question)', () => {
    const r = applyRecordOps(empty, [
      { t: 'score', q: 'q1', v: 4 },
      { t: 'note.add', id: 'n1', q: 'q1', atSec: 5, text: 'first', by: 'Ana' },
      { t: 'note.add', id: 'n2', q: 'q2', atSec: 9, text: 'only a note', by: null },
    ]);
    const answers = toDomainAnswers(r, 'rec', { q1: 125 });
    expect(answers.find((a) => a.questionId === 'q1')).toMatchObject({ sessionId: 'rec', score: 4, notes: [{ atSec: 5, text: 'first', by: 'Ana' }], elapsedSec: 125 });
    expect(answers.find((a) => a.questionId === 'q2')).toMatchObject({ score: null, notes: [{ atSec: 9, text: 'only a note' }] });
    const sc = computeScorecard({ questions: [{ id: 'q1', categoryId: 'c', difficulty: 'core', type: 'knowledge' } as never], categories: [{ id: 'c', weight: 1, mustHave: false } as never] }, answers);
    expect(sc.overallPct).toBe(100);
  });
});

describe('the shared interview (LIVE-2, RES-2)', () => {
  it('RES-2 FLOW-19 FLOW-21: timers are timestamps: moving stops one question’s timer and starts the next; pausing stops both; resuming restarts them', () => {
    let t = startTimers('q1', 1000);
    t = moveTimers(t, 'q1', 'q2', true, 61_000);
    expect(t.questionTimers.q1).toEqual({ accumulatedMs: 60_000, runningSince: null });
    expect(t.questionTimers.q2).toEqual({ accumulatedMs: 0, runningSince: 61_000 });
    t = pauseTimers(t, 'q2', 71_000);
    expect(t.timer).toEqual({ accumulatedMs: 70_000, runningSince: null });
    expect(t.questionTimers.q2).toEqual({ accumulatedMs: 10_000, runningSince: null });
    // Moving while paused keeps everything stopped.
    t = moveTimers(t, 'q2', 'q1', false, 80_000);
    expect(t.questionTimers.q1.runningSince).toBeNull();
    t = resumeTimers(t, 'q1', 100_000);
    expect(t.timer).toEqual({ accumulatedMs: 70_000, runningSince: 100_000 });
    expect(t.questionTimers.q1).toEqual({ accumulatedMs: 60_000, runningSince: 100_000 });
    expect(questionSeconds(t, 105_000)).toEqual({ q1: 65, q2: 10 });
    const done = stopAllTimers(t, 110_000);
    expect(Object.values(done.questionTimers).every((x) => x.runningSince === null)).toBe(true);
    expect(done.timer.accumulatedMs).toBe(80_000);
  });

  it('LIVE-2 HOST-5: a move applies only from where the panel is; the same move again changes nothing; anything else is stale', () => {
    expect(moveOutcome('q1', 'q1', 'q2')).toBe('moved');
    expect(moveOutcome('q2', 'q1', 'q2')).toBe('already-there');
    expect(moveOutcome('q3', 'q1', 'q2')).toBe('stale');
    expect(adjacentQuestion(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(adjacentQuestion(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(adjacentQuestion(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(adjacentQuestion(['a', 'b', 'c'], null, 1)).toBe('a');
  });

  it('LIVE-2: only the lead moves everyone, and only while online and the interview runs', () => {
    expect(movesEveryone({ leadUserId: 'me', state: 'in_progress' }, 'me', true)).toBe(true);
    expect(movesEveryone({ leadUserId: 'me', state: 'paused' }, 'me', true)).toBe(true);
    expect(movesEveryone({ leadUserId: 'me', state: 'in_progress' }, 'me', false)).toBe(false);
    expect(movesEveryone({ leadUserId: 'ben', state: 'in_progress' }, 'me', true)).toBe(false);
    expect(movesEveryone({ leadUserId: 'me', state: 'completed' }, 'me', true)).toBe(false);
  });
});

describe('who is there and who is still to submit (LIVE-3, LIVE-4)', () => {
  it('LIVE-3: someone is in the interview while their heartbeats keep coming', () => {
    expect(isPresent(1000, 1000 + PRESENCE_TTL_MS)).toBe(true);
    expect(isPresent(1000, 1001 + PRESENCE_TTL_MS)).toBe(false);
    expect(isPresent(null, 1000)).toBe(false);
    expect(initialsOf('Ana Diaz')).toBe('AD');
    expect(initialsOf('ben')).toBe('BE');
    expect(initialsOf('Cy de la Park')).toBe('CP');
  });

  it('LIVE-4: complete once someone submitted and everyone who joined has; members who never joined do not hold it up', () => {
    expect(isComplete(['submitted', 'submitted'])).toBe(true);
    expect(isComplete(['submitted', 'joined'])).toBe(false);
    expect(isComplete(['submitted', 'expected'])).toBe(true);
    expect(isComplete(['submitted', 'did_not_take_part'])).toBe(true);
    expect(isComplete(['expected', 'did_not_take_part'])).toBe(false);
    expect(waitingFor([{ name: 'Ana', status: 'submitted' }, { name: 'Ben', status: 'joined' }, { name: 'Cy', status: 'expected' }])).toEqual(['Ben']);
  });
});

describe('the server’s clock (RES-2)', () => {
  it('RES-2: the offset comes from the sample with the shortest round trip, assuming the server answered halfway', () => {
    expect(clockOffset([])).toBe(0);
    // Server 5 s ahead; a slow sample (800 ms round trip) and a quick one (40 ms).
    expect(clockOffset([{ serverNow: 105_400, sentAt: 100_000, receivedAt: 100_800 }, { serverNow: 205_020, sentAt: 200_000, receivedAt: 200_040 }])).toBe(5000);
    // Server 2 s behind.
    expect(clockOffset([{ serverNow: 98_010, sentAt: 100_000, receivedAt: 100_020 }])).toBe(-2000);
    // A sample whose clock went backwards is ignored.
    expect(clockOffset([{ serverNow: 1, sentAt: 10, receivedAt: 5 }])).toBe(0);
  });
});
