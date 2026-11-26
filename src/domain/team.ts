// TEAM-1…TEAM-6: planning interviews ahead, invitations and collecting everyone's records. Pure.
//
// The rules that keep blind scoring intact when interviews are shared between devices live here
// (blindState, mayStartOwnRecord) so that the data layer and its tests use exactly one definition.
import { candidateKey } from './plan';
import { MAX_INTERVIEWERS, cleanName, interviewerNameProblems, interviewersOf, nameKey } from './interviewers';
import type { PlannedInterview, Session } from './types';

/** Longest note for the interviewers on a planned interview. */
export const MAX_NOTE = 500;
/** Most interviewers expected on one planned interview (the panel). */
export const MAX_EXPECTED = 2 * MAX_INTERVIEWERS;

/** FLOW-29: the panel an interview belongs to: candidate key plus plan fingerprint. */
export function panelKey(candidate: { initials: string; requisitionId: string | null | undefined }, fingerprint: string | null | undefined): string {
  return `${candidateKey(candidate)}#${fingerprint ?? ''}`;
}

// ---------------------------------------------------------------------------------------------
// Independent scoring (FLOW-27)

/**
 * FLOW-27: other people's records are shown as soon as they are imported. Only when independent
 * scoring is turned on for this device ("Hide other people's scores until I have submitted mine")
 * are imported records of a panel hidden until one of this device's own records for that panel is
 * submitted.
 */
export function hideImported(independentScoring: boolean, local: ReadonlyArray<Pick<Session, 'state'>>): boolean {
  return independentScoring && !local.some((s) => s.state === 'submitted');
}

// ---------------------------------------------------------------------------------------------
// Expected, submitted and still to come (TEAM-6)

export interface Attendance {
  /** Everyone expected (from the plan or invitation), in the order given. */
  expected: string[];
  /** Everyone with a submitted record, local or imported (a shared scorecard lists all its names). */
  submitted: Array<{ name: string; you: boolean }>;
  /** Expected people with no submitted record yet. */
  toCome: string[];
}

/**
 * TEAM-6: names are compared trimmed and case-insensitively; a submitted person who was not
 * expected is simply listed as submitted.
 */
export function attendance(expected: readonly string[], records: ReadonlyArray<Pick<Session, 'state' | 'origin' | 'interviewer' | 'interviewers'>>): Attendance {
  const exp = uniqueNames(expected);
  const submitted: Attendance['submitted'] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.state !== 'submitted') continue;
    for (const name of interviewersOf(r)) {
      const k = nameKey(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      submitted.push({ name: cleanName(name), you: r.origin === 'local' });
    }
  }
  // Expected people first, in the order they were named; anyone else after them.
  const rank = (n: string) => {
    const i = exp.findIndex((e) => nameKey(e) === nameKey(n));
    return i < 0 ? exp.length : i;
  };
  submitted.sort((a, b) => rank(a.name) - rank(b.name));
  return { expected: exp, submitted, toCome: exp.filter((n) => !seen.has(nameKey(n))) };
}

/** Names without blanks or repeats (case-insensitive, trimmed), first spelling kept. */
export function uniqueNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const c = cleanName(n);
    const k = c.toLowerCase();
    if (!c || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Removes names from a list (case-insensitive). */
export function withoutNames(names: readonly string[], remove: readonly string[]): string[] {
  const r = new Set(remove.map(nameKey));
  return names.filter((n) => !r.has(nameKey(n)));
}

// ---------------------------------------------------------------------------------------------
// Schedule (TEAM-1, TEAM-2)

export interface ScheduleInput {
  /** YYYY-MM-DD or '' */
  date: string;
  /** HH:MM or '' */
  time: string;
  expected: string[];
  note: string;
}

export type ScheduleErrors = Partial<Record<keyof ScheduleInput, string>>;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day as YYYY-MM-DD (not 2026-02-31). */
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const isTimeOfDay = (v: unknown): v is string => typeof v === 'string' && TIME.test(v);

/** TEAM-1: the optional date, time, interviewers and note of a planned interview. */
export function scheduleProblems(input: ScheduleInput): ScheduleErrors {
  const e: ScheduleErrors = {};
  if (input.date && !isDay(input.date)) e.date = 'Enter a date.';
  if (input.time && !isTimeOfDay(input.time)) e.time = 'Enter a time, for example 14:30.';
  else if (input.time && !input.date) e.time = 'Choose the day as well.';
  const names = uniqueNames(input.expected);
  if (names.length > MAX_EXPECTED) e.expected = `At most ${MAX_EXPECTED} interviewers.`;
  else {
    const i = interviewerNameProblems(names).findIndex(Boolean);
    if (i >= 0) e.expected = interviewerNameProblems(names)[i]!;
  }
  if (input.note.length > MAX_NOTE) e.note = `Keep the note under ${MAX_NOTE} characters.`;
  return e;
}

/** Upcoming order: soonest first; on the same day timed ones first; undated ones last (oldest first). */
export function compareUpcoming(a: Pick<PlannedInterview, 'date' | 'time' | 'createdAt'>, b: Pick<PlannedInterview, 'date' | 'time' | 'createdAt'>): number {
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time && !b.time) return -1;
  if (!a.time && b.time) return 1;
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

/** Local calendar day of a moment, YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Today", "Tomorrow", "Tue, 1 Dec" (with the year when it is not this year), or "No date yet". */
export function dayLabel(date: string | null, today: string, locale?: string): string {
  if (!date) return 'No date yet';
  if (date === today) return 'Today';
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() + 1);
  if (date === localDay(t)) return 'Tomorrow';
  const d = new Date(`${date}T12:00:00`);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Today at 10:00", "Tue, 1 Dec at 14:30", "Tue, 1 Dec", "No date yet". */
export function whenLabel(p: Pick<PlannedInterview, 'date' | 'time'>, today: string, locale?: string): string {
  const day = dayLabel(p.date, today, locale);
  return p.date && p.time ? `${day} at ${p.time}` : day;
}

// ---------------------------------------------------------------------------------------------
// Matching imported interview files to interviews (TEAM-5)

export type FileMatch =
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'panel' }
  | { kind: 'none'; reason: 'no-interview' | 'invitation-differs' };

/**
 * TEAM-5: matches an imported record to an interview on this device. The invitation id is used
 * when present; otherwise (or when the device has no such invitation) the candidate key and plan
 * fingerprint (FLOW-29) are compared with the planned interviews and the records already here.
 */
export function matchRecord(
  file: { invitationId?: string | null; candidateKey: string; fingerprint: string },
  planned: ReadonlyArray<Pick<PlannedInterview, 'id' | 'candidate' | 'fingerprint'>>,
  panelKeysWithRecords: ReadonlySet<string>,
): FileMatch {
  const key = `${file.candidateKey}#${file.fingerprint}`;
  if (file.invitationId) {
    const inv = planned.find((p) => p.id === file.invitationId);
    if (inv) return panelKey(inv.candidate, inv.fingerprint) === key ? { kind: 'invitation', invitationId: inv.id } : { kind: 'none', reason: 'invitation-differs' };
  }
  const byPanel = planned.find((p) => panelKey(p.candidate, p.fingerprint) === key);
  if (byPanel) return { kind: 'invitation', invitationId: byPanel.id };
  if (panelKeysWithRecords.has(key)) return { kind: 'panel' };
  return { kind: 'none', reason: 'no-interview' };
}

export const NO_MATCH_EXPLANATIONS: Record<'no-interview' | 'invitation-differs', string> = {
  'no-interview': 'No interview on this device has this candidate with these questions. It is kept and shown as an interview from another device.',
  'invitation-differs':
    'It names an invitation on this device but is for a different candidate or different questions, so it is not grouped with it. It is kept and shown as an interview from another device.',
};

/** TEAM-2, TEAM-3: a planned interview changed here after its invitation was last exported. */
export function changedSinceExport(p: Pick<PlannedInterview, 'source' | 'exportedAt' | 'updatedAt'>): boolean {
  return p.source === 'here' && !!p.exportedAt && p.updatedAt > p.exportedAt;
}
