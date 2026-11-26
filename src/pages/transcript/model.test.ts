// TR-1, TR-2, AI-1…AI-5: pure view logic of the "Transcript & recording" panel and the AI run.
import { describe, expect, it } from 'vitest';
import { parseTranscriptText } from '../../domain/transcript';
import { aiReadiness, checkMapping, formatBytes, highlightParts, mediaKind, pageOfLine, paginate, searchLines, speakerLabelOptions, transcriptLines } from './model';

const t = parseTranscriptText(['[00:00:03] Priya: How do you test?', '[00:00:10] Sam: I start from risk.', 'Sam: And flaky tests get quarantined.'].join('\n'));

describe('transcript viewer', () => {
  it('TR-1: numbers lines one per segment, with time and speaker where the transcript has them', () => {
    expect(transcriptLines(t)).toEqual([
      { line: 1, startSec: 3, time: '00:00:03', speaker: 'Priya', text: 'How do you test?' },
      { line: 2, startSec: 10, time: '00:00:10', speaker: 'Sam', text: 'I start from risk.' },
      { line: 3, speaker: 'Sam', text: 'And flaky tests get quarantined.' },
    ]);
  });

  it('TR-1: search matches text and speaker, ignoring case; matches are split out for highlighting', () => {
    const lines = transcriptLines(t);
    expect(searchLines(lines, 'FLAKY').map((l) => l.line)).toEqual([3]);
    expect(searchLines(lines, 'sam').map((l) => l.line)).toEqual([2, 3]);
    expect(searchLines(lines, '  ')).toHaveLength(3);
    expect(highlightParts('Risk first, then risk', 'risk')).toEqual([
      { text: 'Risk', match: true },
      { text: ' first, then ', match: false },
      { text: 'risk', match: true },
    ]);
    expect(highlightParts('no match', 'x')).toEqual([{ text: 'no match', match: false }]);
  });

  it('TR-1: long transcripts are paged; a line number maps to its page', () => {
    const items = Array.from({ length: 450 }, (_, i) => i + 1);
    expect(paginate(items, 0)).toMatchObject({ page: 0, pageCount: 3, from: 1, to: 200, total: 450 });
    expect(paginate(items, 2)).toMatchObject({ page: 2, from: 401, to: 450 });
    expect(paginate(items, 9).page).toBe(2);
    expect(paginate([], 0)).toMatchObject({ page: 0, pageCount: 1, from: 0, to: 0 });
    expect([1, 200, 201, 450].map((n) => pageOfLine(n))).toEqual([0, 0, 1, 2]);
  });

  it('TR-2: sizes and media kinds read naturally', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(80_044)).toBe('78.2 KB');
    expect(formatBytes(201 * 1024 * 1024)).toBe('201.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(mediaKind('video/mp4')).toBe('video');
    expect(mediaKind('audio/x-m4a')).toBe('audio');
  });
});

describe('AI run', () => {
  it('AI-5: each speaker gets Candidate, Interviewer n or Other speaker n; one must be the candidate; extra names need a name and a label', () => {
    expect(speakerLabelOptions(2)).toEqual(['Candidate', 'Interviewer 1', 'Interviewer 2', 'Other speaker 1', 'Other speaker 2']);
    expect(checkMapping(t, { Priya: 'Interviewer 1', Sam: 'Candidate' }, []).ok).toBe(true);
    const noCandidate = checkMapping(t, { Priya: 'Interviewer 1', Sam: 'Interviewer 2' }, []);
    expect(noCandidate.ok).toBe(false);
    expect(noCandidate.problems.map((p) => p.code)).toEqual(['no-candidate']);
    const extra = checkMapping(t, { Priya: 'Interviewer 1', Sam: 'Candidate' }, [
      { name: '', label: 'Candidate' },
      { name: 'Z', label: 'Candidate' },
      { name: 'Morgan', label: 'Jane' },
      { name: 'Morgan', label: 'Other speaker 1' },
    ]);
    expect(extra.extraProblems).toEqual([expect.stringMatching(/Enter the name/), expect.stringMatching(/one letter/), expect.stringMatching(/Choose/), null]);
    expect(extra.ok).toBe(false);
  });

  it('AI-1 AI-2 AI-3: says why a run cannot start: off, helper unavailable, no transcript, busy, imported', () => {
    const on = { enabled: true, acknowledgedAt: '2026-11-24T00:00:00Z' };
    const ready = { state: 'ready' as const, cliVersion: '2.1.0', model: null, busy: false };
    const base = { settings: on, status: ready, hasTranscript: true, origin: 'local' as const, started: true };
    expect(aiReadiness(base)).toEqual({ canRun: true });
    expect(aiReadiness({ ...base, settings: { enabled: false, acknowledgedAt: null } })).toMatchObject({ canRun: false, reason: 'off', message: expect.stringMatching(/Admin/) });
    expect(aiReadiness({ ...base, status: { state: 'unavailable', reason: 'helper_unavailable', message: 'Start the app with npm start', cliVersion: null } })).toMatchObject({
      reason: 'unavailable',
      message: 'Start the app with npm start',
    });
    expect(aiReadiness({ ...base, status: null })).toMatchObject({ reason: 'loading' });
    expect(aiReadiness({ ...base, hasTranscript: false })).toMatchObject({ reason: 'no-transcript' });
    expect(aiReadiness({ ...base, status: { ...ready, busy: true } })).toMatchObject({ reason: 'busy' });
    expect(aiReadiness({ ...base, origin: 'imported' })).toMatchObject({ reason: 'imported' });
    expect(aiReadiness({ ...base, started: false })).toMatchObject({ reason: 'not-started' });
  });
});
