import { describe, expect, it } from 'vitest';
import { attendance, compareUpcoming, dayLabel, hideImported, matchRecord, panelKey, scheduleProblems, uniqueNames, whenLabel } from './team';
import { parseBulkPlan, parseDay, parseTime, splitNames } from './bulkPlan';
import { candidateKey } from './plan';
import { validateInvitationFile } from './validation';

const rec = (state: 'planned' | 'in_progress' | 'submitted', names: string[], origin: 'local' | 'imported' = 'imported') => ({
  state,
  origin,
  interviewer: { name: names[0] },
  interviewers: names,
});

describe('planning (TEAM-1, TEAM-2)', () => {
  it('TEAM-2: Upcoming is soonest first, timed before untimed on a day, undated last', () => {
    const items = [
      { id: 'undated-new', date: null, time: null, createdAt: '2026-11-24T10:00:00Z' },
      { id: 'dec2-untimed', date: '2026-12-02', time: null, createdAt: '2026-11-20T00:00:00Z' },
      { id: 'dec2-0900', date: '2026-12-02', time: '09:00', createdAt: '2026-11-24T00:00:00Z' },
      { id: 'dec1-1400', date: '2026-12-01', time: '14:00', createdAt: '2026-11-24T00:00:00Z' },
      { id: 'undated-old', date: null, time: null, createdAt: '2026-11-01T10:00:00Z' },
      { id: 'dec1-0930', date: '2026-12-01', time: '09:30', createdAt: '2026-11-24T00:00:00Z' },
    ];
    expect([...items].sort(compareUpcoming).map((i) => i.id)).toEqual(['dec1-0930', 'dec1-1400', 'dec2-0900', 'dec2-untimed', 'undated-old', 'undated-new']);
  });

  it('TEAM-1: the date, time, interviewers and note are optional and checked', () => {
    expect(scheduleProblems({ date: '', time: '', expected: [], note: '' })).toEqual({});
    expect(scheduleProblems({ date: '2026-12-01', time: '09:30', expected: ['Ana', ' ana '], note: 'ok' })).toEqual({});
    expect(Object.keys(scheduleProblems({ date: '2026-02-30', time: '25:00', expected: ['x'.repeat(201)], note: 'x'.repeat(501) })).sort()).toEqual(['date', 'expected', 'note', 'time']);
    expect(scheduleProblems({ date: '', time: '10:00', expected: [], note: '' }).time).toBe('Choose the day as well.');
  });

  it('TEAM-2 TEAM-16: day labels say today and tomorrow in words', () => {
    expect(dayLabel('2026-11-24', '2026-11-24')).toBe('Today');
    expect(dayLabel('2026-11-25', '2026-11-24')).toBe('Tomorrow');
    expect(dayLabel(null, '2026-11-24')).toBe('No date yet');
    expect(dayLabel('2026-12-01', '2026-11-24', 'en-GB')).toBe('Tue 1 Dec');
    expect(dayLabel('2027-01-05', '2026-11-24', 'en-GB')).toContain('2027');
    expect(whenLabel({ date: '2026-11-24', time: '10:30' }, '2026-11-24')).toBe('Today at 10:30');
  });
});

describe('collecting results (TEAM-5, TEAM-6, FLOW-27)', () => {
  it('TEAM-6: expected, submitted and still to come; names compared trimmed and case-insensitively; an unexpected submitter is just submitted', () => {
    const a = attendance(['Ana Lead', 'ben second', 'Cy'], [rec('submitted', ['Ben  Second']), rec('in_progress', ['Cy'], 'local'), rec('submitted', ['Dee', 'Ana lead'], 'local')]);
    expect(a.expected).toEqual(['Ana Lead', 'ben second', 'Cy']);
    // Expected people first, in the order named; others after.
    expect(a.submitted).toEqual([
      { name: 'Ana lead', you: true },
      { name: 'Ben Second', you: false },
      { name: 'Dee', you: true },
    ]);
    expect(a.toCome).toEqual(['Cy']);
    expect(uniqueNames([' a ', 'A', '', 'b'])).toEqual(['a', 'b']);
  });

  it('FLOW-27: others’ records are shown unless independent scoring is on and this device’s own record is not submitted', () => {
    expect(hideImported(false, [])).toBe(false);
    expect(hideImported(false, [{ state: 'planned' }])).toBe(false);
    expect(hideImported(true, [])).toBe(true);
    expect(hideImported(true, [{ state: 'in_progress' }])).toBe(true);
    expect(hideImported(true, [{ state: 'planned' }, { state: 'submitted' }])).toBe(false);
  });

  it('TEAM-5: a file is matched by invitation id, else by candidate key and fingerprint, else not at all', () => {
    const fp = 'f'.repeat(64);
    const planned = [{ id: 'inv-1', candidate: { initials: 'Ana Diaz', requisitionId: 'REQ-1' }, fingerprint: fp }];
    const key = candidateKey({ initials: 'ana diaz', requisitionId: 'req-1' });
    expect(matchRecord({ invitationId: 'inv-1', candidateKey: key, fingerprint: fp }, planned, new Set())).toEqual({ kind: 'invitation', invitationId: 'inv-1' });
    expect(matchRecord({ candidateKey: key, fingerprint: fp }, planned, new Set())).toEqual({ kind: 'invitation', invitationId: 'inv-1' });
    expect(matchRecord({ invitationId: 'inv-1', candidateKey: 'X|', fingerprint: fp }, planned, new Set())).toEqual({ kind: 'none', reason: 'invitation-differs' });
    const other = { candidateKey: 'BO|', fingerprint: fp };
    expect(matchRecord(other, planned, new Set([panelKey({ initials: 'Bo', requisitionId: null }, fp)]))).toEqual({ kind: 'panel' });
    expect(matchRecord(other, planned, new Set())).toEqual({ kind: 'none', reason: 'no-interview' });
  });

  it('TEAM-3 SEC-2: an invitation file must be the right kind and version', () => {
    expect(validateInvitationFile(null).ok).toBe(false);
    expect(validateInvitationFile({ kind: 'interview-invitation', formatVersion: 2, interviews: [] }).ok).toBe(false);
    const r = validateInvitationFile({ kind: 'interview-invitation', formatVersion: 1, exportedAt: '2026-11-24T00:00:00.000Z', interviews: [] });
    expect(r.ok).toBe(false);
  });
});

describe('plan several (TEAM-15)', () => {
  it('TEAM-15: tab-separated lines pasted from a spreadsheet, with a header in any column order', () => {
    const { lines } = parseBulkPlan('Name\tReq\tDate\tTime\tInterviewers\nAna Diaz\tREQ-1\t2026-12-01\t9:30\tBen, Cy\n Bo  Li \t\t1/12/2026\t2pm\t\n');
    expect(lines).toEqual([
      { line: 1, candidate: 'Ana Diaz', requisitionId: 'REQ-1', date: '2026-12-01', time: '09:30', interviewers: ['Ben', 'Cy'], note: '', problems: [] },
      { line: 2, candidate: 'Bo Li', requisitionId: null, date: '2026-12-01', time: '14:00', interviewers: [], note: '', problems: [] },
    ]);
  });

  it('TEAM-15: comma-separated lines without a header use the order candidate, date, time, interviewers, note; problems are per line', () => {
    const { lines, tooMany } = parseBulkPlan('Ana Diaz,2026-12-01,10:00,Ben; Cy,Room 4\nann@example.com,31/2/2026,25:00,,\nChen Wu,,10:00,,\nDee');
    expect(tooMany).toBe(false);
    expect(lines[0]).toMatchObject({ candidate: 'Ana Diaz', date: '2026-12-01', time: '10:00', requisitionId: null, interviewers: ['Ben', 'Cy'], note: 'Room 4', problems: [] });
    expect(lines[1].problems).toHaveLength(3);
    expect(lines[2].problems).toEqual(['A time needs a date.']);
    expect(lines[3]).toMatchObject({ candidate: 'Dee', date: null, problems: [] });
    expect(parseBulkPlan(Array.from({ length: 201 }, (_, i) => `C${'a'.repeat(i % 5)}`).join('\n')).tooMany).toBe(true);
  });

  it('TEAM-15: dates, times and names in the forms spreadsheets use', () => {
    expect(parseDay('2026-12-01')).toBe('2026-12-01');
    expect(parseDay('01.12.2026')).toBe('2026-12-01');
    expect(parseDay('31/11/2026')).toBeNull();
    expect(parseDay('Dec 1')).toBeNull();
    expect(parseTime('9:05')).toBe('09:05');
    expect(parseTime('14.30')).toBe('14:30');
    expect(parseTime('12am')).toBe('00:00');
    expect(parseTime('2:30 PM')).toBe('14:30');
    expect(parseTime('9')).toBeNull();
    expect(splitNames('Ana and Ben / Cy & Dee', true)).toEqual(['Ana', 'Ben', 'Cy', 'Dee']);
    expect(splitNames('Ana, Ben', true)).toEqual(['Ana, Ben']);
  });
});
