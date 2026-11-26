// Pure helpers for the live interview screen (FLOW-13..23, RUB-3, A11Y-4, AUD-4). No React, no DB.
import { answerStatus, type AnswerStatus } from '../../ui/Badge';
import { scoreLabel } from '../../domain/rubric';
import { needsNote } from '../../domain/validation';
import { TIMER_STATUS_LABEL, type TimerStatus } from '../../domain/timer';
import type { Answer, InterviewPlan, NoteEntry, Question, Score, Session } from '../../domain/types';

// ---------------------------------------------------------------------------------------------
// RUB-3: suggested score with the reason (which rule matched).

export interface SuggestionExplanation {
  score: Score;
  /** One line saying which RUB-3 rule matched, e.g. "3 of 5 key points (60%) without the probe". */
  reason: string;
}

type TickState = Pick<Answer, 'coveredKeyPoints' | 'redFlagsSeen' | 'probeHandled'>;

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

/**
 * RUB-3: the first matching rule, with a one-line explanation. Null until at least one box has been
 * ticked. Mirrors domain/rubric `suggestScore` (the tests check that both always agree).
 */
export function explainSuggestion(question: Pick<Question, 'lookFor'>, answer: TickState | null | undefined): SuggestionExplanation | null {
  if (!answer) return null;
  const total = question.lookFor.length;
  const covered = new Set(answer.coveredKeyPoints).size;
  const flags = answer.redFlagsSeen.length;
  if (covered === 0 && flags === 0 && !answer.probeHandled) return null;
  if (flags > 0) return { score: 1, reason: `${flags === 1 ? 'A red flag was' : `${flags} red flags were`} ticked.` };
  const ratio = total > 0 ? covered / total : 1;
  const of = total > 0 ? `${covered} of ${total} key points (${pct(covered, total)})` : 'No key points listed';
  if (ratio < 0.25) return { score: 1, reason: `${of}: fewer than 25%.` };
  if (ratio < 0.6) return { score: 2, reason: `${of}: fewer than 60%.` };
  if (ratio >= 1 && answer.probeHandled) return { score: 4, reason: `All ${total} key points, and the probe was handled without help.` };
  if (ratio >= 1) return { score: 3, reason: `All ${total} key points, but the probe is not ticked as handled without help.` };
  return { score: 3, reason: `${of}: at least 60% but not all.` };
}

// ---------------------------------------------------------------------------------------------
// FLOW-20: progress list.

export interface ProgressItem {
  questionId: string;
  /** 1-based position in the plan. */
  position: number;
  status: AnswerStatus;
  score: Score | null;
  flagged: boolean;
  needsNote: boolean;
  /** Spoken/visible summary, e.g. "Scored 4, needs a note, flagged". */
  summary: string;
}

export function progressItems(plan: Pick<InterviewPlan, 'questions'>, answers: readonly Answer[]): ProgressItem[] {
  const byQ = new Map(answers.map((a) => [a.questionId, a]));
  return plan.questions.map((q, i) => {
    const a = byQ.get(q.id);
    const status = answerStatus(a);
    const score = status === 'scored' ? (a!.score as Score) : null;
    const flagged = !!a?.flagged;
    const note = needsNote(a);
    const parts = [status === 'scored' ? `Scored ${score} (${scoreLabel(score!)})` : status === 'skipped' ? 'Skipped' : 'Unanswered'];
    if (note) parts.push('needs a note');
    if (flagged) parts.push('flagged');
    return { questionId: q.id, position: i + 1, status, score, flagged, needsNote: note, summary: parts.join(', ') };
  });
}

/** Counts for the progress summary line ("6 of 10 resolved"). */
export function progressCounts(items: readonly ProgressItem[]) {
  return {
    total: items.length,
    scored: items.filter((i) => i.status === 'scored').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    resolved: items.filter((i) => i.status !== 'unanswered').length,
    flagged: items.filter((i) => i.flagged).length,
    needsNote: items.filter((i) => i.needsNote).length,
  };
}

// ---------------------------------------------------------------------------------------------
// A11Y-4: announce a timer *state change* once; never the ticking.

export interface TimerSnapshot {
  questionId: string | null;
  overall: TimerStatus;
  question: TimerStatus;
  paused: boolean;
}

/**
 * Message to announce when a timer changes state, or null. Moving to another question (whose timer
 * may already be amber) and pausing/resuming are not timer-state changes and are not announced here.
 */
export function timerChangeAnnouncement(prev: TimerSnapshot | null, next: TimerSnapshot): string | null {
  if (!prev) return null;
  const msgs: string[] = [];
  if (prev.overall !== next.overall) {
    msgs.push(
      next.overall === 'red'
        ? 'Overall timer: over time. The time budget has been exceeded.'
        : next.overall === 'amber'
          ? 'Overall timer: nearly out of time. 80% of the time budget is used.'
          : `Overall timer: ${TIMER_STATUS_LABEL[next.overall].toLowerCase()}.`,
    );
  }
  if (prev.questionId === next.questionId && prev.question !== next.question && next.question === 'amber') {
    msgs.push('Question timer: the time estimate for this question has been reached.');
  }
  return msgs.length ? msgs.join(' ') : null;
}

// ---------------------------------------------------------------------------------------------
// AUD-4: describe an amendment before asking for the reason.

/** A note while an amendment is being drafted: `orig` is its index in the saved notes, or null when new. */
export interface DraftNote extends NoteEntry {
  orig: number | null;
}

export interface AnswerDraft {
  score: Score | null;
  notes: DraftNote[];
}

const scoreText = (s: Score | null) => (s == null ? 'no score' : `${s} (${scoreLabel(s)})`);

export function draftFromAnswer(answer: Pick<Answer, 'score' | 'notes'>): AnswerDraft {
  return { score: answer.score, notes: answer.notes.map((n, i) => ({ ...n, orig: i })) };
}

/** The saved form of a draft's notes: trimmed, empty entries dropped. */
export function draftNotes(draft: AnswerDraft): NoteEntry[] {
  // PANEL-3: a note keeps who made it.
  return draft.notes.map((n) => ({ atSec: n.atSec, text: n.text.trim(), ...(n.by ? { by: n.by } : {}) })).filter((n) => n.text.length > 0);
}

/**
 * AUD-4: human-readable list of what an amendment changes, shown before the reason is asked for,
 * e.g. ["Score: 3 (Solid senior) → 4 (Exceptional)", "Note 2 edited"]. Empty means no change.
 */
export function describeAnswerAmendment(before: Pick<Answer, 'score' | 'notes'>, draft: AnswerDraft): string[] {
  const out: string[] = [];
  if (before.score !== draft.score) out.push(`Score: ${scoreText(before.score)} → ${scoreText(draft.score)}`);
  const kept = draft.notes.filter((n) => n.text.trim());
  before.notes.forEach((b, i) => {
    const d = kept.find((n) => n.orig === i);
    if (!d) out.push(`Note ${i + 1} deleted: “${truncate(b.text)}”`);
    else if (d.text.trim() !== b.text) out.push(`Note ${i + 1} edited: “${truncate(d.text)}”`);
  });
  kept.filter((n) => n.orig == null).forEach((n) => out.push(`Note added: “${truncate(n.text)}”`));
  return out;
}

function truncate(s: string, max = 60): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------------------------
// KEY-1: the shortcut list (shown in the "?" dialog and used for hints).

export const SHORTCUTS: ReadonlyArray<{ keys: string[]; action: string }> = [
  { keys: ['1', '2', '3', '4'], action: 'Set the score' },
  { keys: ['N'], action: 'Next question' },
  { keys: ['P'], action: 'Previous question' },
  { keys: ['F'], action: 'Flag or unflag the question' },
  { keys: ['S'], action: 'Skip the question (asks for a reason)' },
  { keys: ['C'], action: 'Toggle the candidate view' },
  { keys: ['/'], action: 'Focus the notes field' },
  { keys: ['Esc'], action: 'Leave the notes field or close a dialog' },
  { keys: ['?'], action: 'Show this list' },
];

/**
 * Which KEY-1 shortcuts are live in a given screen state. In the candidate view only navigation and
 * the toggle work, so nothing invisible (scores, skip dialog with its reason) happens while the
 * candidate is looking at the screen. A read-only (submitted) record only navigates.
 */
export function activeShortcutKeys(mode: { state: 'planned' | 'live' | 'readonly'; candidateView: boolean }): string[] {
  if (mode.state === 'planned') return ['?'];
  if (mode.candidateView) return ['n', 'p', 'c', '?'];
  if (mode.state === 'readonly') return ['n', 'p', 'c', '?'];
  return ['1', '2', '3', '4', 'n', 'p', 'f', 's', 'c', '/', 'Escape', '?'];
}

// ---------------------------------------------------------------------------------------------
// FLOW-11: candidate view.

export type CandidateDisplay = { kind: 'question'; position: number; total: number; text: string } | { kind: 'waiting'; message: string };

/**
 * FLOW-11: what the candidate may see. Only the question number and text while the interview is
 * running; a neutral message otherwise. Nothing about key points, red flags, probes, scores or notes.
 */
export function candidateDisplay(
  session: Pick<Session, 'state' | 'currentQuestionId' | 'origin'> | null | undefined,
  plan: Pick<InterviewPlan, 'questions'> | null | undefined,
): CandidateDisplay {
  if (!session || !plan || session.origin !== 'local') return { kind: 'waiting', message: 'There is nothing to show here.' };
  if (session.state === 'planned') return { kind: 'waiting', message: 'The interview will begin shortly.' };
  if (session.state === 'paused') return { kind: 'waiting', message: 'The interview is paused. We will continue shortly.' };
  if (session.state === 'submitted') return { kind: 'waiting', message: 'The interview has finished. Thank you.' };
  const index = plan.questions.findIndex((q) => q.id === session.currentQuestionId);
  if (index < 0) return { kind: 'waiting', message: 'The interview will begin shortly.' };
  return { kind: 'question', position: index + 1, total: plan.questions.length, text: plan.questions[index].text };
}

// ---------------------------------------------------------------------------------------------
// UX-6: the finish step summarises what is left instead of listing one row per question.

/** "3", "3 and 5", "3-6 and 9", "2, 4 and 6-9": question positions written as ranges. */
export function formatPositions(positions: readonly number[]): string {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    // Two in a row read better as "3 and 4" than "3-4".
    if (j === i + 1) parts.push(String(sorted[i]), String(sorted[j]));
    else parts.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface FinishSummary {
  /** Questions neither scored nor skipped, in interview order. */
  unresolved: Array<{ questionId: string; position: number }>;
  /** Questions scored 1 or 4 without a note (FLOW-16). */
  needsNote: Array<{ questionId: string; position: number; score: Score }>;
  /** Number of questions with any problem. */
  questionCount: number;
}

export function finishSummary(plan: Pick<InterviewPlan, 'questions'>, answers: readonly Answer[]): FinishSummary {
  const byQ = new Map(answers.map((a) => [a.questionId, a]));
  const unresolved: FinishSummary['unresolved'] = [];
  const notes: FinishSummary['needsNote'] = [];
  plan.questions.forEach((q, i) => {
    const a = byQ.get(q.id);
    if (!a || (!a.skipped && a.score == null)) unresolved.push({ questionId: q.id, position: i + 1 });
    else if (needsNote(a)) notes.push({ questionId: q.id, position: i + 1, score: a.score as Score });
  });
  return { unresolved, needsNote: notes, questionCount: unresolved.length + notes.length };
}

/** "Not scored or skipped yet: questions 4–14." */
export function unresolvedSentence(unresolved: FinishSummary['unresolved']): string {
  const where = formatPositions(unresolved.map((u) => u.position));
  return `Not scored or skipped yet: question${unresolved.length === 1 ? '' : 's'} ${where}.`;
}

/** UX-5: "Senior Platform Engineer (AKS with Azure)" → "AKS with Azure", the part that tells the roles apart, for the compact top bar. */
export function shortRole(name: string): string {
  return /\(([^)]+)\)\s*$/.exec(name)?.[1]?.trim() || name;
}
