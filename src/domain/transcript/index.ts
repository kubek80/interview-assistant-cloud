// TR-1: transcript import. Public entry points for the screens.
import { extractDocxText, isZip } from './docx';
import { parseTranscriptText, type TextFormat } from './parse';
import { MAX_TRANSCRIPT_FILE_BYTES, TranscriptError, type Transcript } from './types';

export * from './types';
export { buildTranscript, detectTextFormat, formatTimestamp, parseTimestamp, parseTranscriptText, renderSegment, type TextFormat } from './parse';
export { extractDocxText } from './docx';

/** File extensions offered in the file picker (TR-1). */
export const TRANSCRIPT_FILE_ACCEPT = '.txt,.vtt,.srt,.docx,text/plain,text/vtt,application/x-subrip,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The minimal File/Blob surface we need, so tests can pass plain objects. */
export interface TranscriptFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Decodes text as UTF-8 (or UTF-16 with a BOM), falling back to Windows-1252 for legacy files. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      throw new TranscriptError('unreadable', 'The file is not readable text.');
    }
  }
}

/**
 * TR-1: parse a chosen file (.txt, .vtt, .srt or .docx). The format is taken from the content
 * where it is unambiguous (a zip is a .docx, "WEBVTT" is WebVTT) and otherwise from the extension.
 * Throws TranscriptError with a message that is safe to show.
 */
export async function parseTranscriptFile(file: TranscriptFileLike): Promise<Transcript> {
  if (file.size === 0) throw new TranscriptError('empty', 'The file is empty.');
  if (file.size > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new TranscriptError('too_large', `The file is too large (the limit is ${MAX_TRANSCRIPT_FILE_BYTES / (1024 * 1024)} MB).`);
  }
  const ext = extensionOf(file.name);
  if (ext === 'doc' || ext === 'pdf' || ext === 'rtf') {
    throw new TranscriptError('unsupported_format', `.${ext} files are not supported. Use .txt, .vtt, .srt or .docx.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new TranscriptError('unreadable', 'The file could not be read.');
  }
  if (isZip(bytes)) {
    const text = await extractDocxText(bytes);
    return parseTranscriptText(text, { format: 'text', sourceFormat: 'docx' });
  }
  if (ext === 'docx') throw new TranscriptError('unreadable', 'This .docx file could not be read (not a Word document).');
  if (bytes.subarray(0, 1024).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
    throw new TranscriptError('unsupported_format', 'The file is not a text transcript. Use .txt, .vtt, .srt or .docx.');
  }
  const text = decodeTextBytes(bytes);
  const format: TextFormat | 'auto' = ext === 'vtt' ? 'vtt' : ext === 'srt' ? 'srt' : 'auto';
  return parseTranscriptText(text, { format });
}
