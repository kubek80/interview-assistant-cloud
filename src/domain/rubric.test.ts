import { describe, expect, it } from 'vitest';
import { RUBRIC_LEVELS, effectiveDifficulty, rubricFor, suggestScore } from './rubric';

const t = (covered: number[], total = 4, redFlags: number[] = [], probe = false) => ({
  keyPointCount: total,
  coveredKeyPoints: covered,
  redFlagsSeen: redFlags,
  probeHandled: probe,
});

describe('rubric', () => {
  it('RUB-1: the shared scale has four labelled levels', () => {
    expect(RUBRIC_LEVELS.map((l) => [l.score, l.label])).toEqual([
      [1, 'Poor'],
      [2, 'Partial'],
      [3, 'Solid senior'],
      [4, 'Exceptional'],
    ]);
  });

  it('RUB-2: a rubricOverride replaces the shared description for that level only', () => {
    const levels = rubricFor({ rubricOverride: { '3': 'Explains overlay vs pod subnet trade-offs.' } });
    expect(levels[2].description).toBe('Explains overlay vs pod subnet trade-offs.');
    expect(levels[2].overridden).toBe(true);
    expect(levels[0].description).toBe(RUBRIC_LEVELS[0].description);
    expect(rubricFor({ rubricOverride: null })).toEqual(RUBRIC_LEVELS);
  });

  it('RUB-3: no suggestion until at least one box is ticked', () => {
    expect(suggestScore(t([]))).toBeNull();
  });

  it('RUB-3: any red flag suggests 1, even with every key point', () => {
    expect(suggestScore(t([0, 1, 2, 3], 4, [0], true))).toBe(1);
  });

  it('RUB-3: fewer than 25% of key points suggests 1 (ticking only the probe box counts as a tick)', () => {
    expect(suggestScore(t([], 4, [], true))).toBe(1);
    expect(suggestScore(t([0], 5))).toBe(1); // 20%
  });

  it('RUB-3: 25% to under 60% suggests 2', () => {
    expect(suggestScore(t([0], 4))).toBe(2); // 25%
    expect(suggestScore(t([0, 1], 4))).toBe(2); // 50%
  });

  it('RUB-3: all key points and the probe handled suggests 4', () => {
    expect(suggestScore(t([0, 1, 2, 3], 4, [], true))).toBe(4);
  });

  it('RUB-3: otherwise 3 (60% or more, or all points without the probe)', () => {
    expect(suggestScore(t([0, 1, 2], 5))).toBe(3); // 60%
    expect(suggestScore(t([0, 1, 2, 3], 4))).toBe(3);
    expect(suggestScore(t([0, 1, 2], 4, [], true))).toBe(3);
  });

  it('RUB-3 BANK-15: with the bundled five key points the thresholds are 0-1 of 5 → 1, 2 of 5 → 2, 3-5 of 5 → 3, all 5 plus the probe → 4; any red flag → 1', () => {
    const five = (n: number, probe = false, flags: number[] = []) => suggestScore(t(Array.from({ length: n }, (_, i) => i), 5, flags, probe));
    expect(five(0)).toBeNull(); // nothing ticked: no suggestion
    expect(five(0, true)).toBe(1); // only the probe box
    expect(five(1)).toBe(1); // 20% < 25%
    expect(five(2)).toBe(2); // 40%
    expect(five(3)).toBe(3); // 60% is not "fewer than 60%"
    expect(five(4)).toBe(3);
    expect(five(5)).toBe(3); // all five without the probe
    expect(five(4, true)).toBe(3);
    expect(five(5, true)).toBe(4);
    expect(five(5, true, [0])).toBe(1);
    expect(five(1, false, [3])).toBe(1);
  });

  it('RUB-6: behavioural questions are treated as core', () => {
    expect(effectiveDifficulty({ type: 'behavioural', difficulty: 'expert' })).toBe('core');
    expect(effectiveDifficulty({ type: 'design', difficulty: 'expert' })).toBe('expert');
  });
});
