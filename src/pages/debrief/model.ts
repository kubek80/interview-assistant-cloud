// Pure helpers for the Debrief screen (FLOW-26…29). Grouping and blinding themselves are done
// by the data layer (buildPanel); these only explain import results to the user.
import { candidateKey } from '../../domain/plan';

export interface PanelIdentity {
  candidateKey: string;
  fingerprint: string | null;
}

export type PanelMatch = 'match' | 'different-candidate' | 'different-plan' | 'different-both';

/** FLOW-29: a session joins the panel only when candidate key AND plan fingerprint both match. */
export function panelMatch(imported: PanelIdentity, panel: PanelIdentity): PanelMatch {
  const sameCandidate = imported.candidateKey === panel.candidateKey;
  const samePlan = !!imported.fingerprint && imported.fingerprint === panel.fingerprint;
  if (sameCandidate && samePlan) return 'match';
  if (!sameCandidate && !samePlan) return 'different-both';
  return sameCandidate ? 'different-plan' : 'different-candidate';
}

export const MATCH_EXPLANATIONS: Record<Exclude<PanelMatch, 'match'>, string> = {
  'different-candidate':
    'It was imported, but it is for a different candidate (initials and requisition id), so it is not part of this panel.',
  'different-plan':
    'It was imported, but it used different questions (a different comparison code), so its scores are not comparable and it is not part of this panel.',
  'different-both': 'It was imported, but it is for a different candidate and used different questions, so it is not part of this panel.',
};

/**
 * Reads the identity of a session file that importSessionFile has already validated and
 * accepted. Returns null for anything unexpected (the caller then says nothing about matching).
 */
export function identityOfSessionFile(json: unknown): PanelIdentity | null {
  if (!json || typeof json !== 'object') return null;
  const f = json as { plan?: { fingerprint?: unknown }; session?: { candidate?: { initials?: unknown; requisitionId?: unknown } } };
  const initials = f.session?.candidate?.initials;
  const req = f.session?.candidate?.requisitionId;
  const fp = f.plan?.fingerprint;
  if (typeof initials !== 'string') return null;
  return {
    candidateKey: candidateKey({ initials, requisitionId: typeof req === 'string' ? req : null }),
    fingerprint: typeof fp === 'string' ? fp : null,
  };
}

/** SCORE-11 display: the spread with its warning state. */
export function spreadText(spread: number | null, flagged: boolean): string {
  if (spread == null) return '–';
  // SCORE-10 rounds for display, but the flag uses the unrounded spread: keep a decimal when
  // rounding would make a flagged spread read as "20".
  const pts = flagged && Math.round(spread) <= 20 ? spread.toFixed(1) : String(Math.round(spread));
  return flagged ? `${pts} points (above 20)` : `${pts} points`;
}
