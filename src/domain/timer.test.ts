import { describe, expect, it } from 'vitest';
import { STOPPED_TIMER, elapsedMs, elapsedSec, overallTimerStatus, pauseTimer, questionTimerStatus, startTimer } from './timer';

describe('timer model', () => {
  it('DATA-3: elapsed is accumulatedMs + (now - runningSince)', () => {
    const t = startTimer(STOPPED_TIMER, 1_000);
    expect(t).toEqual({ accumulatedMs: 0, runningSince: 1_000 });
    expect(elapsedMs(t, 4_500)).toBe(3_500);
    expect(elapsedSec({ accumulatedMs: 2_000, runningSince: 10_000 }, 12_999)).toBe(4);
  });

  it('FLOW-21: pausing stops the clock; resuming continues from the accumulated time', () => {
    let t = startTimer(STOPPED_TIMER, 0);
    t = pauseTimer(t, 5_000);
    expect(t).toEqual({ accumulatedMs: 5_000, runningSince: null });
    expect(elapsedMs(t, 100_000)).toBe(5_000);
    t = startTimer(t, 100_000);
    expect(elapsedMs(t, 101_000)).toBe(6_000);
  });

  it('RES-2: timer state is plain data that survives serialisation (reload)', () => {
    const t = startTimer({ accumulatedMs: 7_000, runningSince: null }, 50_000);
    const reloaded = JSON.parse(JSON.stringify(t));
    expect(elapsedMs(reloaded, 53_000)).toBe(10_000);
  });

  it('DATA-3: start and pause are idempotent', () => {
    const t = startTimer(STOPPED_TIMER, 10);
    expect(startTimer(t, 99)).toBe(t);
    expect(pauseTimer(STOPPED_TIMER, 99)).toBe(STOPPED_TIMER);
  });

  it('FLOW-19: per-question timer turns amber at the time estimate and never red', () => {
    expect(questionTimerStatus(179_999, 3)).toBe('normal');
    expect(questionTimerStatus(180_000, 3)).toBe('amber');
    expect(questionTimerStatus(10 * 180_000, 3)).toBe('amber');
  });

  it('FLOW-19: overall timer is amber from 80% of the budget and red when exceeded', () => {
    expect(overallTimerStatus(47 * 60_000, 60)).toBe('normal');
    expect(overallTimerStatus(48 * 60_000, 60)).toBe('amber');
    expect(overallTimerStatus(60 * 60_000, 60)).toBe('amber');
    expect(overallTimerStatus(60 * 60_000 + 1, 60)).toBe('red');
  });
});
