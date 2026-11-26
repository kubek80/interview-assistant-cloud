import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTAS,
  DEFAULT_TIME_BUDGET_MIN,
  KNOWLEDGE_QUOTA_RANGE,
  TIME_ESTIMATES,
  candidateKey,
  canonicalJson,
  categoryCoverage,
  defaultRetentionDate,
  drawRandom,
  filterQuestions,
  formatCandidateKey,
  planFingerprint,
  timeMeter,
} from './plan';
import { sha256Hex } from './sha256';
import { makeCategory, makePlan, makeQuestion, workedExamplePlan } from '../test/fixtures';
import type { Question, QuestionType } from './types';

function seededRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const cats = ['a', 'b', 'c', 'd'].map((id) => makeCategory({ id }));
const pool: Question[] = [];
let n = 1;
for (const c of cats)
  for (const type of ['knowledge', 'knowledge', 'knowledge', 'knowledge', 'scenario', 'design', 'behavioural'] as QuestionType[])
    pool.push(makeQuestion({ id: `t-${n}`, number: n++, categoryId: c.id, type, difficulty: n % 3 ? 'core' : 'advanced' }));

describe('plan building', () => {
  it('FLOW-3: default quotas are 9 knowledge (8-10), 2 scenario, 1 design, 2 behavioural', () => {
    expect(DEFAULT_QUOTAS).toEqual({ knowledge: 9, scenario: 2, design: 1, behavioural: 2 });
    expect(KNOWLEDGE_QUOTA_RANGE).toEqual([8, 10]);
  });

  it('FLOW-4: default time budget is 60 minutes', () => {
    expect(DEFAULT_TIME_BUDGET_MIN).toBe(60);
  });

  it('FLOW-3: a random draw meets every quota and spreads picks across categories', () => {
    for (let seed = 1; seed < 20; seed++) {
      const { questions, unmet } = drawRandom(pool, DEFAULT_QUOTAS, seededRng(seed));
      expect(unmet).toEqual([]);
      expect(questions).toHaveLength(14);
      const byType = (t: QuestionType) => questions.filter((q) => q.type === t).length;
      expect([byType('knowledge'), byType('scenario'), byType('design'), byType('behavioural')]).toEqual([9, 2, 1, 2]);
      const perCat = cats.map((c) => questions.filter((q) => q.categoryId === c.id).length);
      expect(Math.max(...perCat) - Math.min(...perCat)).toBeLessThanOrEqual(1);
      expect(new Set(questions.map((q) => q.id)).size).toBe(14);
    }
  });

  it('FLOW-3: a draw never exceeds what the filters allow and reports unmet quotas', () => {
    const filtered = filterQuestions(pool, { categoryIds: ['a'] });
    const { questions, unmet } = drawRandom(filtered, DEFAULT_QUOTAS, seededRng(3));
    expect(questions.every((q) => q.categoryId === 'a')).toBe(true);
    expect(unmet).toEqual([
      { type: 'knowledge', wanted: 9, got: 4 },
      { type: 'scenario', wanted: 2, got: 1 },
      { type: 'behavioural', wanted: 2, got: 1 },
    ]);
  });

  it('FLOW-3: retired questions are never drawn', () => {
    const withRetired = pool.map((q) => (q.type === 'design' ? { ...q, status: 'retired' as const } : q));
    const { questions, unmet } = drawRandom(withRetired, DEFAULT_QUOTAS, seededRng(5));
    expect(questions.some((q) => q.type === 'design')).toBe(false);
    expect(unmet).toEqual([{ type: 'design', wanted: 1, got: 0 }]);
  });

  it('FLOW-2, BANK-2: filters by category, difficulty, type and search text; retired hidden by default', () => {
    expect(filterQuestions(pool, { types: ['design'] })).toHaveLength(4);
    expect(filterQuestions(pool, { difficulties: ['advanced'] }).every((q) => q.difficulty === 'advanced')).toBe(true);
    expect(filterQuestions(pool, { search: 'QUESTION T-12' }).map((q) => q.id)).toEqual(['t-12']);
    const retired = [{ ...pool[0], status: 'retired' as const }];
    expect(filterQuestions(retired, {})).toHaveLength(0);
    expect(filterQuestions(retired, { includeRetired: true })).toHaveLength(1);
  });

  it('FLOW-4: the time meter sums estimates and warns when over budget', () => {
    const qs = [makeQuestion({ id: 'x-1', timeMin: 30 }), makeQuestion({ id: 'x-2', timeMin: 31 })];
    expect(timeMeter(qs, 60)).toEqual({ totalMin: 61, budgetMin: 60, ratio: 61 / 60, over: true });
    expect(timeMeter(qs.slice(0, 1), 60).over).toBe(false);
  });

  it('BANK-5: time estimate table', () => {
    expect(TIME_ESTIMATES.knowledge).toEqual({ core: 3, advanced: 4, expert: 5 });
    expect(TIME_ESTIMATES.design.expert).toBe(8);
    expect(TIME_ESTIMATES.behavioural).toEqual({ core: 4 });
  });

  it('FLOW-5: category coverage counts selected questions per category, including zero', () => {
    const cov = categoryCoverage(cats, [pool[0], pool[1], pool[8]]);
    expect(cov.map((c) => c.count)).toEqual([2, 1, 0, 0]);
  });

  it('FLOW-7, PRIV-5: retention date defaults to 90 days ahead', () => {
    expect(defaultRetentionDate(new Date(2026, 0, 1))).toBe('2026-04-01');
  });

  it('FLOW-29: candidate key is initials plus requisition id, case-insensitive', () => {
    expect(candidateKey({ initials: 'ab', requisitionId: 'req-1' })).toBe(candidateKey({ initials: 'AB', requisitionId: 'REQ-1 ' }));
    expect(candidateKey({ initials: 'AB', requisitionId: null })).not.toBe(candidateKey({ initials: 'AB', requisitionId: 'R' }));
  });
});

describe('plan fingerprint', () => {
  it('FLOW-9: SHA-256 implementation matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('FLOW-9: fingerprint is stable and independent of key order, name, text and time budget', () => {
    const a = workedExamplePlan();
    const b = { ...a, name: 'Other', timeBudgetMin: 45, questions: a.questions.map((q) => ({ ...q, text: 'changed' })) };
    expect(planFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(planFingerprint(b)).toBe(planFingerprint(a));
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });

  it('FLOW-9: fingerprint changes with track, question order, question version, category weight or must-have', () => {
    const a = workedExamplePlan();
    const fp = planFingerprint(a);
    expect(planFingerprint({ ...a, trackId: 'other' })).not.toBe(fp);
    expect(planFingerprint({ ...a, questions: [...a.questions].reverse() })).not.toBe(fp);
    expect(planFingerprint({ ...a, questions: a.questions.map((q, i) => (i ? q : { ...q, version: 2 })) })).not.toBe(fp);
    expect(planFingerprint({ ...a, categories: a.categories.map((c, i) => (i ? c : { ...c, weight: 1.5 })) })).not.toBe(fp);
    expect(planFingerprint(workedExamplePlan(true))).not.toBe(fp);
    expect(planFingerprint({ ...a, categories: [...a.categories].reverse() })).toBe(fp);
    expect(makePlan(a.questions, a.categories).fingerprint).toBe(fp);
  });
});

describe('candidate key display', () => {
  it('FLOW-29 PRIV-1 PRIV-6: the candidate is shown as typed (trimmed), the requisition id in capitals; the key ignores case and extra spaces', () => {
    expect(formatCandidateKey({ initials: ' Ana  Diaz ', requisitionId: ' req-1 ' })).toBe('Ana Diaz · REQ-1');
    expect(formatCandidateKey({ initials: 'AB', requisitionId: 'REQ-1' })).toBe('AB · REQ-1');
    expect(formatCandidateKey({ initials: 'AB', requisitionId: '  ' })).toBe('AB');
    expect(formatCandidateKey({ initials: 'AB', requisitionId: null })).toBe('AB');
    expect(candidateKey({ initials: 'ana   diaz', requisitionId: 'req-1' })).toBe(candidateKey({ initials: ' Ana Diaz', requisitionId: 'REQ-1 ' }));
    expect(candidateKey({ initials: 'Ana Diaz', requisitionId: null })).not.toBe(candidateKey({ initials: 'Ana Dias', requisitionId: null }));
  });
});

describe('plan fingerprint stability across devices', () => {
  it('FLOW-9: the fingerprint does not depend on key order, 1 vs 1.0, question text or other snapshot fields', () => {
    const a = workedExamplePlan();
    const fp = planFingerprint(a);
    // A plan that went through JSON on another device: "1.0" parses to 1, keys may come back in any order.
    const roundTrip = JSON.parse(JSON.stringify(a).replace(/"weight":1(?=[,}])/g, '"weight":1.0'));
    expect(planFingerprint(roundTrip)).toBe(fp);
    const reordered = {
      categories: a.categories.map((c) => Object.fromEntries(Object.entries(c).reverse())),
      questions: a.questions.map((q) => ({ ...Object.fromEntries(Object.entries(q).reverse()), text: `${q.text} (edited)` })),
      trackId: a.trackId,
    } as unknown as typeof a;
    expect(planFingerprint(reordered)).toBe(fp);
  });

  it('FLOW-9: the fingerprint of a fixed plan is pinned, so a change to the algorithm is noticed', () => {
    expect(planFingerprint(workedExamplePlan())).toMatchInlineSnapshot(`"8c294ecb878deb5efa6226190456f189d60c5bcac0dd3a883a36a4815cf934d4"`);
  });
});
