import { db, SETTINGS } from './db';
import { loadSeeds, type SeedLoadResult } from './bank';
import { purgeExpired } from './privacy';
import { getSetting, nowIso, setSetting } from './util';

export interface InitResult {
  seeds: SeedLoadResult;
  purged: number;
}

let started: Promise<InitResult> | null = null;

/** App start-up: open the database, load newer seeds (BANK-6) and purge expired sessions (PRIV-5). */
export function initDatabase(): Promise<InitResult> {
  started ??= (async () => {
    await db.open();
    const seeds = await loadSeeds();
    const purged = await purgeExpired();
    await setSetting(SETTINGS.lastPurgeAt, nowIso());
    return { seeds, purged };
  })();
  return started;
}

export async function getInterviewerName(): Promise<string> {
  return (await getSetting<string>(SETTINGS.interviewerName)) ?? '';
}

/** AUD-1: the actor recorded in the audit log for this device. */
export async function setInterviewerName(name: string): Promise<void> {
  await setSetting(SETTINGS.interviewerName, name.trim());
}
