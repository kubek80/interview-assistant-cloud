import { describe, expect, it } from 'vitest';
import { continueProblems, mixInWords, moveItem, moveTo, normaliseInitials, parseBudget, parseQuotas, parseWeight, questionMeta, quotasToText, shortfallInWords, toggleSelected } from './logic';
import { clearLegacyCandidateDraft as clearCandidateDraft, emptyCandidateDraft, loadLegacyCandidateDraft as loadCandidateDraft, saveLegacyCandidateDraft as saveCandidateDraft } from './candidateDraft';
import { DEFAULT_QUOTAS } from '../../domain/plan';

describe('setup logic', () => {
  it('FLOW-3: default quotas are valid; knowledge is constrained to 8-10', () => {
    expect(parseQuotas(quotasToText(DEFAULT_QUOTAS))).toEqual({ quotas: { knowledge: 9, scenario: 2, design: 1, behavioural: 2 }, errors: {} });
    for (const k of ['7', '11', '8.5', '', 'x']) {
      const r = parseQuotas({ ...quotasToText(DEFAULT_QUOTAS), knowledge: k });
      expect(r.quotas).toBeNull();
      expect(r.errors.knowledge).toBe('Knowledge questions: choose 8 to 10.');
    }
    expect(parseQuotas({ ...quotasToText(DEFAULT_QUOTAS), knowledge: '8' }).quotas?.knowledge).toBe(8);
    expect(parseQuotas({ ...quotasToText(DEFAULT_QUOTAS), knowledge: '10' }).quotas?.knowledge).toBe(10);
    expect(parseQuotas({ ...quotasToText(DEFAULT_QUOTAS), design: '0' }).quotas?.design).toBe(0);
    expect(parseQuotas({ ...quotasToText(DEFAULT_QUOTAS), scenario: '-1' }).errors.scenario).toBeTruthy();
  });

  it('FLOW-3 UX-8: the mix and unmet quotas are explained in plain words', () => {
    expect(shortfallInWords([])).toBeNull();
    expect(shortfallInWords([{ type: 'design', wanted: 2, got: 1 }])).toBe('Not enough questions in the bank for this mix: the set has 1 of 2 design exercises.');
    const t = (type: 'knowledge' | 'scenario' | 'design' | 'behavioural') => ({ type });
    expect(mixInWords([...Array(9).fill(t('knowledge')), t('scenario'), t('scenario'), t('design'), t('behavioural'), t('behavioural')])).toBe(
      '9 knowledge questions, 2 scenarios, 1 design exercise and 2 behavioural questions',
    );
    expect(mixInWords([t('design')])).toBe('1 design exercise');
    expect(mixInWords([])).toBe('No questions yet');
    expect(questionMeta({ type: 'knowledge', difficulty: 'advanced', timeMin: 4 }, 'Networking')).toBe('Knowledge · Advanced · Networking · 4 min');
    expect(questionMeta({ type: 'behavioural', difficulty: 'core', timeMin: 4 }, 'Leadership')).toBe('Behavioural · Leadership · 4 min');
  });

  it('FLOW-6: weights must be more than 0 and at most 10', () => {
    expect(parseWeight('1.5')).toEqual({ value: 1.5, error: null });
    expect(parseWeight('1,25').value).toBe(1.25);
    expect(parseWeight('0').error).toBeTruthy();
    expect(parseWeight('').error).toBeTruthy();
    expect(parseWeight('abc').error).toBeTruthy();
    expect(parseWeight('11').error).toBeTruthy();
  });

  it('FLOW-4: the time budget is whole minutes above 0', () => {
    expect(parseBudget('60')).toEqual({ value: 60, error: null });
    expect(parseBudget('0').error).toBeTruthy();
    expect(parseBudget('45.5').error).toBeTruthy();
    expect(parseBudget('').error).toBeTruthy();
  });

  it('FLOW-3 UX-3: reorder (by step and by drag target) and hand-pick keep the rest of the order', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(toggleSelected(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleSelected(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(moveTo(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
  });

  it('FLOW-33 FLOW-7 FLOW-8: Continue problems list everything that blocks it, in screen order; consent is not one of them', () => {
    expect(continueProblems({ questionCount: 3, budgetError: null, candidateErrors: {} })).toEqual([]);
    const p = continueProblems({
      questionCount: 0,
      budgetError: 'Enter whole minutes from 1 to 600.',
      weightsInvalid: true,
      candidateErrors: { initials: 'Initials…', interviewerName: 'Name…', retentionUntil: 'Date…' },
    });
    expect(p.map((x) => x.field)).toEqual(['name', 'initials', 'questions', 'budget', 'retentionUntil', 'weights']);
  });

  it('PRIV-1: the candidate is kept as typed (a name or initials), at most 60 characters', () => {
    expect(normaliseInitials('Ana Diaz')).toBe('Ana Diaz');
    expect(normaliseInitials('jd')).toBe('jd');
    expect(normaliseInitials('x'.repeat(80))).toHaveLength(60);
  });
});

describe('candidate draft (FLOW-7, RES-1, PRIV-3)', () => {
  function memoryStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  }

  it('FLOW-7: defaults the retention date to 90 days ahead', () => {
    const d = emptyCandidateDraft('Sam', new Date(2026, 10, 24));
    expect(d).toEqual({ initials: '', requisitionId: '', interviewerName: 'Sam', otherInterviewers: [], retentionUntil: '2027-02-22' });
  });

  it('RES-1: a legacy sessionStorage draft is read by plan id (to move it into IndexedDB), and is cleared', () => {
    const s = memoryStore();
    const d = { ...emptyCandidateDraft('Sam'), initials: 'AB' };
    saveCandidateDraft('p1', d, s);
    expect(loadCandidateDraft('p1', s)).toEqual(d);
    expect(loadCandidateDraft('p2', s)).toBeNull();
    clearCandidateDraft('p1', s);
    expect(loadCandidateDraft('p1', s)).toBeNull();
  });

  it('ignores malformed stored data', () => {
    const s = memoryStore();
    s.setItem('ia.setup-candidate.p1', '{not json');
    expect(loadCandidateDraft('p1', s)).toBeNull();
    s.setItem('ia.setup-candidate.p1', JSON.stringify({ initials: 5, consentConfirmed: 'yes', requisitionId: 'R1' }));
    expect(loadCandidateDraft('p1', s)).toEqual({ requisitionId: 'R1' });
  });
});

