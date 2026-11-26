// TR-1: read the text of a .docx (Teams transcript export) without a dependency.
//
// A .docx is a zip archive; the text is in word/document.xml. We read the zip's central directory
// (which holds reliable sizes even when the local headers use data descriptors), then inflate the one
// entry with the platform's DecompressionStream('deflate-raw') (all current browsers and Node 22).
// That is ~150 lines and avoids adding fflate to an app whose CSP and offline bundle we keep small.
// Encrypted, multi-disk and zip64 archives are rejected with a clear error.
import { MAX_DOCX_XML_BYTES, TranscriptError } from './types';
import { decodeEntities } from './parse';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const unreadable = (detail: string) => new TranscriptError('unreadable', `This .docx file could not be read (${detail}).`);

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Lists the entries of a zip archive from its central directory. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 + 65535 (max comment) bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable('not a zip archive');
  const disk = view.getUint16(eocd + 4, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0) throw unreadable('multi-part archive');
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw unreadable('zip64 archive');
  if (cdOffset + cdSize > bytes.length) throw unreadable('truncated archive');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) throw unreadable('damaged directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw unreadable('this browser cannot unpack .docx files');
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new TranscriptError('too_large', 'The text inside this .docx file is too large.');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof TranscriptError) throw e;
    throw unreadable('damaged compressed data');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Returns the uncompressed bytes of one zip entry. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, limit = MAX_DOCX_XML_BYTES): Promise<Uint8Array> {
  if (entry.flags & 0x1) throw unreadable('the file is password-protected');
  if (entry.uncompressedSize > limit) throw new TranscriptError('too_large', 'The text inside this .docx file is too large.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > bytes.length || view.getUint32(lh, true) !== SIG_LOCAL) throw unreadable('damaged entry');
  const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw unreadable('truncated archive');
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data, limit);
  throw unreadable(`unsupported compression method ${entry.method}`);
}

/**
 * Extracts paragraphs from WordprocessingML: one line per <w:p>, tabs for <w:tab/>, line breaks
 * for <w:br/>. Deleted text (<w:del>) and field instructions are skipped.
 */
export function documentXmlToText(xml: string): string {
  const body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
  const paragraphs: string[] = [];
  const pRe = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(body))) {
    const inner = m[1] ?? '';
    let line = '';
    const tokRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g;
    let t: RegExpExecArray | null;
    while ((t = tokRe.exec(inner))) {
      if (t[1] != null) line += decodeEntities(t[1]);
      else line += t[2] === 'tab' ? '\t' : '\n';
    }
    paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

/** TR-1: the plain text of a .docx file, paragraph per line. */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  if (!isZip(bytes)) throw unreadable('not a Word document');
  const entries = readZipDirectory(bytes);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw unreadable('no document text found');
  const xml = new TextDecoder('utf-8').decode(await readZipEntry(bytes, doc));
  return documentXmlToText(xml);
}
