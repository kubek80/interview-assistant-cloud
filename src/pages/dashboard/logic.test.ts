import { describe, expect, it } from 'vitest';
import { dashboardModel, filterInterviews, groupByDay, primaryAction, NO_FILTER } from './logic';
import type { InterviewSummary, RoundSummary } from '../../shared/api';

const ME = 'me';
let n = 0;
function iv(p: Partial<InterviewSummary> & { mine?: boolean; myStatus?: InterviewSummary['panel'][number]['status'] }): InterviewSummary {
  n++;
  const panel = [{ id: 'other', name: 'Olive', status: 'expected' as const }, ...(p.mine ? [{ id: ME, name: 'Me', status: p.myStatus ?? ('expected' as const) }] : [])];
  return {
    id: `i${n}`,
    roundId: 'r1',
    roundName: 'Round',
    roundState: 'open',
    trackId: 'web',
    candidate: { id: `c${n}`, name: `Cand ${n}`, requisitionId: null },
    date: '2026-12-01',
    time: '09:00',
    state: 'planned',
    status: 'upcoming',
    panel,
    onMyPanel: !!p.mine,
    note: '',
    recordingNotice: false,
    questionSet: { id: 's', name: 's', fingerprint: 'f', questions: 14, minutes: 58, isRoundDefault: true },
    createdAt: '2026-11-01T00:00:00Z',
    ...p,
  };
}

const round = (id: string, myRole: RoundSummary['myRole'], state: RoundSummary['state'] = 'open'): RoundSummary => ({
  id,
  name: id,
  trackId: 'web',
  trackName: 'Web',
  requisitionId: null,
  state,
  myRole,
  team: [],
  counts: { upcoming: 0, inProgress: 0, waiting: 0, finished: 0 },
  retentionUntil: '2027-01-01',
  createdAt: '2026-11-01T00:00:00Z',
});

describe('Dashboard model (FLOW-1, FLOW-34, TEAM-2, TEAM-16)', () => {
  it('FLOW-34 ROUND-4 TEAM-2: my unfinished interview to continue; my upcoming ones first, then the rest; counts by state', () => {
    const items = [
      iv({ mine: true, date: '2026-12-02' }),
      iv({ mine: false }),
      iv({ mine: true, state: 'in_progress', status: 'in-progress' }),
      iv({ mine: true, state: 'in_progress', status: 'waiting', myStatus: 'submitted' }),
      iv({ mine: false, state: 'completed', status: 'finished' }),
    ];
    const m = dashboardModel(items, ME);
    expect(m.continuing.map((i) => i.id)).toEqual([items[2].id]);
    expect(m.myUpcoming.map((i) => i.id)).toEqual([items[0].id]);
    expect(m.otherUpcoming.map((i) => i.id)).toEqual([items[1].id]);
    expect(m.others.map((i) => i.id).sort()).toEqual([items[3].id, items[4].id].sort());
    expect(m.counts).toEqual({ upcoming: 2, 'in-progress': 1, waiting: 1, finished: 1 });
  });

  it('TEAM-16: search by candidate (ignoring case and spaces), filter by round and state; grouped by day', () => {
    const items = [iv({ candidate: { id: 'x', name: 'Ana  Diaz', requisitionId: 'req-1' } }), iv({ roundId: 'r2', date: '2026-12-01' }), iv({ date: null, time: null })];
    expect(filterInterviews(items, { ...NO_FILTER, text: 'ana diaz' })).toHaveLength(1);
    expect(filterInterviews(items, { ...NO_FILTER, text: 'REQ-1' })).toHaveLength(1);
    expect(filterInterviews(items, { ...NO_FILTER, roundId: 'r2' })).toHaveLength(1);
    expect(filterInterviews(items, { ...NO_FILTER, status: 'finished' })).toHaveLength(0);
    expect(groupByDay(items).map((g) => [g.date, g.items.length])).toEqual([
      ['2026-12-01', 2],
      [null, 1],
    ]);
  });

  it('UX-9: one primary action: New interview in the one open round I organise, a choice when several, my next interview as an interviewer, else a new round', () => {
    const m = dashboardModel([iv({ mine: true })], ME);
    expect(primaryAction([round('a', 'organiser'), round('b', 'interviewer')], m, true)).toMatchObject({ kind: 'new-in-round', round: { id: 'a' } });
    expect(primaryAction([round('a', 'organiser'), round('b', 'organiser'), round('c', 'organiser', 'closed')], m, true)).toMatchObject({ kind: 'choose-round', rounds: [{ id: 'a' }, { id: 'b' }] });
    expect(primaryAction([round('b', 'interviewer')], m, false)).toMatchObject({ kind: 'next-interview' });
    expect(primaryAction([], dashboardModel([], ME), true)).toEqual({ kind: 'create-round' });
    expect(primaryAction([round('b', 'interviewer')], dashboardModel([], ME), false)).toEqual({ kind: 'none' });
  });
});
