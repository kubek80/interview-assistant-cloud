// DATA-5, PANEL-1…PANEL-5: several interviewers at one machine share one record (session). Pure.
import type { Session } from './types';

/** Longest interviewer name accepted (FLOW-7, PANEL-1). */
export const MAX_INTERVIEWER_NAME = 200;
/** Most interviewers on one shared record. */
export const MAX_INTERVIEWERS = 12;

/**
 * DATA-5: the interviewers of a session, the first being this device's interviewer. Sessions and
 * session files made before DATA-5 have no `interviewers`; their one interviewer is `interviewer.name`.
 */
export function interviewersOf(session: Pick<Session, 'interviewer'> & { interviewers?: readonly string[] | null }): string[] {
  const list = Array.isArray(session.interviewers) ? session.interviewers.filter((n) => typeof n === 'string' && n.trim()) : [];
  return list.length ? [...list] : [session.interviewer.name];
}

/** Trims and collapses inner spaces. */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** PANEL-1: names must differ from each other, compared ignoring case and spacing. */
export function nameKey(name: string): string {
  return cleanName(name).toLowerCase();
}

/** PANEL-1: one problem per name (null when fine), in list order. */
export function interviewerNameProblems(names: readonly string[]): Array<string | null> {
  const seen = new Set<string>();
  return names.map((n) => {
    const t = cleanName(n);
    if (!t) return 'Enter the interviewer’s name.';
    if (t.length > MAX_INTERVIEWER_NAME) return 'The name is too long.';
    const k = t.toLowerCase();
    if (seen.has(k)) return 'Each interviewer needs a different name.';
    seen.add(k);
    return null;
  });
}

/** PANEL-4: "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function formatNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** PANEL-4: the interviewers of a session as one label. */
export function interviewersLabel(session: Pick<Session, 'interviewer'> & { interviewers?: readonly string[] | null }): string {
  return formatNames(interviewersOf(session));
}
