// Filter state shared by the Question bank (BANK-2) and Setup (FLOW-2) screens. Pure.
import type { QuestionFilter } from '../../domain/plan';
import type { Difficulty, QuestionType } from '../../domain/types';

export interface FilterState {
  /** Empty string means "all categories". */
  categoryId: string;
  /** Empty means "any difficulty". */
  difficulties: Difficulty[];
  /** Empty means "any type". */
  types: QuestionType[];
  search: string;
  /** Bank screen only: also list retired questions. Never used when building a plan. */
  includeRetired: boolean;
}

export const EMPTY_FILTERS: Readonly<FilterState> = {
  categoryId: '',
  difficulties: [],
  types: [],
  search: '',
  includeRetired: false,
};

/** Converts the screen's filter state to the domain filter (FLOW-2, BANK-2). */
export function toQuestionFilter(f: FilterState, opts: { allowRetired?: boolean } = {}): QuestionFilter {
  return {
    categoryIds: f.categoryId ? [f.categoryId] : [],
    difficulties: f.difficulties,
    types: f.types,
    search: f.search,
    includeRetired: !!opts.allowRetired && f.includeRetired,
  };
}

/** Number of filters that narrow the list (for "Clear filters" and the result summary). */
export function activeFilterCount(f: FilterState): number {
  return (f.categoryId ? 1 : 0) + (f.difficulties.length ? 1 : 0) + (f.types.length ? 1 : 0) + (f.search.trim() ? 1 : 0) + (f.includeRetired ? 1 : 0);
}

/** Adds or removes `x`, keeping the order of `all` (so the result is stable). */
export function toggleIn<T>(xs: readonly T[], x: T, all: readonly T[]): T[] {
  const set = new Set(xs);
  if (set.has(x)) set.delete(x);
  else set.add(x);
  return all.filter((a) => set.has(a));
}

/** "Showing 12 of 50 questions" */
export function resultSummary(shown: number, total: number, noun = 'question'): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return shown === total ? `Showing all ${plural(total)}` : `Showing ${shown} of ${plural(total)}`;
}
