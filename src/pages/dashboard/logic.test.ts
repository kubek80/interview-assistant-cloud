import { describe, expect, it } from 'vitest';
import { NO_FILTER, dashboardModel, filterItems, groupByDay, isFiltered, recentSessions, sessionAction, sessionCounts, sessionDate, splitPlans, unfinishedSessions } from './logic';
import type { PlannedInterview, Session } from '../../domain/types';
import { makeCategory, makePlan, makeQuestion } from '../../test/fixtures';

describe('dashboard logic', () => {
  it('FLOW-1: primary action per session state', () => {
    expect(sessionAction({ id: 's', state: 'planned', origin: 'local' })).toMatchObject({ to: '/interview/s', label: 'Ready to start' });
    expect(sessionAction({ id: 's', state: 'in_progress', origin: 'local' }).label).toBe('Resume');
    expect(sessionAction({ id: 's', state: 'paused', origin: 'local' }).label).toBe('Resume');
    expect(sessionAction({ id: 's', state: 'submitted', origin: 'local' }).to).toBe('/scorecard/s');
  });

  it('FLOW-1 / FLOW-27: an imported panelist session never links to a scorecard', () => {
    const a = sessionAction({ id: 's', state: 'submitted', origin: 'imported' });
    expect(a.to).toBe('/debrief/s');
    expect(a.secondary).toBeUndefined();
  });

  it('picks the most relevant date', () => {
    expect(sessionDate({ state: 'planned', createdAt: 'c', startedAt: null, submittedAt: null })).toEqual({ label: 'Created', iso: 'c' });
    expect(sessionDate({ state: 'submitted', createdAt: 'c', startedAt: 's', submittedAt: 'x' })).toEqual({ label: 'Submitted', iso: 'x' });
  });

  it('FLOW-9: splits draft and locked plans, newest first, and counts sessions', () => {
    const q = [makeQuestion({ id: 't-1' })];
    const c = [makeCategory({ id: 't-cat' })];
    const a = makePlan(q, c, { id: 'a', locked: false, createdAt: '2026-01-01T00:00:00.000Z' });
    const b = makePlan(q, c, { id: 'b', locked: true, createdAt: '2026-01-02T00:00:00.000Z' });
    const d = makePlan(q, c, { id: 'd', locked: false, createdAt: '2026-01-03T00:00:00.000Z' });
    expect(splitPlans([a, b, d])).toEqual({ drafts: [d, a], locked: [b] });
    expect(sessionCounts([{ planId: 'b' }, { planId: 'b' }, { planId: 'a' }]).get('b')).toBe(2);
  });
});

describe('continue (FLOW-34)', () => {
  it('FLOW-34: the interview to continue is the running one, then paused, then planned; imported and submitted ones never', () => {
    const s = (id: string, state: 'planned' | 'in_progress' | 'paused' | 'submitted', at: string, origin: 'local' | 'imported' = 'local') => ({
      id,
      state,
      origin,
      createdAt: at,
      startedAt: state === 'planned' ? null : at,
    });
    const list = [
      s('planned-new', 'planned', '2026-11-24T10:00:00Z'),
      s('paused', 'paused', '2026-11-23T10:00:00Z'),
      s('done', 'submitted', '2026-11-24T11:00:00Z'),
      s('imported', 'in_progress', '2026-11-24T12:00:00Z', 'imported'),
      s('running', 'in_progress', '2026-11-22T10:00:00Z'),
      s('planned-old', 'planned', '2026-11-20T10:00:00Z'),
    ];
    expect(unfinishedSessions(list).map((x) => x.id)).toEqual(['running', 'paused', 'planned-new', 'planned-old']);
    expect(unfinishedSessions([s('done', 'submitted', '2026-11-24T11:00:00Z')])).toEqual([]);
  });

  it('FLOW-1: recent interviews are ordered by their latest activity', () => {
    const a = { id: 'a', state: 'submitted' as const, createdAt: '2026-11-01', startedAt: '2026-11-01', submittedAt: '2026-11-20' };
    const b = { id: 'b', state: 'planned' as const, createdAt: '2026-11-10', startedAt: null, submittedAt: null };
    expect(recentSessions([b, a]).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('the Dashboard at scale (TEAM-16, TEAM-6)', () => {
  const q = [makeQuestion({ id: 't-1' })];
  const c = [makeCategory({ id: 't-cat' })];
  const plan = makePlan(q, c, { id: 'p', locked: true, fingerprint: 'f'.repeat(64), trackId: 't' });
  const session = (id: string, initials: string, state: Session['state'], origin: Session['origin'] = 'local', extra: Partial<Session> = {}): Session => ({
    id,
    planId: 'p',
    candidate: { initials, requisitionId: id.length % 2 ? 'REQ-7' : 'REQ-8', consentAt: null, retentionUntil: '2027-01-01' },
    interviewer: { name: origin === 'local' ? 'Olive' : `Panelist ${id}` },
    state,
    currentQuestionId: null,
    timer: { accumulatedMs: 0, runningSince: null },
    overall: { rating: null, recommendation: null, rationale: '' },
    createdAt: `2026-11-${String(10 + id.length).padStart(2, '0')}T00:00:00.000Z`,
    startedAt: null,
    submittedAt: state === 'submitted' ? '2026-11-24T00:00:00.000Z' : null,
    origin,
    ...extra,
  });
  const planned = (id: string, sessionId: string, initials: string, date: string | null, expected: string[]): PlannedInterview => ({
    id,
    planId: 'p',
    fingerprint: 'f'.repeat(64),
    candidate: { initials, requisitionId: sessionId.length % 2 ? 'REQ-7' : 'REQ-8' },
    retentionUntil: '2027-01-01',
    date,
    time: null,
    expected,
    recordingNotice: false,
    note: '',
    organiser: 'Olive',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    source: 'here',
    sessionId,
  });

  it('TEAM-16 TEAM-6: one item per interview, others’ records folded in; counts of upcoming, in progress, waiting and finished; search and filters', () => {
    const sessions = [
      session('a', 'Ana Diaz', 'planned', 'local', { invitationId: 'i1' }),
      session('bb', 'Bo Li', 'planned', 'local', { invitationId: 'i2' }),
      session('ccc', 'Chen Wu', 'in_progress'),
      session('dddd', 'Dee Ng', 'submitted', 'local', { invitationId: 'i4' }),
      session('x1', 'Dee Ng', 'submitted', 'imported'),
      session('eeeee', 'Eli Ng', 'submitted'),
      session('z9', 'Zed Other', 'submitted', 'imported'),
      session('z8', 'Zed Other', 'submitted', 'imported'),
    ];
    const plannedList = [
      planned('i1', 'a', 'Ana Diaz', '2026-12-02', ['Ben']),
      planned('i2', 'bb', 'Bo Li', '2026-12-01', ['Ben']),
      planned('i4', 'dddd', 'Dee Ng', null, ['Olive', 'Panelist x1', 'Cy']),
    ];
    const m = dashboardModel(sessions, [plan], plannedList);
    expect(m.upcoming.map((i) => i.candidate)).toEqual(['Bo Li · REQ-8', 'Ana Diaz · REQ-7']);
    expect(groupByDay(m.upcoming).map((g) => g.date)).toEqual(['2026-12-01', '2026-12-02']);
    expect(m.counts).toEqual({ upcoming: 2, 'in-progress': 1, waiting: 1, finished: 1 });
    const dee = m.interviews.find((i) => i.candidate.startsWith('Dee'))!;
    expect(dee.status).toBe('waiting');
    expect(dee.attendance!.toCome).toEqual(['Cy']);
    expect(m.interviews.filter((i) => i.candidate.startsWith('Dee'))).toHaveLength(1);
    // Two imported records with nothing here are one interview "from another computer".
    expect(m.interviews.filter((i) => i.status === 'other-device')).toHaveLength(1);
    expect(filterItems(m.interviews, { ...NO_FILTER, text: ' dee  NG ' }).map((i) => i.session.id)).toEqual(['dddd']);
    expect(filterItems(m.upcoming, { ...NO_FILTER, requisition: 'REQ-7' }).map((i) => i.session.id)).toEqual(['a']);
    expect(filterItems(m.interviews, { ...NO_FILTER, status: 'finished' }).map((i) => i.session.id)).toEqual(['eeeee']);
    expect(filterItems(m.interviews, { ...NO_FILTER, trackId: 'other' })).toEqual([]);
    expect(isFiltered(NO_FILTER)).toBe(false);
  });

  it('FLOW-34 TEAM-1: an interview planned for later waits under Upcoming, not in the Continue card', () => {
    const s = (id: string, invitationId?: string) => ({ id, state: 'planned' as const, origin: 'local' as const, createdAt: '2026-11-24', startedAt: null, invitationId });
    expect(unfinishedSessions([s('later', 'inv'), s('now')]).map((x) => x.id)).toEqual(['now']);
  });
});
