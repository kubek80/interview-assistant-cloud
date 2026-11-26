// Device settings beyond the interviewer name (additive). Stored in the existing `settings`
// key-value table, so no schema change is needed and erase-all (PRIV-6) clears them too.
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { RepoError, appendAudit, getSetting, setSetting } from './util';
import { DEFAULT_RETENTION_DAYS } from '../domain/plan';

export const DEVICE_SETTINGS = {
  /** FLOW-7, FLOW-33, PRIV-5: default retention period in days for new interviews on this device. */
  retentionDays: 'defaultRetentionDays',
  /** FLOW-33: the track last used for an interview, preselected on the Dashboard. */
  lastTrackId: 'lastTrackId',
  /** TR-4: the last "recorded or transcribed" choice, preselected for the next interview. */
  recordingNotice: 'recordingNotice',
  /** AI-2: whether the AI second opinion is turned on for this device, and when the notice was acknowledged. */
  aiSecondOpinion: 'aiSecondOpinion',
  /** FLOW-27: "Hide other people's scores until I have submitted mine" (default off). */
  independentScoring: 'independentScoring',
} as const;

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

function validDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_RETENTION_DAYS && v <= MAX_RETENTION_DAYS;
}

/** The default retention period in days (90 unless changed on this device). */
export async function getDefaultRetentionDays(): Promise<number> {
  const v = await getSetting<number>(DEVICE_SETTINGS.retentionDays);
  return validDays(v) ? v : DEFAULT_RETENTION_DAYS;
}

export async function setDefaultRetentionDays(days: number): Promise<void> {
  if (!validDays(days)) throw new RepoError('invalid', `Enter whole days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`);
  await setSetting(DEVICE_SETTINGS.retentionDays, days);
}

export async function getLastTrackId(): Promise<string | null> {
  const v = await getSetting<string>(DEVICE_SETTINGS.lastTrackId);
  return typeof v === 'string' && v ? v : null;
}

export async function setLastTrackId(trackId: string): Promise<void> {
  await setSetting(DEVICE_SETTINGS.lastTrackId, trackId);
}

/** Live default retention days; `undefined` while loading. */
export function useDefaultRetentionDays(): number | undefined {
  return useLiveQuery(async () => {
    const v = (await db.settings.get(DEVICE_SETTINGS.retentionDays))?.value;
    return validDays(v) ? v : DEFAULT_RETENTION_DAYS;
  }, []);
}

/** Live last-used track id; `undefined` while loading, `null` when none. */
export function useLastTrackId(): string | null | undefined {
  return useLiveQuery(async () => {
    const v = (await db.settings.get(DEVICE_SETTINGS.lastTrackId))?.value;
    return typeof v === 'string' && v ? v : null;
  }, []);
}

/** TR-4: the last "recorded or transcribed" choice on this device (default off). */
export async function getRecordingNoticeDefault(): Promise<boolean> {
  return (await getSetting<boolean>(DEVICE_SETTINGS.recordingNotice)) === true;
}

/** TR-4: live last "recorded or transcribed" choice; `undefined` while loading. */
export function useRecordingNoticeDefault(): boolean | undefined {
  return useLiveQuery(async () => (await db.settings.get(DEVICE_SETTINGS.recordingNotice))?.value === true, []);
}

/** FLOW-27: whether independent scoring is on for this device (default off). */
export async function getIndependentScoring(): Promise<boolean> {
  return (await getSetting<boolean>(DEVICE_SETTINGS.independentScoring)) === true;
}

/** FLOW-27: turns independent scoring on or off for this device. Audited. */
export async function setIndependentScoring(on: boolean): Promise<void> {
  await db.transaction('rw', [db.settings, db.audit], async () => {
    if ((await getIndependentScoring()) === on) return;
    await setSetting(DEVICE_SETTINGS.independentScoring, on);
    await appendAudit({ action: 'device.independent_scoring', entity: 'device', after: { on } });
  });
}

/** FLOW-27: live setting; `undefined` while loading. */
export function useIndependentScoring(): boolean | undefined {
  return useLiveQuery(async () => (await db.settings.get(DEVICE_SETTINGS.independentScoring))?.value === true, []);
}
