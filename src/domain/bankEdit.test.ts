import { describe, expect, it } from 'vitest';
import {
  categoryIdFor,
  changedVersionedFields,
  compareVersions,
  defaultTimeMin,
  draftFromQuestion,
  editBumpsVersion,
  emptyDraft,
  offersBehaviouralStartingItems,
  nextQuestionNumber,
  normaliseDraft,
  suggestNextVersion,
  trackVersionProblem,
  validateQuestionDraft,
  withBehaviouralStartingItems,
} from './bankEdit';
import { BEHAVIOURAL_STARTING_KEY_POINTS, BEHAVIOURAL_STARTING_RED_FLAGS } from './rubric';
import { makeQuestion } from '../test/fixtures';
import type { Question } from './types';

describe('question bank editing rules', () => {
  const q = makeQuestion({ id: 't-1', categoryId: 't-cat', difficulty: 'advanced', rubricOverride: null });

  it('BANK-11: text, description, difficulty, type, lists and rubric descriptions raise the version; category, time and status do not', () => {
    const d = draftFromQuestion(q);
    expect(editBumpsVersion(q, d)).toBe(false);
    expect(editBumpsVersion(q, { ...d, text: 'Something else' })).toBe(true);
    expect(editBumpsVersion(q, { ...d, description: 'Another steer' })).toBe(true);
    expect(editBumpsVersion(q, { ...d, difficulty: 'expert' })).toBe(true);
    expect(editBumpsVersion(q, { ...d, type: 'scenario' })).toBe(true);
    expect(editBumpsVersion(q, { ...d, lookFor: [...d.lookFor, 'e'] })).toBe(true);
    expect(editBumpsVersion(q, { ...d, lookFor: [...d.lookFor].reverse() })).toBe(true); // order matters: ticks are by index
    expect(editBumpsVersion(q, { ...d, redFlags: ['y'] })).toBe(true);
    expect(editBumpsVersion(q, { ...d, probes: ['how?'] })).toBe(true);
    expect(editBumpsVersion(q, { ...d, rubricOverride: { '4': 'Outstanding for this one' } })).toBe(true);
    // Not versioned:
    const moved: Question = { ...q, categoryId: 'y', timeMin: 9, status: 'retired' };
    expect(editBumpsVersion(q, moved)).toBe(false);
    // Whitespace, blank list rows and an empty rubric override are not changes.
    expect(editBumpsVersion(q, { ...d, text: `  ${d.text} `, lookFor: [...d.lookFor, '  '], rubricOverride: { '1': ' ' } })).toBe(false);
    expect(changedVersionedFields(q, { ...d, text: 'x', probes: ['p'] })).toEqual(['text', 'probes']);
  });

  it('BANK-11: a missing description (old snapshot) equals an empty one', () => {
    const old = { ...q, description: undefined as unknown as string };
    expect(editBumpsVersion(old, { ...q, description: '' })).toBe(false);
    expect(editBumpsVersion(old, { ...q, description: 'New' })).toBe(true);
  });

  it('BANK-10: new questions take the next free number; numbers are never reused', () => {
    expect(nextQuestionNumber([1, 2, 3])).toBe(4);
    expect(nextQuestionNumber([1, 2, 50])).toBe(51);
    expect(nextQuestionNumber([1, 2], 55)).toBe(56);
    expect(nextQuestionNumber([])).toBe(1);
  });

  it('BANK-5 BANK-10: the time estimate comes from the table; behavioural is core', () => {
    expect(defaultTimeMin('knowledge', 'core')).toBe(3);
    expect(defaultTimeMin('knowledge', 'expert')).toBe(5);
    expect(defaultTimeMin('scenario', 'advanced')).toBe(5);
    expect(defaultTimeMin('design', 'expert')).toBe(8);
    expect(defaultTimeMin('behavioural', 'expert')).toBe(4);
    expect(emptyDraft('c').timeMin).toBe(3);
  });

  it('BANK-9 BANK-1: problems are reported by field and nothing invalid passes', () => {
    const e = validateQuestionDraft({ ...emptyDraft(), lookFor: ['', ' '], probes: ['why'] }, ['t-cat']);
    expect(Object.keys(e).sort()).toEqual(['categoryId', 'description', 'lookFor', 'redFlags', 'text']);
    const ok = { ...emptyDraft('t-cat'), text: 'Q?', description: 'What we ask', lookFor: ['a'], redFlags: ['b'], probes: ['c'] };
    expect(validateQuestionDraft(ok, ['t-cat'])).toEqual({});
    expect(validateQuestionDraft({ ...ok, timeMin: 0 }, ['t-cat']).timeMin).toBeTruthy();
    expect(validateQuestionDraft({ ...ok, timeMin: 2.5 }, ['t-cat']).timeMin).toBeTruthy();
    expect(validateQuestionDraft({ ...ok, lookFor: ['a', 'A'] }, ['t-cat']).lookFor).toMatch(/twice/);
    expect(validateQuestionDraft(ok, ['other']).categoryId).toBeTruthy();
  });

  it('RUB-6 BANK-9: a behavioural question is saved as core', () => {
    const n = normaliseDraft({ ...emptyDraft('c'), type: 'behavioural', difficulty: 'expert' });
    expect(n.difficulty).toBe('core');
  });

  it('RUB-5 BANK-9 BANK-15: a new behavioural question is offered the four themes and three red-flag themes as full-sentence starting items, never over items already written', () => {
    expect(BEHAVIOURAL_STARTING_KEY_POINTS.map((s) => s.split(':')[0])).toEqual(['Specific situation', 'Own actions', 'Measurable result', 'Reflection']);
    expect(BEHAVIOURAL_STARTING_RED_FLAGS.join(' ')).toMatch(/hypothetical.*Blames others.*how it ended/is);
    for (const s of [...BEHAVIOURAL_STARTING_KEY_POINTS, ...BEHAVIOURAL_STARTING_RED_FLAGS]) expect(s.split(' ').length).toBeGreaterThanOrEqual(8);
    // Offered while the key points are empty, for behavioural questions only.
    expect(offersBehaviouralStartingItems('behavioural', [''])).toBe(true);
    expect(offersBehaviouralStartingItems('behavioural', ['Led the change'])).toBe(false);
    expect(offersBehaviouralStartingItems('knowledge', [''])).toBe(false);
    // Inserted first, then the question's own items, without repeating one already there.
    const r = withBehaviouralStartingItems(['', ''], ['Cannot say how it ended or what result it had.', 'Vague']);
    expect(r.lookFor).toEqual([...BEHAVIOURAL_STARTING_KEY_POINTS]);
    expect(r.redFlags).toEqual([...BEHAVIOURAL_STARTING_RED_FLAGS, 'Vague']);
  });

  it('BANK-12: category ids are <trackId>-<slug of the name>', () => {
    expect(categoryIdFor('aks', 'Identity & access')).toBe('aks-identity-access');
    expect(categoryIdFor('qa', 'CI/CD')).toBe('qa-ci-cd');
    expect(categoryIdFor('qa', '!!!')).toBe('qa-category');
  });

  it('BANK-4 BANK-6: export suggests the next track version and refuses an older or malformed one', () => {
    const nov = new Date(2026, 10, 24);
    expect(suggestNextVersion('2026.11', nov)).toBe('2026.11.1');
    expect(suggestNextVersion('2026.11.1', nov)).toBe('2026.11.2');
    expect(suggestNextVersion('2026.10.3', nov)).toBe('2026.11');
    expect(suggestNextVersion('nonsense', nov)).toBe('2026.11');
    expect(compareVersions('2026.11.2', '2026.11')).toBe(1);
    expect(compareVersions('2026.11', '2026.11.0')).toBe(0);
    expect(compareVersions('2026.12', '2026.11.9')).toBe(1);
    expect(trackVersionProblem('2026.11.1', '2026.11')).toBeNull();
    expect(trackVersionProblem('2026.11', '2026.11')).toBeNull();
    expect(trackVersionProblem('2026.10', '2026.11')).toMatch(/later/);
    expect(trackVersionProblem('2026.13', '2026.11')).toMatch(/year.month/);
    expect(trackVersionProblem('2026.11.0', '2026.11')).toMatch(/year.month/);
  });
});
