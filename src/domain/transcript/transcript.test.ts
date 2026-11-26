import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../sha256';
import {
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_FILE_BYTES,
  TranscriptError,
  detectTextFormat,
  extractDocxText,
  formatTimestamp,
  parseTimestamp,
  parseTranscriptFile,
  parseTranscriptText,
  type TranscriptFileLike,
} from './index';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fileLike = (name: string, bytes?: Uint8Array): TranscriptFileLike => {
  const data = bytes ?? new Uint8Array(readFileSync(fixture(name)));
  return { name, size: data.byteLength, arrayBuffer: async () => data.slice().buffer };
};
const textFile = (name: string, text: string) => fileLike(name, new TextEncoder().encode(text));

async function expectError(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptError);
    expect((e as TranscriptError).code).toBe(code);
    return;
  }
  throw new Error(`expected TranscriptError ${code}`);
}

describe('TR-1 timestamps', () => {
  it('TR-1: parses VTT, SRT, short and old-Teams forms', () => {
    expect(parseTimestamp('00:01:02.500')).toBe(62.5);
    expect(parseTimestamp('00:00:04,250')).toBe(4.25);
    expect(parseTimestamp('1:02')).toBe(62);
    expect(parseTimestamp('0:0:5.430')).toBeCloseTo(5.43);
    expect(parseTimestamp('1:75')).toBeUndefined();
    expect(parseTimestamp('soon')).toBeUndefined();
    expect(formatTimestamp(3723.9)).toBe('01:02:03');
  });
});

describe('TR-1 WebVTT', () => {
  it('TR-1: reads Teams voice tags, merges consecutive cues by the same speaker and skips NOTE blocks', async () => {
    const t = await parseTranscriptFile(fileLike('teams.vtt'));
    expect(t.format).toBe('vtt');
    expect(t.speakers).toEqual(['Priya Natarajan', "Sam O'Neill"]);
    expect(t.segments).toHaveLength(3);
    expect(t.segments[0]).toEqual({
      speaker: 'Priya Natarajan',
      startSec: 3.12,
      text: "Thanks for joining, Sam. Let's start with test strategy. How would you decide what to automate first on a new product?",
    });
    expect(t.segments[1].text).toBe(
      'I start from risk. I map the critical user journeys with the product owner and automate the ones that are stable and run on every release & deploy.',
    );
    expect(t.text).not.toContain('NOTE');
    expect(t.text).not.toContain('0b6f2c1e');
    expect(t.text.split('\n')[2]).toBe('[00:01:02] Priya Natarajan: Great, thanks.');
  });

  it('TR-1: reads Zoom "Speaker: text" cues', async () => {
    const t = await parseTranscriptFile(fileLike('zoom.vtt'));
    expect(t.speakers).toEqual(['Priya Natarajan', "Sam O'Neill"]);
    expect(t.segments.map((s) => s.speaker)).toEqual(['Priya Natarajan', "Sam O'Neill", 'Priya Natarajan']);
    expect(t.segments[1].text).toMatch(/^Sure\. We had a checkout test .* explicit wait on the order API\.$/);
    expect(t.segments[1].startSec).toBe(5);
  });

  it('handles several voices in one cue and strips styling tags', () => {
    const t = parseTranscriptText('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v.loud Ann>Hi <b>there</b></v>\n<v Bob>Hello <00:00:02.000><c>again</c></v>\n');
    expect(t.segments).toEqual([
      { speaker: 'Ann', startSec: 1, text: 'Hi there' },
      { speaker: 'Bob', startSec: 1, text: 'Hello again' },
    ]);
  });
});

describe('TR-1 SubRip', () => {
  it('reads cue text across lines, removes cue numbers and italics', async () => {
    const t = await parseTranscriptFile(fileLike('sample.srt'));
    expect(t.format).toBe('srt');
    expect(t.speakers).toEqual(['Priya', 'Sam']);
    expect(t.text).toBe(
      [
        '[00:00:01] Priya: How do you report a bug that only happens in production?',
        '[00:00:04] Sam: I collect the logs, the request id and the exact build first.',
        '[00:01:10] Priya: Thanks.',
      ].join('\n'),
    );
  });
});

describe('TR-1 plain text', () => {
  it('TR-1: reads "Speaker: text" lines with continuation lines', async () => {
    const t = await parseTranscriptFile(fileLike('plain.txt'));
    expect(t.format).toBe('text');
    expect(t.speakers).toEqual(['Interviewer', 'Candidate']);
    expect(t.segments[1]).toEqual({ speaker: 'Candidate', text: 'We run the smoke tests on every commit. The full suite runs nightly in parallel shards.' });
    expect(t.segments).toHaveLength(4);
  });

  it('TR-1: reads a Teams copy-paste with name-and-time headings and keeps the preamble as text', async () => {
    const t = await parseTranscriptFile(fileLike('teams-paste.txt'));
    expect(t.speakers).toEqual(['Priya Natarajan', "Sam O'Neill"]);
    expect(t.segments.slice(0, 3).every((s) => !s.speaker)).toBe(true);
    expect(t.segments[4]).toEqual({ speaker: "Sam O'Neill", startSec: 13, text: 'I start from risk. I map the critical user journeys and automate the stable ones first.' });
  });

  it('does not invent a speaker from a single "Note: ..." line', () => {
    const t = parseTranscriptText('Note: the candidate joined late.\nWe talked about pipelines at 10:30 today.');
    expect(t.speakers).toEqual([]);
    expect(t.segments[0].text).toBe('Note: the candidate joined late. We talked about pipelines at 10:30 today.');
  });

  it('reads leading timestamps and a name on its own line', () => {
    const t = parseTranscriptText('[00:00:05] Ann: Question one?\n[00:00:09] Bob:\nMy answer.\n');
    expect(t.segments).toEqual([
      { speaker: 'Ann', startSec: 5, text: 'Question one?' },
      { speaker: 'Bob', startSec: 9, text: 'My answer.' },
    ]);
  });

  it('detects pasted WebVTT and SRT', () => {
    expect(detectTextFormat('\uFEFFWEBVTT\n\n')).toBe('vtt');
    expect(detectTextFormat('1\n00:00:01,000 --> 00:00:02,000\nhi')).toBe('srt');
    expect(detectTextFormat('hello')).toBe('text');
    expect(parseTranscriptText('1\r\n00:00:01,000 --> 00:00:02,000\r\nAnn: hi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBob: hello\r\n').speakers).toEqual(['Ann', 'Bob']);
  });
});

describe('TR-1 .docx (Teams export)', () => {
  it('TR-1: reads the current Teams layout (name and time heading, then text)', async () => {
    const t = await parseTranscriptFile(fileLike('teams-new.docx'));
    expect(t.format).toBe('docx');
    expect(t.speakers).toEqual(['Priya Natarajan', "Sam O'Neill"]);
    const sam = t.segments.find((s) => s.speaker === "Sam O'Neill")!;
    expect(sam).toEqual({ speaker: "Sam O'Neill", startSec: 13, text: 'I start from risk & map the critical user journeys. Then I automate the stable ones.' });
    expect(t.text).not.toContain('deleted words');
    expect(t.text).toContain('QA interview - senior engineer');
  });

  it('TR-1: reads the older Teams layout (timing line, speaker line, text)', async () => {
    const t = await parseTranscriptFile(fileLike('teams-old.docx'));
    expect(t.segments).toEqual([
      { speaker: 'Natarajan, Priya', startSec: 3.12, text: 'How do you test a payments API?' },
      { speaker: "O'Neill, Sam", startSec: 8.1, text: 'Contract tests first, then idempotency checks on retries.' },
    ]);
  });

  it('reads stored (uncompressed) entries and entries written with data descriptors', async () => {
    const xml = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Ann: one</w:t></w:r></w:p><w:p><w:r><w:t>Bob: two</w:t></w:r></w:p></w:body></w:document>';
    for (const method of [0, 8] as const) {
      const zip = makeZip([{ name: 'word/document.xml', data: new TextEncoder().encode(xml), method, descriptor: method === 8 }]);
      expect(await extractDocxText(zip)).toBe('Ann: one\nBob: two');
    }
  });

  it('rejects a damaged or foreign zip with a readable error', async () => {
    await expectError(parseTranscriptFile(fileLike('x.docx', new TextEncoder().encode('not a zip'))), 'unreadable');
    const other = makeZip([{ name: 'xl/workbook.xml', data: new TextEncoder().encode('<x/>'), method: 8 }]);
    await expectError(parseTranscriptFile(fileLike('book.docx', other)), 'unreadable');
    const truncated = new Uint8Array(readFileSync(fixture('teams-new.docx'))).slice(0, 300);
    await expectError(parseTranscriptFile(fileLike('cut.docx', truncated)), 'unreadable');
  });
});

describe('TR-1 limits and errors', () => {
  it('TR-1: rejects empty input, oversized files and oversized text', async () => {
    await expectError(() => parseTranscriptText('  \n\n '), 'empty');
    await expectError(parseTranscriptFile(textFile('a.txt', '')), 'empty');
    await expectError(parseTranscriptFile({ name: 'big.txt', size: MAX_TRANSCRIPT_FILE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }), 'too_large');
    await expectError(() => parseTranscriptText('word '.repeat(MAX_TRANSCRIPT_CHARS / 4)), 'too_large');
  });

  it('TR-1: rejects binary and legacy Word files', async () => {
    await expectError(parseTranscriptFile(fileLike('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))), 'unsupported_format');
    await expectError(parseTranscriptFile(fileLike('x.txt', new Uint8Array([0x41, 0, 0, 0x42]))), 'unsupported_format');
  });

  it('decodes UTF-16 and Windows-1252 text files', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('Ann: café', (c) => [c.charCodeAt(0), 0]).flat()]);
    expect((await parseTranscriptFile(fileLike('a.txt', utf16))).text).toBe('Ann: café');
    const cp1252 = new Uint8Array([...new TextEncoder().encode('Bob said '), 0x93, 0x68, 0x69, 0x94]);
    expect((await parseTranscriptFile(fileLike('b.txt', cp1252))).text).toBe('Bob said “hi”');
  });
});

describe('TR-1 / AI-8 rendering and fingerprint', () => {
  it('TR-1: numbers lines one per segment and hashes the rendering', () => {
    const t = parseTranscriptText('Ann: one\n\nBob: two\n\nAnn: three');
    expect(t.text.split('\n')).toHaveLength(t.segments.length);
    expect(t.hash).toBe(sha256Hex(t.text));
    expect(t.wordCount).toBe(3);
  });

  it('gives the same fingerprint for the same content however it was formatted', () => {
    const a = parseTranscriptText('Ann: one\r\nBob:   two  ');
    const b = parseTranscriptText('\uFEFFAnn: one\nBob: two\n');
    expect(a.hash).toBe(b.hash);
    expect(parseTranscriptText('Ann: one\nBob: two!').hash).not.toBe(a.hash);
  });
});

// ---------------------------------------------------------------------------------------------
// A tiny zip writer for test archives (stored or deflated, optionally with data descriptors).

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function makeZip(files: Array<{ name: string; data: Uint8Array; method: 0 | 8; descriptor?: boolean }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const body = f.method === 8 ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = crc32(f.data);
    const flags = f.descriptor ? 0x8 : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, f.method, true);
    local.setUint32(14, f.descriptor ? 0 : crc, true);
    local.setUint32(18, f.descriptor ? 0 : body.length, true);
    local.setUint32(22, f.descriptor ? 0 : f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    let size = 30 + name.length + body.length;
    if (f.descriptor) {
      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, body.length, true);
      dd.setUint32(12, f.data.length, true);
      parts.push(new Uint8Array(dd.buffer));
      size += 16;
    }
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, flags, true);
    cd.setUint16(10, f.method, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
