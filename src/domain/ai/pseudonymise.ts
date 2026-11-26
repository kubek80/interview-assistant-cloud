// AI-5: replace speaker names with "Candidate", "Interviewer 1", ... before anything is sent. Pure.
import { renderSegment } from '../transcript/parse';
import type { Transcript } from '../transcript/types';
import { CANDIDATE_LABEL, SPEAKER_LABEL_PATTERN } from './types';

/** Speaker name as found in the transcript → label chosen by the person running the AI. */
export type SpeakerMapping = Record<string, string>;

export interface PseudonymisedLine {
  /** 1-based line number in `text`; line n is transcript segment n - 1. */
  line: number;
  /** Label, e.g. "Candidate"; absent when the segment had no speaker. */
  speaker?: string;
  /** What was said, with names scrubbed. */
  text: string;
}

export interface PseudonymisedTranscript {
  /** The exact transcript text that is sent. */
  text: string;
  lines: PseudonymisedLine[];
  /** Distinct labels used, in order of first appearance. */
  speakers: string[];
  /** Transcript.hash of the source transcript (AI-8). */
  sourceHash: string;
  /** How many names were replaced inside the spoken text. */
  replacedNameCount: number;
}

export interface SpeakerMappingProblem {
  code: 'unmapped-speaker' | 'invalid-label' | 'no-candidate' | 'unknown-speaker';
  speaker?: string;
  message: string;
}

/** Words that appear in speaker names but are not names (Teams/Zoom decorations, titles). */
const NOT_NAME_WORDS = new Set([
  'guest', 'external', 'unverified', 'host', 'co-host', 'cohost', 'organizer', 'organiser', 'presenter', 'attendee', 'speaker',
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'she', 'her', 'he', 'him', 'they', 'them', 'his', 'hers', 'theirs',
  'the', 'and', 'of', 'de', 'del', 'der', 'van', 'von', 'da', 'di', 'du', 'la', 'le', 'al', 'el', 'bin', 'jr', 'sr', 'ii', 'iii',
  'iphone', 'ipad', 'android', 'phone', 'room', 'meeting', 'interviewer', 'candidate', 'other', 'unknown',
]);

/**
 * Name parts that are also everyday English words. Whole-word, case-insensitive replacement would
 * scrub the verb in "I will", so these are only replaced when written with a capital letter.
 */
const COMMON_WORD_NAMES = new Set([
  'will', 'may', 'mark', 'bill', 'rose', 'grace', 'hope', 'joy', 'faith', 'june', 'april', 'august', 'frank', 'art', 'guy', 'sky',
  'summer', 'ray', 'max', 'pat', 'sue', 'rob', 'jack', 'dawn', 'drew', 'gene', 'wade', 'chase', 'hunter', 'page', 'king', 'young',
  'long', 'black', 'white', 'brown', 'green', 'gray', 'grey', 'bell', 'hall', 'wood', 'hill', 'stone', 'well', 'wells', 'small',
  'little', 'rich', 'sterling', 'ivy', 'iris', 'holly', 'river', 'sunny', 'buck', 'bob', 'don', 'van', 'sandy', 'harry', 'mason',
  'cook', 'baker', 'smith', 'miller', 'carter', 'cooper', 'turner', 'parker', 'archer', 'fisher', 'price', 'case', 'love', 'early',
]);

const LETTERS = "\\p{L}\\p{M}";
const APOS = "['\u2019]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A literal → regex source that tolerates any whitespace and either apostrophe. */
function flexible(s: string): string {
  return escapeRe(s).replace(/\s+/g, '\\s+').replace(/['\u2019]/g, APOS);
}

/** Variants of a speaker name to scrub: the full name, "Last, First" reordered, and its name parts. */
export function nameVariants(speaker: string): { phrases: string[]; parts: string[] } {
  const base = speaker
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // "(Guest)", "[External]"
    .split(/[|<]/)[0] // "Jane Doe | Contoso", "Jane Doe <jane@...>"
    .replace(/\s+/g, ' ')
    .trim();
  const phrases = new Set<string>();
  if (base.split(' ').length > 1 || base.includes(',')) phrases.add(base.replace(/,/g, '').replace(/\s+/g, ' ').trim());
  const comma = /^([^,]+),\s*(.+)$/.exec(base);
  if (comma) phrases.add(`${comma[2]} ${comma[1]}`.trim());
  const parts = new Set<string>();
  for (const token of base.split(/[\s,]+/)) {
    const t = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (t.length < 2) continue;
    if (NOT_NAME_WORDS.has(t.toLowerCase())) continue;
    if (!/^[\p{L}\p{M}'\u2019-]+$/u.test(t)) continue;
    parts.add(t);
  }
  return { phrases: [...phrases].filter((p) => p.length >= 2), parts: [...parts] };
}

interface Replacer {
  re: RegExp;
  label: string;
}

function buildReplacers(names: Array<{ name: string; label: string }>): Replacer[] {
  const entries: Array<{ pattern: string; label: string; caseSensitive: boolean; length: number }> = [];
  for (const { name, label } of names) {
    const { phrases, parts } = nameVariants(name);
    for (const p of phrases) entries.push({ pattern: flexible(p), label, caseSensitive: false, length: p.length });
    for (const p of parts) {
      const common = COMMON_WORD_NAMES.has(p.toLowerCase());
      const src = common ? escapeRe(p[0].toUpperCase()) + flexible(p.slice(1).toLowerCase()) : flexible(p);
      entries.push({ pattern: src, label, caseSensitive: common, length: p.length });
    }
  }
  // Longest first, so "Sam O'Neill" is replaced before "Sam".
  entries.sort((a, b) => b.length - a.length);
  return entries.map((e) => ({
    re: new RegExp(`(?<![${LETTERS}\\p{N}])${e.pattern}(?![${LETTERS}\\p{N}])`, e.caseSensitive ? 'gu' : 'giu'),
    label: e.label,
  }));
}

/** Replaces every name in `text`; returns the new text and how many replacements were made. */
export function scrubNames(text: string, replacers: readonly Replacer[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of replacers) {
    out = out.replace(r.re, () => {
      count++;
      return r.label;
    });
  }
  return { text: out, count };
}

/**
 * AI-5 suggestion only: the speaker who says the most words is probably the candidate; everyone
 * else becomes "Interviewer 1", "Interviewer 2", ... in order of first appearance.
 */
export function suggestSpeakerMapping(transcript: Pick<Transcript, 'segments' | 'speakers'>): SpeakerMapping {
  const words = new Map<string, number>();
  for (const s of transcript.segments) {
    if (!s.speaker) continue;
    words.set(s.speaker, (words.get(s.speaker) ?? 0) + s.text.split(/\s+/).filter(Boolean).length);
  }
  let candidate: string | null = null;
  for (const sp of transcript.speakers) if (candidate == null || (words.get(sp) ?? 0) > (words.get(candidate) ?? 0)) candidate = sp;
  const mapping: SpeakerMapping = {};
  let n = 0;
  for (const sp of transcript.speakers) mapping[sp] = sp === candidate ? CANDIDATE_LABEL : `Interviewer ${++n}`;
  return mapping;
}

/** AI-5: checks a mapping before a run. Empty means it can be used. */
export function checkSpeakerMapping(transcript: Pick<Transcript, 'speakers'>, mapping: SpeakerMapping): SpeakerMappingProblem[] {
  const problems: SpeakerMappingProblem[] = [];
  for (const sp of transcript.speakers) {
    const label = mapping[sp];
    if (label == null || label === '') problems.push({ code: 'unmapped-speaker', speaker: sp, message: `Choose a label for speaker ${transcript.speakers.indexOf(sp) + 1}.` });
    else if (!SPEAKER_LABEL_PATTERN.test(label)) problems.push({ code: 'invalid-label', speaker: sp, message: `"${label}" is not an allowed label. Use Candidate, Interviewer 1, Interviewer 2, ...` });
  }
  for (const sp of Object.keys(mapping)) {
    if (!transcript.speakers.includes(sp)) problems.push({ code: 'unknown-speaker', speaker: sp, message: 'The mapping names a speaker who is not in the transcript.' });
  }
  if (transcript.speakers.length > 0 && !transcript.speakers.some((sp) => mapping[sp] === CANDIDATE_LABEL)) {
    problems.push({ code: 'no-candidate', message: 'Mark which speaker is the candidate.' });
  }
  return problems;
}

/**
 * AI-5: the transcript as it will be sent. Speaker names become their labels, and every speaker's
 * name (and any `extraNames`, e.g. the candidate's name when the transcript calls them "Guest") is
 * replaced inside the spoken text too: whole words, case-insensitive (name parts that are also
 * common words, such as "Will", only when capitalised). Throws if the mapping has problems.
 */
export function pseudonymiseTranscript(
  transcript: Pick<Transcript, 'segments' | 'speakers' | 'hash'>,
  mapping: SpeakerMapping,
  extraNames: ReadonlyArray<{ name: string; label: string }> = [],
): PseudonymisedTranscript {
  const problems = checkSpeakerMapping(transcript, mapping);
  if (problems.length) throw new Error(problems.map((p) => p.message).join(' '));
  for (const e of extraNames) if (!SPEAKER_LABEL_PATTERN.test(e.label)) throw new Error(`"${e.label}" is not an allowed label.`);
  const replacers = buildReplacers([...transcript.speakers.map((name) => ({ name, label: mapping[name] })), ...extraNames]);
  let replacedNameCount = 0;
  const speakers: string[] = [];
  const lines: PseudonymisedLine[] = transcript.segments.map((seg, i) => {
    const scrubbed = scrubNames(seg.text, replacers);
    replacedNameCount += scrubbed.count;
    const label = seg.speaker ? mapping[seg.speaker] : undefined;
    if (label && !speakers.includes(label)) speakers.push(label);
    const line: PseudonymisedLine = { line: i + 1, text: scrubbed.text };
    if (label) line.speaker = label;
    return line;
  });
  const text = transcript.segments.map((seg, i) => renderSegment({ startSec: seg.startSec, text: lines[i].text }, lines[i].speaker)).join('\n');
  return { text, lines, speakers, sourceHash: transcript.hash, replacedNameCount };
}
