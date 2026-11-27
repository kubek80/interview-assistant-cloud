// Interviewing together (LIVE-1…LIVE-8, RES-2, HOST-6): the pure rules shared by the server and the
// browser. The server applies a panel member's record changes with `applyRecordOp`, and the browser
// applies the same function to show them at once (optimistic) and while offline, so what the screen
// shows is exactly what the server will store. No I/O here.
import type { AnswerJson, LiveState, NoteJson, OverallJson, RecordData, RecordOp, TimerJson } from '../shared/api';
import type { PanelStatus } from './rounds';
import type { Answer, OverallAssessment } from './types';
import { elapsedMs, pauseTimer, startTimer } from './timer';

// ---------------------------------------------------------------------------------------------
// One record (LIVE-1)

export const EMPTY_OVERALL: OverallJson = { rating: null, recommendation: null, rationale: '' };

export function emptyAnswer(questionId: string): AnswerJson {
  return { questionId, score: null, coveredKeyPoints: [], redFlagsSeen: [], probeHandled: false, flagged: false, skipped: false, skipReason: null };
}

const setIndex = (list: readonly number[], i: number, on: boolean): number[] => {
  const s = new Set(list);
  if (on) s.add(i);
  else s.delete(i);
  return [...s].sort((a, b) => a - b);
};

/** The question an op is about (null for overall and for note edits, which carry only the note id). */
export function opQuestion(op: RecordOp): string | null {
  return 'q' in op ? op.q : null;
}

/**
 * Applies one change to a record. Every op *sets* a value, so applying it twice gives the same
 * result (a resend after a lost connection, or the same change from two tabs, never undoes
 * anything). Choosing a score undoes a skip; skipping clears the score (FLOW-17).
 */
export function applyRecordOp(data: RecordData, op: RecordOp): RecordData {
  if (op.t === 'overall') {
    const o = { ...data.overall };
    if (op.rating !== undefined) o.rating = op.rating;
    if (op.recommendation !== undefined) o.recommendation = op.recommendation;
    if (op.rationale !== undefined) o.rationale = op.rationale;
    return { ...data, overall: o };
  }
  if (op.t === 'note.add') {
    if (data.notes.some((n) => n.id === op.id)) return data;
    const note: NoteJson = { id: op.id, questionId: op.q, atSec: Math.max(0, Math.floor(op.atSec)), text: op.text, by: op.by ?? null };
    return { ...data, notes: [...data.notes, note] };
  }
  if (op.t === 'note.edit') {
    if (!data.notes.some((n) => n.id === op.id)) return data;
    return { ...data, notes: data.notes.map((n) => (n.id === op.id ? { ...n, text: op.text, ...(op.by !== undefined ? { by: op.by } : {}) } : n)) };
  }
  if (op.t === 'note.del') {
    return data.notes.some((n) => n.id === op.id) ? { ...data, notes: data.notes.filter((n) => n.id !== op.id) } : data;
  }
  const existing = data.answers.find((a) => a.questionId === op.q);
  const a: AnswerJson = existing ? { ...existing } : emptyAnswer(op.q);
  switch (op.t) {
    case 'score':
      a.score = op.v;
      if (op.v != null) {
        a.skipped = false;
        a.skipReason = null;
      }
      break;
    case 'kp':
      a.coveredKeyPoints = setIndex(a.coveredKeyPoints, op.i, op.on);
      break;
    case 'rf':
      a.redFlagsSeen = setIndex(a.redFlagsSeen, op.i, op.on);
      break;
    case 'probe':
      a.probeHandled = op.on;
      break;
    case 'flag':
      a.flagged = op.on;
      break;
    case 'skip':
      a.skipped = true;
      a.skipReason = op.reason.trim();
      a.score = null;
      break;
    case 'unskip':
      a.skipped = false;
      a.skipReason = null;
      break;
  }
  const answers = existing ? data.answers.map((x) => (x.questionId === op.q ? a : x)) : [...data.answers, a];
  return { ...data, answers };
}

export function applyRecordOps(data: RecordData, ops: readonly RecordOp[]): RecordData {
  return ops.reduce(applyRecordOp, data);
}

/** Problems with an op against the question set; empty when it may be applied (the server refuses the batch otherwise). */
export function recordOpProblem(op: RecordOp, questions: ReadonlyArray<{ id: string; lookFor: readonly string[]; redFlags: readonly string[] }>): string | null {
  const q = opQuestion(op);
  if (q === null) return null;
  const question = questions.find((x) => x.id === q);
  if (!question) return 'That question is not in this interview.';
  if (op.t === 'kp' && (op.i < 0 || op.i >= question.lookFor.length)) return 'That key point is not on this question.';
  if (op.t === 'rf' && (op.i < 0 || op.i >= question.redFlags.length)) return 'That red flag is not on this question.';
  if (op.t === 'skip' && !op.reason.trim()) return 'A reason is required to skip a question.';
  if (op.t === 'note.add' && !op.text.trim()) return 'A note needs some text.';
  return null;
}

/**
 * A record in the shapes the scoring module and the finish rules take (domain/types Answer and
 * OverallAssessment), so the hosted app uses them unchanged (SCORE-1…SCORE-10, FLOW-16, FLOW-22).
 * Notes keep their order of creation; `elapsedSec` comes from the shared per-question timers.
 */
export function toDomainAnswers(data: Pick<RecordData, 'answers' | 'notes'>, recordId: string, elapsedSec: Readonly<Record<string, number>> = {}): Answer[] {
  const ids = new Set([...data.answers.map((a) => a.questionId), ...data.notes.map((n) => n.questionId)]);
  return [...ids].map((questionId) => {
    const a = data.answers.find((x) => x.questionId === questionId) ?? emptyAnswer(questionId);
    return {
      sessionId: recordId,
      questionId,
      score: a.score,
      coveredKeyPoints: a.coveredKeyPoints,
      redFlagsSeen: a.redFlagsSeen,
      probeHandled: a.probeHandled,
      notes: data.notes.filter((n) => n.questionId === questionId).map((n) => ({ atSec: n.atSec, text: n.text, ...(n.by ? { by: n.by } : {}) })),
      flagged: a.flagged,
      skipped: a.skipped,
      skipReason: a.skipReason,
      elapsedSec: elapsedSec[questionId] ?? 0,
      timer: { accumulatedMs: (elapsedSec[questionId] ?? 0) * 1000, runningSince: null },
    };
  });
}

export function toDomainOverall(o: OverallJson): OverallAssessment {
  return { rating: o.rating, recommendation: o.recommendation, rationale: o.rationale };
}

/** Questions a record has scored or skipped (LIVE-3: "Ben has scored it"). */
export function resolvedQuestions(data: Pick<RecordData, 'answers'>): string[] {
  return data.answers.filter((a) => a.skipped || a.score != null).map((a) => a.questionId);
}

// ---------------------------------------------------------------------------------------------
// The shared interview (LIVE-2): timers and moving between questions

export interface SharedTimers {
  timer: TimerJson;
  questionTimers: Record<string, TimerJson>;
}

const STOPPED: TimerJson = { accumulatedMs: 0, runningSince: null };
const qt = (t: SharedTimers, id: string): TimerJson => t.questionTimers[id] ?? STOPPED;

/** Starts the interview: the overall timer and the first question's timer run from `now` (server time). */
export function startTimers(firstQuestionId: string, now: number): SharedTimers {
  return { timer: { accumulatedMs: 0, runningSince: now }, questionTimers: { [firstQuestionId]: { accumulatedMs: 0, runningSince: now } } };
}

/** Moving from one question to another stops the first one's timer and (when running) starts the next one's. */
export function moveTimers(t: SharedTimers, from: string | null, to: string, running: boolean, now: number): SharedTimers {
  const questionTimers = { ...t.questionTimers };
  if (from && from !== to) questionTimers[from] = pauseTimer(qt(t, from), now);
  questionTimers[to] = running ? startTimer(qt(t, to), now) : pauseTimer(qt(t, to), now);
  return { timer: t.timer, questionTimers };
}

/** FLOW-21: pausing stops the overall timer and the current question's; resuming restarts both. */
export function pauseTimers(t: SharedTimers, current: string | null, now: number): SharedTimers {
  const questionTimers = { ...t.questionTimers };
  if (current) questionTimers[current] = pauseTimer(qt(t, current), now);
  return { timer: pauseTimer(t.timer, now), questionTimers };
}

export function resumeTimers(t: SharedTimers, current: string | null, now: number): SharedTimers {
  const questionTimers = { ...t.questionTimers };
  if (current) questionTimers[current] = startTimer(qt(t, current), now);
  return { timer: startTimer(t.timer, now), questionTimers };
}

/** Stops every timer (the interview is complete). */
export function stopAllTimers(t: SharedTimers, now: number): SharedTimers {
  return { timer: pauseTimer(t.timer, now), questionTimers: Object.fromEntries(Object.entries(t.questionTimers).map(([k, v]) => [k, pauseTimer(v, now)])) };
}

/** Seconds spent on each question so far. */
export function questionSeconds(t: Pick<SharedTimers, 'questionTimers'>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(t.questionTimers).map(([k, v]) => [k, Math.floor(elapsedMs(v, now) / 1000)]));
}

/** The question before or after `current` in the set, or null at either end. */
export function adjacentQuestion(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return ids[0] ?? null;
  return ids[i + dir] ?? null;
}

export type MoveOutcome = 'moved' | 'already-there' | 'stale';

/**
 * LIVE-2, HOST-5: a move is "from question A to question B". It applies only when the panel is still
 * on A; when it is already on B (the same move sent twice, or two people pressing Next at the same
 * moment) it changes nothing; anything else is stale, and the sender sees where the panel is now.
 * So two simultaneous Nexts never skip two questions.
 */
export function moveOutcome(current: string | null, from: string, to: string): MoveOutcome {
  if (current === to) return 'already-there';
  if (current === from) return 'moved';
  return 'stale';
}

// ---------------------------------------------------------------------------------------------
// Who is there, who leads, who is still to submit (LIVE-2, LIVE-3, LIVE-4)

/** Screens send a heartbeat this often while open… */
export const HEARTBEAT_MS = 15_000;
/** …and someone counts as "in the interview" for this long after their last one. */
export const PRESENCE_TTL_MS = 45_000;

export function isPresent(seenAt: number | null, serverNow: number): boolean {
  return seenAt != null && serverNow - seenAt <= PRESENCE_TTL_MS;
}

/** "AD" for "Ana Diaz", "B" for "Ben". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * LIVE-4: the interview is complete once someone has submitted and every panel member who joined
 * has submitted. Members who never joined (still expected, or marked "did not take part") do not
 * hold it up. A member sharing someone else's screen follows that record.
 */
export function isComplete(statuses: readonly PanelStatus[]): boolean {
  return statuses.some((s) => s === 'submitted') && !statuses.some((s) => s === 'joined');
}

/** LIVE-4: who the interview is waiting for: people who joined and have not submitted. */
export function waitingFor<T extends { status: PanelStatus; name: string }>(panel: readonly T[]): string[] {
  return panel.filter((p) => p.status === 'joined').map((p) => p.name);
}

/** LIVE-2: what a person's Next and Previous do: the lead moves everyone; anyone else looks on their own. */
export function movesEveryone(state: Pick<LiveState, 'leadUserId' | 'state'>, meId: string, online: boolean): boolean {
  return online && state.leadUserId === meId && (state.state === 'in_progress' || state.state === 'paused');
}

/** The question a person sees: the one they are looking at on their own, else the panel's. */
export function shownQuestion(panelQuestion: string | null, browsing: string | null): string | null {
  return browsing ?? panelQuestion;
}

// ---------------------------------------------------------------------------------------------
// The browser's clock against the server's (RES-2)

export interface ClockSample {
  /** Server time in the response (epoch ms). */
  serverNow: number;
  /** When the request was sent and the response arrived (browser epoch ms). */
  sentAt: number;
  receivedAt: number;
}

/**
 * How far the server's clock is ahead of the browser's, in ms. Each sample's offset assumes the
 * server answered halfway through the round trip; the sample with the shortest round trip is the
 * most precise, so it wins. Timers then show `server time = Date.now() + offset`.
 */
export function clockOffset(samples: readonly ClockSample[]): number {
  let best: ClockSample | null = null;
  for (const s of samples) {
    if (s.receivedAt < s.sentAt) continue;
    if (!best || s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s;
  }
  if (!best) return 0;
  return Math.round(best.serverNow - (best.sentAt + best.receivedAt) / 2);
}
