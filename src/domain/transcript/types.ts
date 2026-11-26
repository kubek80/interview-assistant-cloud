// TR-1: one normalised shape for every transcript source (paste, .txt, .vtt, .srt, .docx).

export type TranscriptFormat = 'text' | 'vtt' | 'srt' | 'docx';

export interface TranscriptSegment {
  /** Speaker name as it appears in the source (e.g. "Jane Doe"); absent when the source has none. */
  speaker?: string;
  /** Start time in seconds from the beginning of the recording, when the source has it. */
  startSec?: number;
  /** What was said: one line, whitespace collapsed, never empty. */
  text: string;
}

export interface Transcript {
  /** Detected source format. */
  format: TranscriptFormat;
  /** Ordered segments. Segment i is line i + 1 of `text`. */
  segments: TranscriptSegment[];
  /**
   * Plain-text rendering, one segment per line, joined with "\n":
   * `[hh:mm:ss] Speaker: text` (each part only when present). Line numbers are stable:
   * line n (1-based) is always segments[n - 1].
   */
  text: string;
  /** Distinct speaker names in order of first appearance. */
  speakers: string[];
  /** AI-8 transcript fingerprint: SHA-256 (hex) of `text`. */
  hash: string;
  /** Number of words across all segments (whitespace-separated). */
  wordCount: number;
}

export type TranscriptErrorCode = 'empty' | 'too_large' | 'unreadable' | 'unsupported_format';

/** Thrown by every transcript parser; `message` is safe to show to the user and contains no transcript text. */
export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;
  constructor(code: TranscriptErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
  }
}

/** Largest file accepted (bytes). A Teams .docx export of a long interview is well under 1 MB. */
export const MAX_TRANSCRIPT_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Largest normalised transcript (characters of `text`). About 8 hours of speech; also the ceiling
 * for one AI second-opinion call (roughly 125k tokens), so no chunking is needed.
 */
export const MAX_TRANSCRIPT_CHARS = 500_000;
/** Largest uncompressed word/document.xml accepted from a .docx (zip-bomb guard). */
export const MAX_DOCX_XML_BYTES = 40 * 1024 * 1024;
