// The "Change the mix" settings of a set-up that has not been continued yet (UX-3): the number of
// questions of each type and "Draw from", kept per set-up in this browser so a reload keeps them.
// They are not candidate data. Removed when the set-up is continued (the questions are then fixed).
import { DEFAULT_QUOTAS, type Quotas } from '../../domain/plan';

export interface MixMemory {
  quotas: Quotas;
  drawFrom: string;
}

const key = (planId: string) => `ia.mix.${planId}`;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const isDefault = (m: MixMemory) => !m.drawFrom && (Object.keys(DEFAULT_QUOTAS) as Array<keyof Quotas>).every((t) => m.quotas[t] === DEFAULT_QUOTAS[t]);

/** The remembered mix for this set-up, or the defaults. Anything unreadable falls back to the defaults. */
export function readMix(planId: string, s: Pick<Storage, 'getItem'> | null = store()): MixMemory {
  const fallback = { quotas: { ...DEFAULT_QUOTAS }, drawFrom: '' };
  try {
    const raw = s?.getItem(key(planId));
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<MixMemory>;
    const quotas = { ...DEFAULT_QUOTAS };
    for (const t of Object.keys(DEFAULT_QUOTAS) as Array<keyof Quotas>) {
      const n = v.quotas?.[t];
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 50) quotas[t] = n;
    }
    return { quotas, drawFrom: typeof v.drawFrom === 'string' ? v.drawFrom.slice(0, 200) : '' };
  } catch {
    return fallback;
  }
}

export function writeMix(planId: string, mix: MixMemory, s: Pick<Storage, 'setItem' | 'removeItem'> | null = store()): void {
  try {
    if (isDefault(mix)) s?.removeItem(key(planId));
    else s?.setItem(key(planId), JSON.stringify(mix));
  } catch {
    // Storage unavailable: the mix still holds for this page view.
  }
}

export function clearMix(planId: string, s: Pick<Storage, 'removeItem'> | null = store()): void {
  try {
    s?.removeItem(key(planId));
  } catch {
    // Nothing to clear.
  }
}
