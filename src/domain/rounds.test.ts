import { describe, expect, it } from 'vitest';
import { compareSchedule, interviewStatus, matchPanel, namesList, personName, retentionDate } from './rounds';
import { parseBulkPlan } from './bulkPlan';

describe('rounds (pure)', () => {
  it('ROUND-4 TEAM-16 LIVE-4 FLOW-1: an interview is upcoming, in progress, waiting for judgements or finished; cancelled ones are not listed', () => {
    expect(interviewStatus('planned', [])).toBe('upcoming');
    expect(interviewStatus('in_progress', ['joined', 'expected'])).toBe('in-progress');
    expect(interviewStatus('paused', ['joined'])).toBe('in-progress');
    expect(interviewStatus('in_progress', ['submitted', 'joined'])).toBe('waiting');
    expect(interviewStatus('completed', ['submitted'])).toBe('finished');
    expect(interviewStatus('cancelled', [])).toBeNull();
  });

  it('TEAM-2: soonest first; timed before untimed on a day; undated last, oldest planned first', () => {
    const items = [
      { id: 'undated-new', date: null, time: null, createdAt: '2026-11-02T00:00:00Z' },
      { id: 'late', date: '2026-12-02', time: '09:00', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'untimed', date: '2026-12-01', time: null, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'undated-old', date: null, time: null, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'early', date: '2026-12-01', time: '10:00', createdAt: '2026-11-03T00:00:00Z' },
      { id: 'earliest', date: '2026-12-01', time: '09:30', createdAt: '2026-11-03T00:00:00Z' },
    ];
    expect([...items].sort(compareSchedule).map((i) => i.id)).toEqual(['earliest', 'early', 'untimed', 'late', 'undated-old', 'undated-new']);
  });

  it('TEAM-15 ROUND-4: a pasted panel is matched against the team by email, full name, first name or email name; unknown and ambiguous names are reported', () => {
    const team = [
      { id: 'a', name: 'Ana Diaz', email: 'ana@example.com' },
      { id: 'b', name: 'Ben Ng', email: 'ben.ng@example.com' },
      { id: 'c', name: 'Ben Park', email: 'bpark@example.com' },
    ];
    expect(matchPanel(['ANA@example.com', ' ben  ng ', 'bpark'], team)).toEqual({ kind: 'ok', ids: ['a', 'b', 'c'] });
    expect(matchPanel(['Ana', 'ana diaz'], team)).toEqual({ kind: 'ok', ids: ['a'] });
    expect(matchPanel(['Ben', 'Zoe'], team)).toEqual({ kind: 'problems', ids: [], unknown: ['Zoe'], ambiguous: ['Ben'] });
  });

  it('TEAM-15 PRIV-1: Plan several reads candidate, date, time, panel and note; a header can add a requisition column; problems per line', () => {
    const r = parseBulkPlan('Ana Diaz, 1/12/2026, 2pm, ana@example.com; Ben Ng, Room 4\nBo Li\nBad 99, 2026-12-01\nLate, , 10:00');
    expect(r.lines[0]).toMatchObject({ candidate: 'Ana Diaz', date: '2026-12-01', time: '14:00', interviewers: ['ana@example.com', 'Ben Ng'], note: 'Room 4', problems: [] });
    expect(r.lines[1]).toMatchObject({ candidate: 'Bo Li', date: null, time: null, interviewers: [], note: '', problems: [] });
    expect(r.lines[2].problems[0]).toMatch(/letters, spaces/);
    expect(r.lines[3].problems).toContain('A time needs a date.');
    const h = parseBulkPlan('Name\tRequisition\tDate\tPanel\nAna Diaz\tREQ-7\t2026-12-01\tAna, Ben');
    expect(h.lines[0]).toMatchObject({ candidate: 'Ana Diaz', requisitionId: 'REQ-7', date: '2026-12-01', interviewers: ['Ana', 'Ben'] });
    expect(parseBulkPlan('x, , , , ' + 'n'.repeat(501)).lines[0].problems).toContain('The note is longer than 500 characters.');
  });

  it('ROUND-1 PRIV-5: names in lists, a person’s display name, and the default retention date', () => {
    expect(namesList([])).toBe('');
    expect(namesList(['A'])).toBe('A');
    expect(namesList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(personName({ name: null, email: 'ian@example.com' })).toBe('ian');
    expect(personName({ name: ' Ian ', email: 'x@y' })).toBe('Ian');
    expect(retentionDate(90, new Date('2026-11-26T23:30:00Z'))).toBe('2027-02-24');
  });
});
