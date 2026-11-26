import { describe, expect, it } from 'vitest';
import { blindedCount, sortComparisonRows } from './model';

const row = (key: string, name: string, pct: number | null) => ({ candidateKey: key, session: { interviewer: { name } } as never, scorecard: { overallPct: pct } });

describe('Comparison helpers', () => {
  const rows = [row('AA|', 'Ann', 60), row('BB|', 'Bob', null), row('CC|', 'Cy', 82.4), row('DD|', 'Di', 60)];

  it('FLOW-30: sorts by unrounded overall percentage, highest first by default, with no-score rows last', () => {
    expect(sortComparisonRows(rows, 'overall', 'desc').map((r) => r.candidateKey)).toEqual(['CC|', 'AA|', 'DD|', 'BB|']);
    expect(sortComparisonRows(rows, 'overall', 'asc').map((r) => r.candidateKey)).toEqual(['AA|', 'DD|', 'CC|', 'BB|']);
  });

  it('FLOW-30: can sort by candidate key; the input is not mutated', () => {
    expect(sortComparisonRows(rows, 'candidate', 'desc').map((r) => r.candidateKey)).toEqual(['DD|', 'CC|', 'BB|', 'AA|']);
    expect(rows[0].candidateKey).toBe('AA|');
  });

  it('FLOW-27: counts submitted sessions held back by blind scoring', () => {
    expect(blindedCount({ submittedCount: 5 }, 3)).toBe(2);
    expect(blindedCount({ submittedCount: 2 }, 2)).toBe(0);
    expect(blindedCount(undefined, 2)).toBe(0);
  });
});
