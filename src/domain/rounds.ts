// Hiring rounds and planned interviews (ROUND-1…ROUND-5, TEAM-2, TEAM-15, TEAM-16). Pure: used by the
// server (counts, validation) and the browser (Dashboard, round pages, Plan several preview).
import { cleanName } from './interviewers';
import type { InterviewStatus } from '../shared/api';

export type InterviewState = 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
export type PanelStatus = 'expected' | 'joined' | 'submitted' | 'did_not_take_part';

/**
 * Where an interview is, from its state and its panel members' records (LIVE-4):
 *   upcoming     planned, not started;
 *   in-progress  started and nobody has submitted yet;
 *   waiting      started, someone has submitted, others still to come ("waiting for judgements");
 *   finished     completed (everyone who joined has submitted).
 * Cancelled interviews are not listed (null).
 */
export function interviewStatus(state: InterviewState, panel: ReadonlyArray<PanelStatus>): InterviewStatus | null {
  switch (state) {
    case 'cancelled':
      return null;
    case 'planned':
      return 'upcoming';
    case 'completed':
      return 'finished';
    default:
      return panel.some((s) => s === 'submitted') ? 'waiting' : 'in-progress';
  }
}

export const STATUS_LABELS: Record<InterviewStatus, string> = {
  upcoming: 'Upcoming',
  'in-progress': 'In progress',
  waiting: 'Waiting for judgements',
  finished: 'Finished',
};

/** TEAM-2: soonest first; on the same day timed ones first; undated last (oldest planned first). */
export function compareSchedule(a: { date: string | null; time: string | null; createdAt: string }, b: { date: string | null; time: string | null; createdAt: string }): number {
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time && !b.time) return -1;
  if (!a.time && b.time) return 1;
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

/** ROUND-1: a round's name (1-200 characters) and requisition id (up to 60). */
export const MAX_ROUND_NAME = 200;
export const MAX_REQUISITION = 60;
/** TEAM-1: the note for the interviewers on a planned interview. */
export const MAX_PLAN_NOTE = 500;
/** Most people on one interview's panel. */
export const MAX_PANEL = 12;

/** A person on a round's team, as Plan several matches names against it. */
export interface TeamPerson {
  id: string;
  name: string;
  email: string;
}

export type PanelMatch =
  | { kind: 'ok'; ids: string[] }
  | { kind: 'problems'; ids: string[]; unknown: string[]; ambiguous: string[] };

const norm = (s: string) => cleanName(s).toLowerCase();

/**
 * TEAM-15, ROUND-4: the panel named on a pasted line (emails, full names, or first names when they
 * are unique) matched against people. Each name must match exactly one person.
 */
export function matchPanel(names: readonly string[], people: readonly TeamPerson[]): PanelMatch {
  const ids: string[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    let hits = people.filter((p) => p.email.toLowerCase() === n);
    if (!hits.length) hits = people.filter((p) => norm(p.name) === n);
    if (!hits.length) hits = people.filter((p) => norm(p.name).split(' ')[0] === n);
    if (!hits.length) hits = people.filter((p) => p.email.toLowerCase().split('@')[0] === n);
    if (hits.length === 1) {
      if (!ids.includes(hits[0].id)) ids.push(hits[0].id);
    } else if (hits.length > 1) ambiguous.push(cleanName(raw));
    else unknown.push(cleanName(raw));
  }
  return unknown.length || ambiguous.length ? { kind: 'problems', ids, unknown, ambiguous } : { kind: 'ok', ids };
}

/** "Ana Diaz", "Ana Diaz and Ben Ng", "Ana Diaz, Ben Ng and Cy Park". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The display name of a person: their name, else the part of their email before the @. */
export function personName(p: { name: string | null; email: string }): string {
  return p.name?.trim() || p.email.split('@')[0];
}

/** PRIV-5: a date `days` after `from` as YYYY-MM-DD (UTC calendar, as the server stores it). */
export function retentionDate(days: number, from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
