// TEAM-15: "Plan several": lines typed or pasted from a spreadsheet, one planned interview each.
// Pure: the preview matches the panel against the round's team (src/domain/rounds.ts matchPanel) and
// the server creates every interview at once, or none, when the preview is accepted.
import { detectDelimiter, parseDelimited } from './csv';
import { MAX_CANDIDATE, cleanCandidate, isValidCandidate } from './plan';
import { interviewerNameProblems } from './interviewers';
import { MAX_EXPECTED, isDay, isTimeOfDay, uniqueNames } from './team';
import { MAX_PLAN_NOTE, MAX_REQUISITION } from './rounds';

export type BulkColumn = 'candidate' | 'date' | 'time' | 'requisitionId' | 'interviewers' | 'note';

/** Column order when there is no header line (a requisition id column needs a header). */
export const BULK_COLUMNS: readonly BulkColumn[] = ['candidate', 'date', 'time', 'interviewers', 'note'];

/** The most lines accepted in one go. */
export const MAX_BULK_LINES = 200;

export interface BulkLine {
  /** 1-based line number in the pasted text (after a header, if any), for messages. */
  line: number;
  candidate: string;
  requisitionId: string | null;
  date: string | null;
  time: string | null;
  /** The panel as written: emails or names, matched against the team by the preview. */
  interviewers: string[];
  note: string;
  problems: string[];
}

const HEADER_WORDS: Array<[RegExp, BulkColumn]> = [
  [/^(candidate|name|candidate name|initials)$/, 'candidate'],
  [/^(date|day)$/, 'date'],
  [/^(time|start|start time)$/, 'time'],
  [/^(requisition|requisition id|req|req id|requisition number)$/, 'requisitionId'],
  [/^(interviewers?|panel|panel members?|who)$/, 'interviewers'],
  [/^(note|notes|comment|room|link)$/, 'note'],
];

/** A header line names its columns; returns their meaning, or null when the line is data. */
function headerOf(row: readonly string[]): Array<BulkColumn | null> | null {
  const cols = row.map((c) => {
    const k = c.trim().toLowerCase().replace(/\s+/g, ' ');
    return HEADER_WORDS.find(([re]) => re.test(k))?.[1] ?? null;
  });
  return cols.includes('candidate') ? cols : null;
}

/**
 * A date as YYYY-MM-DD from "2026-12-01" or day-first "1/12/2026", "01.12.2026" (as spreadsheets in
 * Australia and Europe write them). Returns null for anything else.
 */
export function parseDay(raw: string): string | null {
  const t = raw.trim();
  if (isDay(t)) return t;
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (!m) return null;
  const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!isDay(d)) return null;
  const check = new Date(`${d}T12:00:00Z`);
  return check.getUTCDate() === Number(m[1]) ? d : null;
}

/** A time as HH:MM from "9:30", "09:30", "14.30", "2pm", "2:30 pm". Returns null for anything else. */
export function parseTime(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  const v = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  return isTimeOfDay(v) ? v : null;
}

/** Interviewers in one cell: "Ana; Ben", "Ana / Ben", "Ana and Ben" (and "Ana, Ben" in tab-separated text). */
export function splitNames(cell: string, commaIsName: boolean): string[] {
  const sep = commaIsName ? /\s*(?:;|\/|\||\band\b|&)\s*/i : /\s*(?:;|\/|\||,|\band\b|&)\s*/i;
  return cell.split(sep).map((n) => n.trim()).filter(Boolean);
}

/**
 * TEAM-15: reads the pasted lines (tab- or comma-separated; header optional) into one entry per
 * line with its problems. Nothing is created here.
 */
export function parseBulkPlan(text: string): { lines: BulkLine[]; tooMany: boolean } {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const header = rows.length ? headerOf(rows[0]) : null;
  const body = header ? rows.slice(1) : rows;
  const cols: Array<BulkColumn | null> = header ?? [...BULK_COLUMNS];
  const at = (row: readonly string[], c: BulkColumn) => {
    const i = cols.indexOf(c);
    return i < 0 ? '' : (row[i] ?? '').trim();
  };
  const lines = body.slice(0, MAX_BULK_LINES).map((row, i): BulkLine => {
    const problems: string[] = [];
    const candidate = cleanCandidate(at(row, 'candidate'));
    if (!candidate) problems.push('No candidate.');
    else if (candidate.length > MAX_CANDIDATE) problems.push(`The candidate is longer than ${MAX_CANDIDATE} characters.`);
    else if (!isValidCandidate(candidate)) problems.push('The candidate can have letters, spaces, hyphens, apostrophes and full stops only.');
    const rawDate = at(row, 'date');
    const date = rawDate ? parseDay(rawDate) : null;
    if (rawDate && !date) problems.push(`“${rawDate.slice(0, 40)}” is not a date (use 2026-12-01 or 1/12/2026).`);
    const rawTime = at(row, 'time');
    const time = rawTime ? parseTime(rawTime) : null;
    if (rawTime && !time) problems.push(`“${rawTime.slice(0, 40)}” is not a time (use 14:30 or 2:30pm).`);
    if (time && !rawDate) problems.push('A time needs a date.');
    const req = at(row, 'requisitionId');
    if (req.length > MAX_REQUISITION) problems.push(`The requisition id is longer than ${MAX_REQUISITION} characters.`);
    const note = at(row, 'note');
    if (note.length > MAX_PLAN_NOTE) problems.push(`The note is longer than ${MAX_PLAN_NOTE} characters.`);
    const names = uniqueNames(splitNames(at(row, 'interviewers'), delimiter === ','));
    if (names.length > MAX_EXPECTED) problems.push(`At most ${MAX_EXPECTED} interviewers.`);
    else if (interviewerNameProblems(names).some(Boolean)) problems.push('An interviewer’s name is too long.');
    return { line: i + 1, candidate, requisitionId: req || null, date, time, interviewers: names, note, problems };
  });
  return { lines, tooMany: body.length > MAX_BULK_LINES };
}
