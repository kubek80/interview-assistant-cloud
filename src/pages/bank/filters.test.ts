import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, activeFilterCount, resultSummary, toQuestionFilter, toggleIn } from './filters';
import { filterQuestions } from '../../domain/plan';
import { DIFFICULTIES, QUESTION_TYPES } from '../../domain/types';
import { makeQuestion } from '../../test/fixtures';

describe('bank filters', () => {
  const qs = [
    makeQuestion({ id: 't-1', categoryId: 'a', difficulty: 'core', type: 'knowledge', text: 'Explain caching' }),
    makeQuestion({ id: 't-2', categoryId: 'b', difficulty: 'expert', type: 'design', text: 'Design a queue' }),
    makeQuestion({ id: 't-3', categoryId: 'a', difficulty: 'advanced', type: 'scenario', text: 'Old one', status: 'retired' }),
  ];

  it('FLOW-2 / BANK-2: maps category, difficulty, type and search to the domain filter', () => {
    const f = { ...EMPTY_FILTERS, categoryId: 'a', difficulties: [], types: [], search: 'cach' };
    expect(filterQuestions(qs, toQuestionFilter(f)).map((q) => q.id)).toEqual(['t-1']);
    const g = { ...EMPTY_FILTERS, types: ['design' as const], difficulties: ['expert' as const] };
    expect(filterQuestions(qs, toQuestionFilter(g)).map((q) => q.id)).toEqual(['t-2']);
  });

  it('BANK-2: retired questions are listed only on the bank screen when asked; never for a plan', () => {
    const f = { ...EMPTY_FILTERS, includeRetired: true };
    expect(filterQuestions(qs, toQuestionFilter(f, { allowRetired: true })).length).toBe(3);
    expect(filterQuestions(qs, toQuestionFilter(f)).length).toBe(2);
  });

  it('counts active filters and toggles values in canonical order', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, categoryId: 'a', search: ' x ', types: ['design'] })).toBe(3);
    expect(toggleIn(['expert'], 'core', DIFFICULTIES)).toEqual(['core', 'expert']);
    expect(toggleIn(['core', 'expert'], 'core', DIFFICULTIES)).toEqual(['expert']);
    expect(toggleIn([], 'design', QUESTION_TYPES)).toEqual(['design']);
  });

  it('BANK-2: result count text', () => {
    expect(resultSummary(50, 50)).toBe('Showing all 50 questions');
    expect(resultSummary(1, 50)).toBe('Showing 1 of 50 questions');
  });
});

