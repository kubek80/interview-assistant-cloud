import { describe, expect, it } from 'vitest';
import { clearMix, readMix, writeMix } from './mixMemory';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    get length() {
      return m.size;
    },
  };
}

describe('mix memory (UX-3)', () => {
  it('UX-3 RES-1: the mix and "Draw from" of a set-up survive a reload; the defaults store nothing; continuing clears them', () => {
    const localStorage = memoryStore();
    expect(readMix('p1', localStorage)).toEqual({ quotas: { knowledge: 9, scenario: 2, design: 1, behavioural: 2 }, drawFrom: '' });
    writeMix('p1', { quotas: { knowledge: 10, scenario: 1, design: 1, behavioural: 2 }, drawFrom: 'qa-performance' }, localStorage);
    expect(readMix('p1', localStorage)).toEqual({ quotas: { knowledge: 10, scenario: 1, design: 1, behavioural: 2 }, drawFrom: 'qa-performance' });
    expect(readMix('p2', localStorage).drawFrom).toBe('');
    writeMix('p1', { quotas: { knowledge: 9, scenario: 2, design: 1, behavioural: 2 }, drawFrom: '' }, localStorage);
    expect(localStorage.length).toBe(0);
    writeMix('p1', { quotas: { knowledge: 8, scenario: 2, design: 1, behavioural: 2 }, drawFrom: '' }, localStorage);
    clearMix('p1', localStorage);
    expect(readMix('p1', localStorage).quotas.knowledge).toBe(9);
  });

  it('UX-3: anything unreadable falls back to the defaults', () => {
    const localStorage = memoryStore();
    localStorage.setItem('ia.mix.p1', '{not json');
    expect(readMix('p1', localStorage).quotas.knowledge).toBe(9);
    localStorage.setItem('ia.mix.p1', JSON.stringify({ quotas: { knowledge: -3, design: 'x', scenario: 4 }, drawFrom: 7 }));
    expect(readMix('p1', localStorage)).toEqual({ quotas: { knowledge: 9, scenario: 4, design: 1, behavioural: 2 }, drawFrom: '' });
  });
});
