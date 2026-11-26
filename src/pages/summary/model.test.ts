// SUM-1, SUM-2, SUM-6: filtering, sorting and grouping the Summary rows. Pure.
import { describe, expect, it } from 'vitest';
import { NO_FILTER, filterRows, filterWords, groupBySet, isFiltered, outcomeMatches, sortRows, stateCounts } from './model';
import type { RoundRow } from '../../domain/round';

function row(p: Partial<RoundRow> & { ref: string }): RoundRow {
  return {
    panelKey: p.ref,
    candidateKey: p.ref,
    candidate: p.ref,
    name: p.ref,
    requisition: '',
    trackId: 'qa',
    trackName: 'QA',
    fingerprint: 'fp1',
    planName: 'Set 1',
    questionCount: 14,
    date: null,
    time: null,
    interviewers: [],
    attendance: { expected: [], submitted: [], toCome: [] },
    judgements: [],
    decision: null,
    outcome: { kind: 'none', recommendation: null, tally: [], split: false, text: '', rank: null },
    score: { source: 'none', pct: null, band: null, insufficientEvidence: false, capped: false, members: 0, spread: null, spreadFlag: false, label: '' },
    strengths: [],
    concerns: [],
    state: 'not-interviewed',
    missing: [],
    hidden: 0,
    summaryText: '',
    ...p,
  };
}
const rec = (r: 'hire' | 'no_hire', rank: number, kind: 'decision' | 'recommendations' = 'recommendations', split = false) => ({ kind, recommendation: split ? null : r, tally: [], split, text: r, rank });

const rows = [
  row({ ref: 'Ana Diaz · REQ-1', requisition: 'REQ-1', date: '2026-12-01', outcome: rec('hire', 3, 'decision'), score: { ...row({ ref: 'x' }).score, pct: 70 }, state: 'decided' }),
  row({ ref: 'Bo Li', date: '2026-12-03', outcome: rec('hire', 2.5, 'recommendations', true), score: { ...row({ ref: 'x' }).score, pct: 55 }, state: 'waiting', fingerprint: 'fp2', planName: 'Set 2' }),
  row({ ref: 'Chen Wu', date: null, trackId: 'web', state: 'not-interviewed' }),
  row({ ref: 'Dee Ng', date: '2026-11-28', outcome: rec('no_hire', 1), score: { ...row({ ref: 'x' }).score, pct: 30 }, state: 'no-decision' }),
];

describe('Summary screen model', () => {
  it('SUM-1: search ignores case and spaces; filters by role, requisition, outcome, state and date range', () => {
    expect(filterRows(rows, { ...NO_FILTER, text: '  ana   DIAZ ' }).map((r) => r.ref)).toEqual(['Ana Diaz · REQ-1']);
    expect(filterRows(rows, { ...NO_FILTER, text: 'req-1' })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTER, trackId: 'web' }).map((r) => r.ref)).toEqual(['Chen Wu']);
    expect(filterRows(rows, { ...NO_FILTER, requisition: 'REQ-1' })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTER, outcome: 'hire' }).map((r) => r.ref)).toEqual(['Ana Diaz · REQ-1']);
    expect(filterRows(rows, { ...NO_FILTER, outcome: 'split' }).map((r) => r.ref)).toEqual(['Bo Li']);
    expect(filterRows(rows, { ...NO_FILTER, outcome: 'none' }).map((r) => r.ref)).toEqual(['Chen Wu']);
    expect(filterRows(rows, { ...NO_FILTER, state: 'waiting' }).map((r) => r.ref)).toEqual(['Bo Li']);
    expect(filterRows(rows, { ...NO_FILTER, from: '2026-11-30', to: '2026-12-02' }).map((r) => r.ref)).toEqual(['Ana Diaz · REQ-1']);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(outcomeMatches(rows[3], 'no_hire')).toBe(true);
  });

  it('SUM-1: sort by any column; empty values last whatever the direction; ties by candidate', () => {
    expect(sortRows(rows, 'date', 'desc').map((r) => r.ref)).toEqual(['Bo Li', 'Ana Diaz · REQ-1', 'Dee Ng', 'Chen Wu']);
    expect(sortRows(rows, 'date', 'asc').map((r) => r.ref)).toEqual(['Dee Ng', 'Ana Diaz · REQ-1', 'Bo Li', 'Chen Wu']);
    expect(sortRows(rows, 'score', 'desc').map((r) => r.ref)).toEqual(['Ana Diaz · REQ-1', 'Bo Li', 'Dee Ng', 'Chen Wu']);
    expect(sortRows(rows, 'outcome', 'desc').map((r) => r.ref)).toEqual(['Ana Diaz · REQ-1', 'Bo Li', 'Dee Ng', 'Chen Wu']);
    expect(sortRows(rows, 'candidate', 'desc').map((r) => r.ref)).toEqual(['Dee Ng', 'Chen Wu', 'Bo Li', 'Ana Diaz · REQ-1']);
    expect(sortRows(rows, 'missing', 'asc').map((r) => r.state)).toEqual(['waiting', 'no-decision', 'not-interviewed', 'decided']);
  });

  it('SUM-2: rows that share a question set are grouped, in the order the sorted rows first show them', () => {
    const g = groupBySet(sortRows(rows, 'date', 'desc'));
    expect(g.map((x) => [x.planName, x.rows.map((r) => r.ref)])).toEqual([
      ['Set 2', ['Bo Li']],
      ['Set 1', ['Ana Diaz · REQ-1', 'Dee Ng', 'Chen Wu']],
    ]);
  });

  it('SUM-1: the count line and the words describing the filters', () => {
    expect(stateCounts(rows)).toEqual({ decided: 1, 'no-decision': 1, waiting: 1, 'in-progress': 0, 'not-interviewed': 1 });
    expect(filterWords(NO_FILTER, new Map())).toBe('everything on this device');
    expect(filterWords({ ...NO_FILTER, trackId: 'qa', outcome: 'hire', from: '2026-12-01' }, new Map([['qa', 'QA']]))).toBe('QA, Hire, from 2026-12-01');
  });

  it('SUM-6: fifty rows filter, sort and group in well under a frame', () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ ref: `C${i}`, date: `2026-12-${String((i % 28) + 1).padStart(2, '0')}`, fingerprint: `fp${i % 3}`, score: { ...rows[0].score, pct: i } }));
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) groupBySet(sortRows(filterRows(many, { ...NO_FILTER, text: 'c' }), 'score', 'desc'));
    expect((performance.now() - t0) / 20).toBeLessThan(16);
  });
});
