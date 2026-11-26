import { describe, expect, it } from 'vitest';
import { identityOfSessionFile, panelMatch, spreadText } from './model';

const panel = { candidateKey: 'AB|REQ-1', fingerprint: 'f'.repeat(64) };

describe('Debrief helpers', () => {
  it('FLOW-29: a session joins the panel only when candidate key and plan fingerprint both match', () => {
    expect(panelMatch({ ...panel }, panel)).toBe('match');
    expect(panelMatch({ ...panel, candidateKey: 'CD|REQ-1' }, panel)).toBe('different-candidate');
    expect(panelMatch({ ...panel, fingerprint: 'e'.repeat(64) }, panel)).toBe('different-plan');
    expect(panelMatch({ candidateKey: 'CD|', fingerprint: null }, panel)).toBe('different-both');
  });

  it('FLOW-29: the candidate key from a session file is normalised like the data layer (case, spaces)', () => {
    const id = identityOfSessionFile({ plan: { fingerprint: panel.fingerprint }, session: { candidate: { initials: 'ab ', requisitionId: ' req-1' } } });
    expect(id).toEqual(panel);
    expect(identityOfSessionFile(null)).toBeNull();
    expect(identityOfSessionFile({ session: {} })).toBeNull();
  });

  it('SCORE-11: spread is shown rounded, keeping a decimal when a flagged spread would round to 20', () => {
    expect(spreadText(null, false)).toBe('–');
    expect(spreadText(12.4, false)).toBe('12 points');
    expect(spreadText(31.6, true)).toBe('32 points (above 20)');
    expect(spreadText(20.3, true)).toBe('20.3 points (above 20)');
  });
});
