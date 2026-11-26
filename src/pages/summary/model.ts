// Pure helpers for the Summary screen (SUM-1, SUM-2, SUM-6): filter, sort and group the rows.
import type { Recommendation } from '../../domain/types';
import { RECOMMENDATIONS } from '../../domain/types';
import { formatNames } from '../../domain/interviewers';
import type { RoundRow, RoundState } from '../../domain/round';

export type OutcomeFilter = '' | Recommendation | 'split' | 'none';

export interface SummaryFilter {
  /** Matches the candidate's name or initials and the requisition id (case and spaces ignored). */
  text: string;
  trackId: string;
  requisition: string;
  outcome: OutcomeFilter;
  state: RoundState | '';
  /** YYYY-MM-DD, inclusive; '' for open. */
  from: string;
  to: string;
}

export const NO_FILTER: SummaryFilter = { text: '', trackId: '', requisition: '', outcome: '', state: '', from: '', to: '' };

export function isFiltered(f: SummaryFilter): boolean {
  return Object.values(f).some((v) => v !== '');
}

/** SUM-1: the outcome filter: the panel decision, else agreeing recommendations; "split"; "none yet". */
export function outcomeMatches(row: Pick<RoundRow, 'outcome'>, outcome: OutcomeFilter): boolean {
  if (!outcome) return true;
  const o = row.outcome;
  if (outcome === 'none') return o.kind === 'none';
  if (outcome === 'split') return o.kind === 'recommendations' && o.split;
  return o.recommendation === outcome;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function filterRows<R extends RoundRow>(rows: readonly R[], f: SummaryFilter): R[] {
  const needle = norm(f.text);
  return rows.filter(
    (r) =>
      (!needle || norm(r.candidate).includes(needle)) &&
      (!f.trackId || r.trackId === f.trackId) &&
      (!f.requisition || r.requisition === f.requisition) &&
      outcomeMatches(r, f.outcome) &&
      (!f.state || r.state === f.state) &&
      (!f.from || (!!r.date && r.date >= f.from)) &&
      (!f.to || (!!r.date && r.date <= f.to)),
  );
}

export type SortKey = 'candidate' | 'date' | 'interviewers' | 'outcome' | 'score' | 'missing';
export type SortDir = 'asc' | 'desc';

/** The natural first direction of a column: newest, strongest and highest first; names A to Z. */
export const FIRST_DIR: Record<SortKey, SortDir> = { candidate: 'asc', date: 'desc', interviewers: 'asc', outcome: 'desc', score: 'desc', missing: 'asc' };

const STATE_ORDER: Record<RoundState, number> = { waiting: 0, 'no-decision': 1, 'in-progress': 2, 'not-interviewed': 3, decided: 4 };

/**
 * SUM-1: sort by any column. Empty values (no date, no score, no outcome) go last whatever the
 * direction; ties are broken by candidate so the order is stable.
 */
export function sortRows<R extends RoundRow>(rows: readonly R[], key: SortKey, dir: SortDir): R[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r: R): string | number | null => {
    switch (key) {
      case 'candidate':
        return norm(r.candidate);
      case 'date':
        return r.date ? `${r.date} ${r.time ?? ''}` : null;
      case 'interviewers':
        return r.interviewers.length ? norm(formatNames(r.interviewers)) : null;
      case 'outcome':
        return r.outcome.rank;
      case 'score':
        return r.score.pct;
      case 'missing':
        return STATE_ORDER[r.state];
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return sign * (va < vb ? -1 : 1);
    return norm(a.candidate).localeCompare(norm(b.candidate)) || a.ref.localeCompare(b.ref);
  });
}

export interface RowGroup<R> {
  fingerprint: string;
  planName: string;
  trackName: string;
  questionCount: number;
  rows: R[];
}

/** SUM-2: rows that share a question set together, groups in the order their first row appears. */
export function groupBySet<R extends RoundRow>(rows: readonly R[]): RowGroup<R>[] {
  const groups = new Map<string, RowGroup<R>>();
  for (const r of rows) {
    const g = groups.get(r.fingerprint);
    if (g) g.rows.push(r);
    else groups.set(r.fingerprint, { fingerprint: r.fingerprint, planName: r.planName, trackName: r.trackName, questionCount: r.questionCount, rows: [r] });
  }
  return [...groups.values()];
}

/** The count line: how many rows are in each state. */
export function stateCounts(rows: readonly Pick<RoundRow, 'state'>[]): Record<RoundState, number> {
  const c: Record<RoundState, number> = { decided: 0, 'no-decision': 0, waiting: 0, 'in-progress': 0, 'not-interviewed': 0 };
  for (const r of rows) c[r.state]++;
  return c;
}

export const OUTCOME_OPTIONS: Array<{ value: OutcomeFilter; label: string }> = [
  { value: '', label: 'Any outcome' },
  ...RECOMMENDATIONS.map((r) => ({ value: r, label: { strong_hire: 'Strong hire', hire: 'Hire', lean_no_hire: 'Lean no hire', no_hire: 'No hire' }[r] })),
  { value: 'split', label: 'Split recommendations' },
  { value: 'none', label: 'No recommendation yet' },
];

/** Words describing the filters in force, for the report ("all roles", "Hire, from 2026-12-01"). */
export function filterWords(f: SummaryFilter, trackNames: ReadonlyMap<string, string>): string {
  const parts = [
    f.trackId ? (trackNames.get(f.trackId) ?? f.trackId) : '',
    f.requisition,
    f.outcome ? OUTCOME_OPTIONS.find((o) => o.value === f.outcome)!.label : '',
    f.from && f.to ? `${f.from} to ${f.to}` : f.from ? `from ${f.from}` : f.to ? `until ${f.to}` : '',
    f.text.trim() ? `matching “${f.text.trim()}”` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'everything on this device';
}
