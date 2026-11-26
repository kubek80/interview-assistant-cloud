// TR-1: parse pasted text, .txt, .vtt and .srt into the normalised Transcript. Pure.
import { sha256Hex } from '../sha256';
import { MAX_TRANSCRIPT_CHARS, TranscriptError, type Transcript, type TranscriptFormat, type TranscriptSegment } from './types';

export type TextFormat = 'text' | 'vtt' | 'srt';

// ---------------------------------------------------------------------------------------------
// Small helpers

/** Strips a BOM, unifies line endings and removes control characters other than tab and newline. */
export function normaliseInput(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function collapse(s: string): string {
  return s.replace(/[\s\u00A0\u200B\u200E\u200F\uFEFF]+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

/** "01:02:03.500", "02:03", "0:0:5.430" (old Teams), "00:00:01,000" (SRT) → seconds; undefined if not a time. */
export function parseTimestamp(raw: string): number | undefined {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,9}))?$/.exec(raw.trim());
  if (!m) return undefined;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return undefined;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + min * 60 + sec + frac;
}

/** Seconds → "hh:mm:ss" (whole seconds, floored). */
export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

const TIMING = /^\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,9})?)\s*-->\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,9})?)/;

const NAME_CONNECTORS = new Set(['de', 'del', 'der', 'van', 'von', 'da', 'di', 'du', 'la', 'le', 'bin', 'al', 'el', 'y', 'and']);

/**
 * Whether a string looks like a speaker label. `strict` (used when there is no colon to mark it)
 * also requires a capital first letter and capitalised words, so ordinary sentences are not taken as names.
 */
export function looksLikeName(raw: string, strict: boolean): boolean {
  const s = raw.trim();
  if (s.length < 1 || s.length > 60) return false;
  if (/[?!;"“”…]|:\/\/|@/.test(s)) return false;
  if (!/^[\p{L}[(]/u.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length > 6) return false;
  if (!strict) return true;
  if (/[.,]$/.test(s) && !/\b\p{Lu}\.$/u.test(s)) return false;
  const letterWords = words.map((w) => w.replace(/^[^\p{L}]+/u, '')).filter((w) => w.length > 0);
  if (!letterWords.length || !/^\p{Lu}/u.test(letterWords[0])) return false;
  return letterWords.every((w) => /^\p{Lu}/u.test(w) || NAME_CONNECTORS.has(w.toLowerCase()) || /^\(/.test(w));
}

/** "Jane Doe: hello" → { speaker: "Jane Doe", text: "hello" }. */
function splitColonLabel(line: string): { speaker: string; text: string } | null {
  const m = /^([^:]{1,60}?)\s*:(?:\s+(.*)|$)/u.exec(line);
  if (!m) return null;
  const label = m[1].replace(/^[-–—]\s*/, '').trim();
  if (!looksLikeName(label, false)) return null;
  // A clock time such as "10:30" never gets here (no space after the colon), but "Note: ..." can;
  // single labels are discarded later unless the label recurs.
  return { speaker: label, text: (m[2] ?? '').trim() };
}

// ---------------------------------------------------------------------------------------------
// Segment building

interface RawSegment extends TranscriptSegment {
  /** Speaker came from a "Name: text" colon label, which needs confirmation by recurrence. */
  colonLabel?: boolean;
  /** Original text including a colon label, to restore it if the label is rejected. */
  original?: string;
}

function push(out: RawSegment[], seg: RawSegment): void {
  const text = collapse(seg.text);
  if (!text) return;
  const speaker = seg.speaker ? collapse(seg.speaker) : undefined;
  out.push({ ...seg, text, speaker: speaker || undefined });
}

/**
 * Colon labels ("Name: text") are only trusted when the same label occurs at least twice, or two
 * different labels occur; otherwise a lone "Note: ..." would become a speaker.
 */
function confirmColonLabels(segs: RawSegment[]): RawSegment[] {
  const counts = new Map<string, number>();
  for (const s of segs) if (s.colonLabel && s.speaker) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const trusted = total >= 2;
  return segs.map((s) => {
    if (!s.colonLabel || trusted) return s;
    return { startSec: s.startSec, text: collapse(s.original ?? s.text) };
  });
}

function mergeSameSpeaker(segs: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.speaker && prev.speaker === s.speaker) {
      prev.text = `${prev.text} ${s.text}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function finalise(segs: RawSegment[]): TranscriptSegment[] {
  return segs
    .map((s) => {
      const seg: TranscriptSegment = { text: collapse(s.text) };
      if (s.speaker) seg.speaker = s.speaker;
      if (s.startSec != null && Number.isFinite(s.startSec)) seg.startSec = s.startSec;
      return seg;
    })
    .filter((s) => s.text.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Caption payloads (VTT / SRT / cue blocks)

const VOICE = /<v(?:\.[^\s>]*)?(?:\s+([^>]*))?>/gi;

function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/<\d[^>]*>/g, '');
}

/** Splits a caption payload into speaker turns using <v Speaker> voice tags or "Name: text" labels. */
function parseCuePayload(lines: string[], startSec: number | undefined, out: RawSegment[], bareNameFirstLine: boolean): void {
  const joined = lines.join('\n');
  if (/<v[\s.>]/i.test(joined)) {
    // Each <v ...> opens a new turn; text before the first tag belongs to no one.
    VOICE.lastIndex = 0;
    let last = 0;
    let speaker: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = VOICE.exec(joined))) {
      push(out, { speaker, startSec, text: decodeEntities(stripTags(joined.slice(last, m.index))) });
      speaker = m[1] ? decodeEntities(m[1]).trim() || undefined : undefined;
      last = m.index + m[0].length;
    }
    push(out, { speaker, startSec, text: decodeEntities(stripTags(joined.slice(last))) });
    return;
  }
  const clean = lines.map((l) => decodeEntities(stripTags(l)).trim()).filter((l) => l.length > 0);
  if (!clean.length) return;
  // Old Teams exports: timing line, then the speaker's name on its own line, then the text.
  if (bareNameFirstLine && clean.length >= 2 && !clean[0].includes(':') && looksLikeName(clean[0], false) && clean[0].split(/\s+/).length <= 5) {
    push(out, { speaker: clean[0], startSec, text: clean.slice(1).join(' ') });
    return;
  }
  // "Name: text" (Zoom). A new label part-way through starts a new turn.
  let current: RawSegment | null = null;
  for (const line of clean) {
    const label = splitColonLabel(line.replace(/^-\s+/, ''));
    const bracket = /^\[([^\]]{1,60})\]\s*(.*)$/.exec(line);
    if (label) {
      if (current) push(out, current);
      current = { speaker: label.speaker, startSec, text: label.text, colonLabel: true, original: line };
    } else if (bracket && looksLikeName(bracket[1], false)) {
      if (current) push(out, current);
      current = { speaker: bracket[1], startSec, text: bracket[2] };
    } else if (current) {
      current.text += ` ${line}`;
      if (current.original != null) current.original += ` ${line}`;
    } else {
      current = { startSec, text: line };
    }
  }
  if (current) push(out, current);
}

function parseVtt(text: string): RawSegment[] {
  const lines = text.split('\n');
  const out: RawSegment[] = [];
  let i = 0;
  // Header block: "WEBVTT" plus optional header lines up to the first blank line.
  if (/^WEBVTT/.test(lines[0] ?? '')) {
    while (i < lines.length && lines[i].trim() !== '') i++;
  }
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    const block: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') block.push(lines[i++]);
    if (!block.length) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(block[0])) continue;
    const t = block.findIndex((l) => TIMING.test(l));
    if (t < 0 || t > 1) continue;
    const start = parseTimestamp(TIMING.exec(block[t])![1]);
    parseCuePayload(block.slice(t + 1), start, out, false);
  }
  return mergeSameSpeaker(confirmColonLabels(out));
}

function parseSrt(text: string): RawSegment[] {
  return parseCueLines(text.split('\n'), false);
}

/** Cue blocks introduced by a timing line ("start --> end"), with or without blank lines between them. */
function parseCueLines(lines: string[], bareNameFirstLine: boolean): RawSegment[] {
  const out: RawSegment[] = [];
  let start: number | undefined;
  let payload: string[] = [];
  let inCue = false;
  const preamble: string[] = [];
  const flush = () => {
    if (inCue) parseCuePayload(payload, start, out, bareNameFirstLine);
    payload = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timing = TIMING.exec(line);
    if (timing) {
      flush();
      inCue = true;
      start = parseTimestamp(timing[1]);
      continue;
    }
    if (!inCue) {
      if (line.trim()) preamble.push(line);
      continue;
    }
    // SRT cue numbers and VTT/Teams cue ids sit on the line before a timing line; they are not speech.
    const next = lines[i + 1];
    if (/^\s*\d+\s*$/.test(line) && next != null && TIMING.test(next)) continue;
    if (/^\s*[\w-]+\/[\w-]+\s*$/.test(line) && next != null && TIMING.test(next)) continue; // Teams cue id
    if (line.trim() === '') {
      flush();
      inCue = true; // keep collecting under the same timing until the next timing line
      continue;
    }
    payload.push(line);
  }
  flush();
  const pre: RawSegment[] = [];
  for (const p of preamble) if (!/^\s*\d+\s*$/.test(p) && !/^WEBVTT/.test(p)) push(pre, { text: decodeEntities(p) });
  return mergeSameSpeaker(confirmColonLabels([...pre, ...out]));
}

// ---------------------------------------------------------------------------------------------
// Plain text (pasted, .txt, and the paragraphs of a .docx)

/** "Jane Doe   0:03" / "Jane Doe 00:01:23" (Teams), or "[Jane Doe] 09:01:23 text" (Zoom). */
const NAME_THEN_TIME = /^(.{1,60}?)\s+\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\)?\s*$/;
const BRACKET_NAME_TIME = /^\[([^\]]{1,60})\]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
const LEADING_TIME = /^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s+(.*)$/;

function parsePlain(text: string): RawSegment[] {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return [];

  // 1. Cue blocks with timing arrows (old Teams .docx, SRT/VTT pasted without a header).
  const timingCount = nonEmpty.filter((l) => TIMING.test(l)).length;
  if (timingCount >= 2) return parseCueLines(lines, true);

  // 2. Teams heading lines: a name followed by a time, then what they said on the next line(s).
  const isHeader = (l: string) => {
    const m = NAME_THEN_TIME.exec(l.trim());
    return !!m && looksLikeName(m[1], true) && parseTimestamp(m[2]) != null;
  };
  const isBracketHeader = (l: string) => {
    const m = BRACKET_NAME_TIME.exec(l.trim());
    return !!m && looksLikeName(m[1], false);
  };
  const headerCount = nonEmpty.filter(isHeader).length;
  const bracketCount = nonEmpty.filter(isBracketHeader).length;
  if (headerCount >= 2 && headerCount >= nonEmpty.length * 0.2) return parseHeaded(lines, 'name-time');
  if (bracketCount >= 2) return parseHeaded(lines, 'bracket');

  // 3. One turn per line or paragraph, optionally "[00:01:02] Name: text".
  const out: RawSegment[] = [];
  let current: RawSegment | null = null;
  let pendingSpeaker: { speaker: string; startSec?: number; original: string } | null = null;
  const flush = () => {
    if (current) push(out, current);
    current = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    let rest = line;
    let startSec: number | undefined;
    const lt = LEADING_TIME.exec(rest);
    if (lt && parseTimestamp(lt[1]) != null) {
      startSec = parseTimestamp(lt[1]);
      rest = lt[2];
    }
    const label = splitColonLabel(rest);
    if (label && label.text) {
      flush();
      current = { speaker: label.speaker, startSec, text: label.text, colonLabel: true, original: rest };
      pendingSpeaker = null;
    } else if (label && !label.text) {
      flush();
      pendingSpeaker = { speaker: label.speaker, startSec, original: rest };
    } else if (pendingSpeaker) {
      current = { speaker: pendingSpeaker.speaker, startSec: pendingSpeaker.startSec ?? startSec, text: rest, colonLabel: true, original: `${pendingSpeaker.original} ${rest}` };
      pendingSpeaker = null;
    } else if (current && startSec == null) {
      current.text += ` ${rest}`;
      if (current.original != null) current.original += ` ${rest}`;
    } else {
      flush();
      current = { startSec, text: rest };
    }
  }
  flush();
  return confirmColonLabels(out);
}

function parseHeaded(lines: string[], kind: 'name-time' | 'bracket'): RawSegment[] {
  const out: RawSegment[] = [];
  let current: RawSegment | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (kind === 'name-time') {
      const m = NAME_THEN_TIME.exec(line);
      if (m && looksLikeName(m[1], true) && parseTimestamp(m[2]) != null) {
        if (current) push(out, current);
        current = { speaker: m[1], startSec: parseTimestamp(m[2]), text: '' };
        continue;
      }
    } else {
      const m = BRACKET_NAME_TIME.exec(line);
      if (m && looksLikeName(m[1], false)) {
        if (current) push(out, current);
        current = { speaker: m[1], startSec: parseTimestamp(m[2]), text: m[3] };
        continue;
      }
    }
    if (current) current.text += ` ${line}`;
    else push(out, { text: line }); // preamble such as the meeting title and date
  }
  if (current) push(out, current);
  return mergeSameSpeaker(out);
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Guesses the format of pasted or uploaded text. */
export function detectTextFormat(text: string): TextFormat {
  const t = normaliseInput(text).trimStart();
  if (/^WEBVTT/.test(t)) return 'vtt';
  const first = t.split('\n').slice(0, 3);
  if (/^\d+\s*$/.test(first[0] ?? '') && /-->/.test(first[1] ?? '') && /,\d/.test(first[1] ?? '')) return 'srt';
  return 'text';
}

/** Renders segments as the plain-text form (one line per segment). */
export function renderSegment(seg: TranscriptSegment, speakerOverride?: string): string {
  const speaker = speakerOverride ?? seg.speaker;
  return `${seg.startSec != null ? `[${formatTimestamp(seg.startSec)}] ` : ''}${speaker ? `${speaker}: ` : ''}${seg.text}`;
}

/** Builds the normalised Transcript (rendering, speakers, hash) from segments. */
export function buildTranscript(format: TranscriptFormat, segments: readonly TranscriptSegment[]): Transcript {
  const segs = segments.map((s) => ({ ...s })).filter((s) => s.text.trim().length > 0);
  if (!segs.length) throw new TranscriptError('empty', 'The transcript has no text.');
  const text = segs.map((s) => renderSegment(s)).join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptError('too_large', `The transcript is too long (${text.length.toLocaleString('en')} characters; the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString('en')}).`);
  }
  const speakers: string[] = [];
  for (const s of segs) if (s.speaker && !speakers.includes(s.speaker)) speakers.push(s.speaker);
  const wordCount = segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  return { format, segments: segs, text, speakers, hash: sha256Hex(text), wordCount };
}

/**
 * TR-1: parse pasted text or the contents of a .txt/.vtt/.srt file.
 * Throws TranscriptError ('empty' | 'too_large').
 */
export function parseTranscriptText(input: string, options: { format?: TextFormat | 'auto'; sourceFormat?: TranscriptFormat } = {}): Transcript {
  if (input.length > MAX_TRANSCRIPT_CHARS * 4) {
    throw new TranscriptError('too_large', 'The transcript is too large to read.');
  }
  const text = normaliseInput(input);
  if (!text.trim()) throw new TranscriptError('empty', 'The transcript is empty.');
  const format = !options.format || options.format === 'auto' ? detectTextFormat(text) : options.format;
  const raw = format === 'vtt' ? parseVtt(text) : format === 'srt' ? parseSrt(text) : parsePlain(text);
  return buildTranscript(options.sourceFormat ?? format, finalise(raw));
}
