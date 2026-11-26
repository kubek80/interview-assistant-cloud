import { describe, expect, it } from 'vitest';
import { auditCsv, csvCell, exportFileName, planFile, scorecardCsv, scorecardMarkdown, sessionFile, toCsv, trackFile } from './export';
import { computeScorecard } from './scoring';
import { parseDelimited } from './csv';
import { makeTrackFile, scored, skipped, workedExamplePlan } from '../test/fixtures';
import type { Session } from './types';

const plan = workedExamplePlan(true);
const answers = [
  scored('t-1', 4, { notes: [{ atSec: 75, text: 'Said "it depends", then, gave numbers' }], flagged: true }),
  scored('t-2', 1, { notes: [{ atSec: 200, text: '=HYPERLINK("http://x")' }] }),
  scored('t-3', 4),
  scored('t-4', 4),
];
const session: Session = {
  id: 'abcdef1234',
  planId: plan.id,
  candidate: { initials: 'AB', requisitionId: 'R-1', consentAt: '2026-11-01T10:00:00.000Z', retentionUntil: '2027-01-30' },
  interviewer: { name: 'Pat' },
  state: 'submitted',
  currentQuestionId: null,
  timer: { accumulatedMs: 0, runningSince: null },
  overall: { rating: 2, recommendation: 'lean_no_hire', rationale: 'Weak on networking | must-have' },
  createdAt: '2026-11-01T10:00:00.000Z',
  startedAt: '2026-11-01T10:00:00.000Z',
  submittedAt: '2026-11-01T11:00:00.000Z',
  origin: 'local',
};
const sc = computeScorecard(plan, answers);

describe('CSV', () => {
  it('FLOW-31: cells are escaped per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(-1)).toBe('-1');
    expect(toCsv([['a', 'b'], [1, true]])).toBe('a,b\r\n1,yes\r\n');
  });

  it('SEC-2: CSV cells that look like formulas are neutralised', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('FLOW-31: scorecard CSV has a header and one row per question', () => {
    const csv = scorecardCsv(sc);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toMatch(/^Order,Question id,/);
    expect(csv).toContain('"[3:20] =HYPERLINK(""http://x"")"'); // note cells start with the timestamp
    expect(csv.match(/^\d+,t-\d,/gm)).toHaveLength(4);
  });

  it('FLOW-31 BANK-15: sentence-length red flags (with ";" and ":" inside) go one per line in their CSV cell, whole and unchanged', () => {
    const base = workedExamplePlan();
    const flags = ['Uses buzzwords only: defines the terms; cannot name one practice.', 'Blames others, e.g. "the other team", for the outage.'];
    const p = { ...base, questions: base.questions.map((q, i) => (i === 0 ? { ...q, redFlags: flags } : q)) };
    const card = computeScorecard(p, [scored('t-1', 1, { redFlagsSeen: [0, 1] }), scored('t-2', 3), scored('t-3', 2), skipped('t-4')]);
    const rows = parseDelimited(scorecardCsv(card));
    const col = rows[0].indexOf('Red flags seen');
    expect(rows[1][col].split('\n')).toEqual(flags);
  });

  it('AUD-3: audit CSV includes before/after and reason', () => {
    const csv = auditCsv([
      { id: 1, ts: '2026-11-01T10:00:00.000Z', actor: 'Pat', action: 'session.amended', entity: 'answer', entityId: 's1', before: { score: 2 }, after: { score: 3 }, reason: 'Typo' },
    ]);
    expect(csv).toContain('session.amended');
    expect(csv).toContain('"{""score"":2}"');
    expect(csv).toContain('Typo');
  });
});

describe('Markdown', () => {
  it('FLOW-31, FLOW-25, SCORE-8: scorecard Markdown shows the percentage, advisory band with cap, and the recorded decision', () => {
    const md = scorecardMarkdown(plan, session, sc);
    expect(md).toContain('**71%**');
    expect(md).toContain('Advisory band: Lean no hire (capped by must-have: Networking)');
    expect(md).toContain("Interviewer's recommendation: Lean no hire");
    expect(md).toContain('Weak on networking \\| must-have');
    expect(md).toContain('| 1 (flagged) |');
    expect(md).toContain('[1:15]');
    expect(md).toContain('advisory');
  });

  it('SCORE-6: Markdown says Insufficient evidence in place of a band', () => {
    const low = computeScorecard(plan, [scored('t-1', 4), skipped('t-2'), skipped('t-3'), skipped('t-4')]);
    expect(scorecardMarkdown(plan, session, low)).toContain('Advisory band: Insufficient evidence');
  });
});

describe('file envelopes', () => {
  it('DATA-4: plan and session files carry kind and formatVersion; a session file embeds its plan', () => {
    const pf = planFile(plan);
    expect(pf).toMatchObject({ kind: 'interview-plan', formatVersion: 1, plan });
    const sf = sessionFile(plan, session, answers);
    expect(sf).toMatchObject({ kind: 'interview-session', formatVersion: 1, plan, session });
    expect(sf.answers).toHaveLength(4);
  });

  it('BANK-7: the bank exports in seed-file shape without trackId on rows', () => {
    const tf = makeTrackFile();
    const exported = trackFile(
      tf.track,
      tf.categories.map((c) => ({ ...c, trackId: 'tt' })),
      [...tf.questions].reverse().map((q) => ({ ...q, trackId: 'tt' })),
    );
    expect(exported).toEqual(tf);
  });

  it('PRIV-3: export file names carry no candidate data', () => {
    expect(exportFileName('session', session.id, 'json', new Date('2026-11-24T00:00:00Z'))).toBe('interview-session-abcdef12-2026-11-24.json');
  });
});
