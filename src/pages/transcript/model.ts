// Pure view logic for the "Transcript & recording" panel and the AI second-opinion run
// (TR-1, TR-2, AI-1, AI-3, AI-5). No I/O.
import { formatTimestamp } from '../../domain/transcript/parse';
import type { Transcript } from '../../domain/transcript/types';
import { CANDIDATE_LABEL, SPEAKER_LABEL_PATTERN } from '../../domain/ai/types';
import { checkSpeakerMapping, type SpeakerMapping, type SpeakerMappingProblem } from '../../domain/ai/pseudonymise';
import type { AiStatus } from '../../ai/client';
import type { AiSettings } from '../../db';

/** TR-1: lines shown per page of the transcript viewer (transcripts can run to thousands of lines). */
export const PAGE_SIZE = 200;

export interface ViewerLine {
  /** 1-based; line n is segment n - 1 (the numbering the AI quotations use). */
  line: number;
  startSec?: number;
  time?: string;
  speaker?: string;
  text: string;
}

export function transcriptLines(t: Pick<Transcript, 'segments'>): ViewerLine[] {
  return t.segments.map((s, i) => ({
    line: i + 1,
    ...(s.startSec !== undefined ? { startSec: s.startSec, time: formatTimestamp(s.startSec) } : {}),
    ...(s.speaker ? { speaker: s.speaker } : {}),
    text: s.text,
  }));
}

/** TR-1: case-insensitive search over speaker and text. */
export function searchLines(lines: readonly ViewerLine[], query: string): ViewerLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...lines];
  return lines.filter((l) => l.text.toLowerCase().includes(q) || (l.speaker ?? '').toLowerCase().includes(q));
}

export interface Page<T> {
  items: T[];
  /** 0-based, clamped. */
  page: number;
  pageCount: number;
  /** 1-based positions of the first and last item shown (0 when empty). */
  from: number;
  to: number;
  total: number;
}

export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const slice = items.slice(p * size, p * size + size);
  return { items: slice, page: p, pageCount, from: slice.length ? p * size + 1 : 0, to: p * size + slice.length, total: items.length };
}

/** The page that holds transcript line `line` when no search is active. */
export function pageOfLine(line: number, size = PAGE_SIZE): number {
  return Math.max(0, Math.floor((line - 1) / size));
}

/** Splits text around case-insensitive matches of `query`, for highlighting (rendered as text, SEC-2). */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const out: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) out.push({ text: text.slice(at, i), match: false });
    out.push({ text: text.slice(i, i + q.length), match: true });
    at = i + q.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

/** "512 bytes", "1.5 KB", "12.3 MB", "1.20 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function mediaKind(type: string): 'audio' | 'video' {
  return /^video\//i.test(type) ? 'video' : 'audio';
}

// ------------------------------------------------------------------------------------------------
// AI-5: speaker mapping

/** Labels a speaker can be given: Candidate, Interviewer 1…n, Other speaker 1…n. */
export function speakerLabelOptions(speakerCount: number): string[] {
  const n = Math.max(1, speakerCount);
  return [CANDIDATE_LABEL, ...Array.from({ length: n }, (_, i) => `Interviewer ${i + 1}`), ...Array.from({ length: n }, (_, i) => `Other speaker ${i + 1}`)];
}

export interface ExtraName {
  name: string;
  label: string;
}

export interface MappingCheck {
  problems: SpeakerMappingProblem[];
  /** Problems with the extra names (index → message). */
  extraProblems: Array<string | null>;
  ok: boolean;
}

/** AI-5: the mapping and the extra names must be complete before anything is sent. */
export function checkMapping(transcript: Pick<Transcript, 'speakers'>, mapping: SpeakerMapping, extra: readonly ExtraName[]): MappingCheck {
  const problems = checkSpeakerMapping(transcript, mapping);
  const extraProblems = extra.map((e) => {
    if (!e.name.trim()) return 'Enter the name to replace, or remove this row.';
    if (e.name.trim().length < 2) return 'Names of one letter cannot be replaced.';
    if (!SPEAKER_LABEL_PATTERN.test(e.label)) return 'Choose what to replace it with.';
    return null;
  });
  return { problems, extraProblems, ok: problems.length === 0 && extraProblems.every((p) => p === null) };
}

// ------------------------------------------------------------------------------------------------
// AI-1, AI-2, AI-3: can a run start here, and if not, why

export type AiReadiness =
  | { canRun: true }
  | { canRun: false; reason: 'loading' | 'off' | 'unavailable' | 'no-transcript' | 'busy' | 'imported' | 'not-started'; message: string };

export function aiReadiness(args: {
  settings: AiSettings | undefined;
  status: AiStatus | null | undefined;
  hasTranscript: boolean;
  origin: 'local' | 'imported' | 'entered';
  started: boolean;
}): AiReadiness {
  if (args.origin !== 'local') return { canRun: false, reason: 'imported', message: 'The AI second opinion is not available for an imported panelist session.' };
  if (!args.settings) return { canRun: false, reason: 'loading', message: 'Checking…' };
  if (!args.settings.enabled) {
    return { canRun: false, reason: 'off', message: 'The AI second opinion is turned off on this device. It can be turned on in Admin › AI second opinion, after reading the privacy notice.' };
  }
  if (!args.started) return { canRun: false, reason: 'not-started', message: 'Start the interview first.' };
  if (args.status === undefined || args.status === null) return { canRun: false, reason: 'loading', message: 'Checking the local AI helper…' };
  if (args.status.state === 'unavailable') return { canRun: false, reason: 'unavailable', message: args.status.message };
  if (!args.hasTranscript) return { canRun: false, reason: 'no-transcript', message: 'Attach a transcript first: the AI second opinion scores the transcript.' };
  if (args.status.busy) return { canRun: false, reason: 'busy', message: 'An AI second opinion is already running on this computer. Wait for it to finish.' };
  return { canRun: true };
}
