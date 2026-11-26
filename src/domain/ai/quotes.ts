// AI-6: check every quotation against the transcript text that was sent. Pure.
import type { AiQuotation } from './types';

export interface QuoteSourceLine {
  /** 1-based line number. */
  line: number;
  speaker?: string;
  /** Spoken text of the line (without timestamp or speaker label). */
  text: string;
}

/** Lower-case letters and digits only, single spaces: "Don't — wait…" → "don t wait". */
export function normaliseForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`]/g, '') // "don't" and "dont" match
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Splits on ellipses ("...", "…", "[...]", "(…)") that join two real spans. */
function splitOnEllipses(quote: string): string[] {
  return quote.split(/\s*[[(]?(?:\.{3,}|…)[\])]?\s*/).filter((p) => normaliseForMatch(p).length > 0);
}

export interface QuoteIndex {
  /** " " + normalised text of all lines joined + " ". */
  haystack: string;
  /** Start offset of each line in `haystack`, ascending. */
  starts: number[];
  lines: readonly QuoteSourceLine[];
}

export function buildQuoteIndex(lines: readonly QuoteSourceLine[]): QuoteIndex {
  let haystack = ' ';
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(haystack.length);
    const norm = normaliseForMatch(l.text);
    haystack += norm ? `${norm} ` : '';
  }
  return { haystack, starts, lines };
}

function lineAt(index: QuoteIndex, offset: number): QuoteSourceLine | null {
  let lo = 0;
  let hi = index.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.starts[mid] <= offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Skip empty lines that share a start offset with the next one.
  while (found >= 0 && found + 1 < index.starts.length && index.starts[found + 1] === index.starts[found]) found++;
  return found >= 0 ? index.lines[found] : null;
}

/**
 * AI-6: a quotation is verified when, ignoring case, punctuation and whitespace, it occurs in the
 * transcript (it may run across consecutive lines). Parts joined by an ellipsis must each occur,
 * in order. The line is where the quotation starts.
 */
export function verifyQuotation(quote: string, index: QuoteIndex): AiQuotation {
  const parts = splitOnEllipses(quote).map(normaliseForMatch);
  const unverified: AiQuotation = { text: quote, status: 'unverified', line: null, speaker: null };
  if (!parts.length) return unverified;
  let from = 0;
  let firstAt = -1;
  for (const part of parts) {
    const at = index.haystack.indexOf(` ${part} `, from);
    if (at < 0) return unverified;
    if (firstAt < 0) firstAt = at;
    from = at + part.length + 1;
  }
  const line = lineAt(index, firstAt + 1);
  return { text: quote, status: 'verified', line: line?.line ?? null, speaker: line?.speaker ?? null };
}

export function verifyQuotations(quotes: readonly string[], lines: readonly QuoteSourceLine[] | QuoteIndex): AiQuotation[] {
  const index = 'haystack' in lines ? lines : buildQuoteIndex(lines);
  return quotes.map((q) => verifyQuotation(q, index));
}
