// DATA-3 / RES-2 timer model: time is derived from stored timestamps, never from in-memory counters.
import type { TimerState } from './types';

export const STOPPED_TIMER: TimerState = { accumulatedMs: 0, runningSince: null };

export function isRunning(t: TimerState): boolean {
  return t.runningSince != null;
}

export function startTimer(t: TimerState, now: number): TimerState {
  return t.runningSince != null ? t : { accumulatedMs: t.accumulatedMs, runningSince: now };
}

export function pauseTimer(t: TimerState, now: number): TimerState {
  return t.runningSince == null ? t : { accumulatedMs: elapsedMs(t, now), runningSince: null };
}

export function elapsedMs(t: TimerState, now: number): number {
  return t.accumulatedMs + (t.runningSince != null ? Math.max(0, now - t.runningSince) : 0);
}

export function elapsedSec(t: TimerState, now: number): number {
  return Math.floor(elapsedMs(t, now) / 1000);
}

export type TimerStatus = 'normal' | 'amber' | 'red';

/** FLOW-19: per-question timer turns amber once the time estimate is reached. Never red. */
export function questionTimerStatus(elapsed: number, timeMin: number): TimerStatus {
  return elapsed >= timeMin * 60_000 ? 'amber' : 'normal';
}

/** FLOW-19: overall timer amber at 80% of the budget, red once the budget is exceeded. */
export function overallTimerStatus(elapsed: number, budgetMin: number): TimerStatus {
  const budgetMs = budgetMin * 60_000;
  if (elapsed > budgetMs) return 'red';
  if (elapsed >= budgetMs * 0.8) return 'amber';
  return 'normal';
}

export const TIMER_STATUS_LABEL: Record<TimerStatus, string> = {
  normal: 'On time',
  amber: 'Nearly out of time',
  red: 'Over time',
};
