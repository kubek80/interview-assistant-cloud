// ROUND-1…ROUND-5, FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15, PANEL-1, PRIV-1, AUD-2, HPRIV-4: hiring
// rounds, their teams and question sets, and planning interviews, against a real PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, seedBank, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { topicAllowed } from '../live/routes';
import { DEFAULT_QUOTAS, DEFAULT_TIME_BUDGET_MIN, totalTimeMin } from '../../src/domain/plan';
import type { InterviewSummary, QuestionSetDetail, RoundDetail, RoundSummary } from '../../src/shared/api';

let t: TestDb;
let a: TestApp;
type C = ReturnType<typeof client>;
const as: Record<string, C> = {};
const ids: Record<string, string> = {};

/** USER-2 / ROUND-2 people: global roles, and their places in round A (created by `olive`). */
const PEOPLE = {
  admin: 'admin',
  olive: 'organiser', // organises round A (its creator)
  oscar: 'organiser', // organiser in the organisation, not on round A
  ian: 'interviewer', // interviewer on round A
  ivy: 'interviewer', // interviewer, on no round
  rita: 'reviewer',
} as const;

beforeAll(async () => {
  t = await createTestDb();
  await seedBank(t.db);
  a = await startApp(t);
  for (const [name, role] of Object.entries(PEOPLE)) {
    ids[name] = await addUser(t.db, `${name}@example.test`, role, { name: name[0].toUpperCase() + name.slice(1) });
    as[name] = client(a.app, await signIn(a.app, `${name}@example.test`));
  }
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

async function newRound(by: C, body: Record<string, unknown> = {}): Promise<string> {
  const r = await by.post('/api/rounds', { name: 'Web engineers Q1', trackId: 'web', requisitionId: 'REQ-1', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const setOf = async (by: C, roundId: string): Promise<QuestionSetDetail> => (await by.get(`/api/rounds/${roundId}/question-set`)).body;
const setInput = (s: QuestionSetDetail, questionIds = s.questions.map((q) => q.id)) => ({
  questionIds,
  categories: s.categories.map((c) => ({ id: c.id, weight: c.weight, mustHave: c.mustHave })),
  timeBudgetMin: s.timeBudgetMin,
});
const audit = async (action: string) => t.db.selectFrom('audit_events').selectAll().where('action', '=', action).orderBy('id', 'desc').execute();

describe('rounds (ROUND-1, ROUND-2, ROUND-5)', () => {
  it('ROUND-1 ROUND-3 UX-2 FLOW-3 FLOW-4 FLOW-33: an organiser creates a round with a name, role and requisition; a balanced question set is already drawn; the creator organises it', async () => {
    const id = await newRound(as.olive);
    ids.roundA = id;
    const r: RoundDetail = (await as.olive.get(`/api/rounds/${id}`)).body;
    expect(r).toMatchObject({ name: 'Web engineers Q1', trackId: 'web', requisitionId: 'REQ-1', state: 'open', myRole: 'organiser', canManage: true, canPlan: true, hideOthersScores: false });
    expect(r.team).toEqual([expect.objectContaining({ id: ids.olive, role: 'organiser' })]);
    // PRIV-5: the retention date defaults from the organisation setting (90 days).
    const expected = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
    expect(r.retentionUntil).toBe(expected);
    const set = await setOf(as.olive, id);
    expect(set.fixed).toBe(false);
    expect(set.isRoundDefault).toBe(true);
    expect(set.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    for (const [type, n] of Object.entries(DEFAULT_QUOTAS)) expect(set.questions.filter((q) => q.type === type)).toHaveLength(n);
    expect(totalTimeMin(set.questions)).toBeLessThanOrEqual(DEFAULT_TIME_BUDGET_MIN);
    expect(set.timeBudgetMin).toBe(DEFAULT_TIME_BUDGET_MIN);
    // Spread across categories (FLOW-3): the 9 knowledge questions come from several categories.
    expect(new Set(set.questions.filter((q) => q.type === 'knowledge').map((q) => q.categoryId)).size).toBeGreaterThan(3);
    const [entry] = await audit('round.created');
    expect(entry).toMatchObject({ actor_id: ids.olive, entity_id: id, round_id: id });
  });

  it('ROUND-1 USER-2: only organisers and administrators create rounds; a name and a real role are needed', async () => {
    expect((await as.ian.post('/api/rounds', { name: 'x', trackId: 'web' })).status).toBe(403);
    expect((await as.rita.post('/api/rounds', { name: 'x', trackId: 'web' })).status).toBe(403);
    expect((await as.olive.post('/api/rounds', { name: '  ', trackId: 'web' })).status).toBe(400);
    expect((await as.olive.post('/api/rounds', { name: 'x', trackId: 'nope' })).status).toBe(400);
    expect((await as.olive.post('/api/rounds', { name: 'x', trackId: 'web', extra: 1 })).status).toBe(400);
    const adminRound = await newRound(as.admin, { name: 'Admin round', trackId: 'qa', requisitionId: null });
    expect((await as.admin.get(`/api/rounds/${adminRound}`)).body.myRole).toBe('organiser');
    ids.roundB = adminRound;
  });

  it('ROUND-2: a team is chosen from people with access; organisers must be organisers or administrators; question reviewers are refused', async () => {
    const r = ids.roundA;
    const options = (await as.olive.get(`/api/rounds/${r}/team-options`)).body as Array<{ id: string; canOrganise: boolean }>;
    expect(options.map((o) => o.id)).not.toContain(ids.rita);
    expect(options.find((o) => o.id === ids.ian)!.canOrganise).toBe(false);
    expect((await as.olive.put(`/api/rounds/${r}/members/${ids.ian}`, { role: 'interviewer' })).status).toBe(200);
    const refused = await as.olive.put(`/api/rounds/${r}/members/${ids.rita}`, { role: 'interviewer' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Question reviewers cannot be on a round/);
    expect((await as.olive.put(`/api/rounds/${r}/members/${ids.ian}`, { role: 'organiser' })).body.error.message).toMatch(/Only organisers and administrators can organise/);
    const gone = await addUser(t.db, 'gone@example.test', 'interviewer', { active: false });
    expect((await as.olive.put(`/api/rounds/${r}/members/${gone}`, { role: 'interviewer' })).status).toBe(400);
    // The last organiser cannot leave or be made an interviewer.
    expect((await as.olive.del(`/api/rounds/${r}/members/${ids.olive}`)).status).toBe(409);
    expect((await as.olive.put(`/api/rounds/${r}/members/${ids.olive}`, { role: 'interviewer' })).status).toBe(409);
    // Interviewers on the round cannot change the team.
    expect((await as.ian.put(`/api/rounds/${r}/members/${ids.ivy}`, { role: 'interviewer' })).status).toBe(403);
    const added = await audit('round.member_added');
    expect(added[0]).toMatchObject({ actor_id: ids.olive, round_id: r });
    expect(added[0].after).toEqual({ user: 'ian@example.test', role: 'interviewer' });
  });

  it('ROUND-2 USER-1: people see only the rounds they are on; administrators see all; the Users page lists each person’s rounds', async () => {
    const list = async (c: C) => ((await c.get('/api/rounds')).body as RoundSummary[]).map((r) => r.id);
    expect(await list(as.olive)).toEqual([ids.roundA]);
    expect(await list(as.ian)).toEqual([ids.roundA]);
    expect(await list(as.ivy)).toEqual([]);
    expect(await list(as.oscar)).toEqual([]);
    expect((await list(as.admin)).sort()).toEqual([ids.roundA, ids.roundB].sort());
    expect((await as.rita.get('/api/rounds')).status).toBe(403);
    const summary = ((await as.ian.get('/api/rounds')).body as RoundSummary[])[0];
    expect(summary).toMatchObject({ myRole: 'interviewer', trackName: 'Senior Software Engineer (Web Applications)', counts: { upcoming: 0, inProgress: 0, waiting: 0, finished: 0 } });
    expect(summary.team.map((m) => m.name)).toEqual(['Olive', 'Ian']);
    const users = (await as.admin.get('/api/users')).body.items as Array<{ email: string; rounds: Array<{ id: string; role: string }> }>;
    expect(users.find((u) => u.email === 'ian@example.test')!.rounds).toEqual([{ id: ids.roundA, name: 'Web engineers Q1', role: 'interviewer' }]);
  });

  it('ROUND-2 AUTH-5 HPRIV-1: every round route answers each role as the policy says: members read, the round’s organisers and administrators change, everyone else gets "not found"', async () => {
    // A throwaway round with one planned interview, so every id in the URLs exists.
    const r = await newRound(as.olive, { name: 'Matrix round' });
    await as.olive.put(`/api/rounds/${r}/members/${ids.ian}`, { role: 'interviewer' });
    const interview = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Matrix Person' }, panel: [ids.olive] })).body.id as string;
    const set = await setOf(as.olive, r);
    const fill = (url: string) => url.replace(':roundId', r).replace(':userId', ids.ian).replace(':id', url.startsWith('/api/question-sets') ? set.id : interview);
    // Changes that end the test's fixtures (close, reopen, cancel, remove) have their own tests below.
    const skip = ['POST /api/rounds/:roundId/close', 'POST /api/rounds/:roundId/reopen', 'POST /api/interviews/:id/cancel', 'DELETE /api/rounds/:roundId/members/:userId'];
    // The live interview's routes (server/interviews) have their own matrix in server/interviews/live.test.ts.
    const interviewing = (url: string) => url.startsWith('/api/records') || /^\/api\/interviews\/:id\/(live|records|present|start|join|command|presence|panel)/.test(url);
    const roundRoutes = a.routes.filter((x) => x.access.startsWith('round:') && !skip.includes(`${x.method} ${x.url}`) && !interviewing(x.url));
    expect(roundRoutes.length).toBeGreaterThanOrEqual(13);
    const who = { 'round organiser': as.olive, 'round interviewer': as.ian, administrator: as.admin, 'organiser not on it': as.oscar, 'interviewer not on it': as.ivy, reviewer: as.rita };
    const wrong: string[] = [];
    for (const route of roundRoutes) {
      const action = route.access.slice('round:'.length);
      for (const [label, c] of Object.entries(who)) {
        const res = route.method === 'GET' ? await c.get(fill(route.url)) : route.method === 'PUT' ? await c.put(fill(route.url), {}) : route.method === 'PATCH' ? await c.patch(fill(route.url), {}) : await c.post(fill(route.url), {});
        // Refused by the access check: 403, or 404 "That was not found." for people not on the round.
        const refusedAs = res.status === 403 ? 'forbidden' : res.status === 404 && res.body?.error?.message === 'That was not found.' ? 'not found' : 'allowed';
        const expected =
          label === 'reviewer'
            ? 'not found'
            : label.endsWith('not on it')
              ? 'not found'
              : label === 'round interviewer' && action !== 'round.read'
                ? 'forbidden'
                : 'allowed';
        if (refusedAs !== expected) wrong.push(`${label} ${route.method} ${route.url} (${action}): ${refusedAs} (${res.status}), expected ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('ROUND-2 AUTH-5 HPRIV-1: ids from another round are refused (no IDOR): interviews, question sets, panels and question-set edits', async () => {
    const b = ids.roundB;
    await as.admin.put(`/api/rounds/${b}/members/${ids.ivy}`, { role: 'interviewer' });
    const otherInterview = (await as.admin.post(`/api/rounds/${b}/interviews`, { candidate: { name: 'Other Round' }, panel: [ids.ivy] })).body.id as string;
    const otherSet = await setOf(as.admin, b);
    // Olive (round A only) cannot see round B's interview or set by id, nor change them.
    expect((await as.olive.get(`/api/interviews/${otherInterview}`)).status).toBe(404);
    expect((await as.olive.patch(`/api/interviews/${otherInterview}`, { note: 'x' })).status).toBe(404);
    expect((await as.olive.post(`/api/interviews/${otherInterview}/cancel`, {})).status).toBe(404);
    expect((await as.olive.get(`/api/question-sets/${otherSet.id}`)).status).toBe(404);
    expect((await as.olive.get(`/api/rounds/${b}/interviews`)).status).toBe(404);
    // Round A's routes refuse round B's ids in the body.
    const setA = await setOf(as.olive, ids.roundA);
    const foreignBase = await as.olive.put(`/api/rounds/${ids.roundA}/question-set`, { ...setInput(setA), baseSetId: otherSet.id, baseVersion: otherSet.version });
    expect(foreignBase.status).toBe(409);
    const foreignQuestions = await as.olive.put(`/api/rounds/${ids.roundA}/question-set`, { ...setInput(setA, otherSet.questions.map((q) => q.id)), baseSetId: setA.id, baseVersion: setA.version });
    expect(foreignQuestions.status).toBe(400); // qa questions in a web round
    const foreignPanel = await as.olive.post(`/api/rounds/${ids.roundA}/interviews`, { candidate: { name: 'Zed' }, panel: [ids.ivy] });
    expect(foreignPanel.status).toBe(400);
    expect(foreignPanel.body.error.message).toMatch(/must be on the round’s team/);
    // A malformed id is "not found" too.
    expect((await as.olive.get('/api/interviews/not-a-uuid')).status).toBe(404);
  });
});

describe('question sets (ROUND-3, FLOW-2…FLOW-9)', () => {
  it('FLOW-2 FLOW-4 FLOW-6 UX-3 ROUND-3: an unfixed set is edited in place (order, removal, a question from the bank, weights, must-have, budget); two editors cannot overwrite each other', async () => {
    const r = ids.roundA;
    const before = await setOf(as.olive, r);
    const bank = (await as.olive.get('/api/bank/tracks/web')).body as { questions: Array<{ id: string; status: string }> };
    const extra = bank.questions.find((q) => q.status === 'active' && !before.questions.some((x) => x.id === q.id))!.id;
    const order = [...before.questions.map((q) => q.id).slice(1).reverse(), extra];
    const cats = before.categories.map((c, i) => ({ id: c.id, weight: i === 0 ? 2 : c.weight, mustHave: i === 0 }));
    const res = await as.olive.put(`/api/rounds/${r}/question-set`, { questionIds: order, categories: cats, timeBudgetMin: 75, name: 'Web set', baseSetId: before.id, baseVersion: before.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replaced).toBe(false);
    const after: QuestionSetDetail = res.body.set;
    expect(after.id).toBe(before.id);
    expect(after.questions.map((q) => q.id)).toEqual(order);
    expect(after.categories[0]).toMatchObject({ weight: 2, mustHave: true });
    expect(after.timeBudgetMin).toBe(75);
    expect(after.name).toBe('Web set');
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.version).toBe(before.version + 1);
    // A second editor still holding the old version is told, not overwritten.
    const stale = await as.admin.put(`/api/rounds/${r}/question-set`, { ...setInput(before), baseSetId: before.id, baseVersion: before.version });
    expect(stale.status).toBe(409);
    expect((await audit('question_set.changed'))[0]).toMatchObject({ entity_id: before.id, round_id: r });
    // Interviewers read the set but cannot change it.
    expect((await as.ian.get(`/api/rounds/${r}/question-set`)).status).toBe(200);
    expect((await as.ian.put(`/api/rounds/${r}/question-set`, { ...setInput(after), baseSetId: after.id, baseVersion: after.version })).status).toBe(403);
    // Validation: no questions, unknown questions, weights out of range.
    expect((await as.olive.put(`/api/rounds/${r}/question-set`, { ...setInput(after, []), baseSetId: after.id, baseVersion: after.version })).status).toBe(400);
    expect((await as.olive.put(`/api/rounds/${r}/question-set`, { ...setInput(after, ['web-99999']), baseSetId: after.id, baseVersion: after.version })).status).toBe(400);
    expect((await as.olive.put(`/api/rounds/${r}/question-set`, { ...setInput(after), categories: [{ id: after.categories[0].id, weight: 50, mustHave: false }], baseSetId: after.id, baseVersion: after.version })).status).toBe(400);
  });

  it('FLOW-8 FLOW-9 ROUND-3 AUD-2: the set is fixed when the first interview using it is planned; changing the round’s questions then makes a new set for future interviews, and planned interviews keep theirs', async () => {
    const r = ids.roundA;
    const set = await setOf(as.olive, r);
    expect(set.fixed).toBe(false);
    const first = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Ana Diaz' }, panel: [ids.olive, ids.ian], date: '2026-12-01', time: '09:30' })).body.id as string;
    const fixed = await setOf(as.olive, r);
    expect(fixed).toMatchObject({ id: set.id, fixed: true, interviews: 1 });
    expect(fixed.fingerprint).toBe(set.fingerprint);
    expect((await audit('question_set.fixed'))[0]).toMatchObject({ entity_id: set.id, round_id: r });
    // Changing the questions now: a new set for future interviews.
    const res = await as.olive.put(`/api/rounds/${r}/question-set`, { ...setInput(fixed, fixed.questions.map((q) => q.id).slice(0, -1)), baseSetId: fixed.id, baseVersion: fixed.version });
    expect(res.status).toBe(200);
    expect(res.body.replaced).toBe(true);
    const next: QuestionSetDetail = res.body.set;
    expect(next.id).not.toBe(fixed.id);
    expect(next).toMatchObject({ fixed: false, isRoundDefault: true, interviews: 0 });
    expect(next.fingerprint).not.toBe(fixed.fingerprint);
    // The planned interview keeps the fixed set; the old set is unchanged.
    const planned = (await as.olive.get(`/api/interviews/${first}`)).body;
    expect(planned.set.id).toBe(fixed.id);
    expect(planned.set.questions.map((q: { id: string }) => q.id)).toEqual(fixed.questions.map((q) => q.id));
    expect(planned.questionSet.isRoundDefault).toBe(false);
    const old = (await as.olive.get(`/api/question-sets/${fixed.id}`)).body as QuestionSetDetail;
    expect(old).toMatchObject({ fixed: true, isRoundDefault: false, fingerprint: fixed.fingerprint });
    expect((await audit('question_set.replaced'))[0]).toMatchObject({ entity_id: next.id, round_id: r });
    // The next interview uses the new set.
    const second = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Bo Li' }, panel: [ids.olive] })).body.id as string;
    expect((await as.olive.get(`/api/interviews/${second}`)).body.set.id).toBe(next.id);
  });

  it('FLOW-8 BANK-11: editing the bank never changes a fixed set; a set built afterwards gets a new comparison code', async () => {
    const r = await newRound(as.olive, { name: 'Bank edit round' });
    const set = await setOf(as.olive, r);
    await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Fixed Person' }, panel: [ids.olive] });
    const fixed = await setOf(as.olive, r);
    const q = fixed.questions[0];
    const bankQ = ((await as.olive.get('/api/bank/tracks/web')).body.questions as Array<Record<string, unknown>>).find((x) => x.id === q.id)!;
    const draft = { text: `${q.text} (edited)`, description: bankQ.description, categoryId: q.categoryId, difficulty: q.difficulty, type: q.type, timeMin: q.timeMin, lookFor: q.lookFor, redFlags: q.redFlags, probes: q.probes, rubricOverride: q.rubricOverride };
    expect((await as.olive.put(`/api/bank/questions/${q.id}`, { draft })).status).toBe(200);
    const again = (await as.olive.get(`/api/question-sets/${set.id}`)).body as QuestionSetDetail;
    expect(again.questions[0]).toEqual(q);
    expect(again.fingerprint).toBe(fixed.fingerprint);
    // The same questions chosen again now take the new version, so the comparison code differs.
    const res = await as.olive.put(`/api/rounds/${r}/question-set`, { ...setInput(fixed), baseSetId: fixed.id, baseVersion: fixed.version });
    expect(res.body.set.questions[0].text).toBe(`${q.text} (edited)`);
    expect(res.body.set.fingerprint).not.toBe(fixed.fingerprint);
  });

  it('ROUND-3 FLOW-9: an individual interview can be given different questions; the round’s set stays as it is', async () => {
    const r = ids.roundA;
    const roundSet = await setOf(as.olive, r);
    const own = setInput(roundSet, roundSet.questions.map((q) => q.id).slice(0, 5));
    const res = await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Cy Park' }, panel: [ids.ian], questions: own });
    expect(res.status).toBe(201);
    const d = (await as.olive.get(`/api/interviews/${res.body.id}`)).body;
    expect(d.set).toMatchObject({ fixed: true, isRoundDefault: false });
    expect(d.set.questions).toHaveLength(5);
    expect(d.set.fingerprint).not.toBe(roundSet.fingerprint);
    const after = await setOf(as.olive, r);
    expect(after).toMatchObject({ id: roundSet.id, version: roundSet.version, fixed: roundSet.fixed });
  });
});

describe('planning interviews (ROUND-4, TEAM-1, TEAM-2, TEAM-15)', () => {
  it('ROUND-4 TEAM-1 PANEL-1 PRIV-1 PRIV-3 FLOW-7: one interview: candidate name or initials, optional date and time, a panel from the team, a note and the recording notice; the audit entry carries no candidate text', async () => {
    const r = ids.roundA;
    const res = await as.olive.post(`/api/rounds/${r}/interviews`, {
      candidate: { name: '  Dee   Ng ', requisitionId: 'req-9' },
      date: '2026-12-02',
      time: '14:00',
      panel: [ids.ian, ids.olive],
      note: 'Room 4',
      recordingNotice: true,
    });
    expect(res.status).toBe(201);
    const d = (await as.ian.get(`/api/interviews/${res.body.id}`)).body;
    expect(d).toMatchObject({ candidate: { name: 'Dee Ng', requisitionId: 'req-9' }, date: '2026-12-02', time: '14:00', note: 'Room 4', recordingNotice: true, state: 'planned', status: 'upcoming', onMyPanel: true, canPlan: false, roundName: 'Web engineers Q1', trackName: 'Senior Software Engineer (Web Applications)' });
    expect(d.panel.map((p: { name: string; status: string }) => [p.name, p.status])).toEqual([
      ['Ian', 'expected'],
      ['Olive', 'expected'],
    ]);
    expect((await as.olive.get(`/api/interviews/${res.body.id}`)).body.canPlan).toBe(true);
    // The same candidate (ignoring case and spaces) is the same candidate: a second interview.
    const again = await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'dee ng', requisitionId: 'REQ-9' }, panel: [ids.olive] });
    expect((await as.olive.get(`/api/interviews/${again.body.id}`)).body.candidate.id).toBe(d.candidate.id);
    const [entry] = await audit('interview.planned');
    expect(JSON.stringify(entry)).not.toMatch(/Dee|dee|Room 4/);
    // Problems are refused with plain words.
    const bad = async (body: Record<string, unknown>) => (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Ok Name' }, panel: [ids.olive], ...body })).body.error?.message as string;
    expect(await bad({ candidate: { name: 'ana@example.com' } })).toMatch(/letters, spaces/);
    expect(await bad({ candidate: { name: 'x'.repeat(61) } })).toMatch(/up to 60/);
    expect(await bad({ time: '10:00' })).toMatch(/A time needs a date/);
    expect(await bad({ date: '2026-02-31' })).toMatch(/not a real day/);
    expect(await bad({ panel: [] })).toMatch(/at least one person/);
    expect(await bad({ note: 'n'.repeat(501) })).toMatch(/under 500/);
    // Interviewers cannot plan.
    expect((await as.ian.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'X' }, panel: [ids.ian] })).status).toBe(403);
  });

  it('TEAM-15 ROUND-4: plan several creates every line at once with the round’s questions, adding named people to the team; one bad line means nothing is created', async () => {
    const r = await newRound(as.olive, { name: 'Bulk round' });
    const lines = Array.from({ length: 25 }, (_, i) => ({ candidate: `Person ${String.fromCharCode(65 + i)}`, date: `2026-12-${String(10 + (i % 5)).padStart(2, '0')}`, time: `${String(9 + (i % 6)).padStart(2, '0')}:00`, panel: [ids.olive, ids.ivy], note: i === 0 ? 'Video link in the invite' : '' }));
    const res = await as.olive.post(`/api/rounds/${r}/interviews/bulk`, { lines, addToTeam: [ids.ivy], recordingNotice: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ids).toHaveLength(25);
    const list = (await as.olive.get(`/api/rounds/${r}/interviews`)).body as InterviewSummary[];
    expect(list).toHaveLength(25);
    expect(new Set(list.map((i) => i.questionSet.id)).size).toBe(1);
    expect(list.every((i) => i.recordingNotice && i.questionSet.isRoundDefault)).toBe(true);
    // Soonest first (TEAM-2).
    expect(list.map((i) => `${i.date} ${i.time}`)).toEqual([...list.map((i) => `${i.date} ${i.time}`)].sort());
    expect((await setOf(as.olive, r)).fixed).toBe(true);
    expect(((await as.olive.get(`/api/rounds/${r}`)).body as RoundDetail).team.find((m) => m.id === ids.ivy)?.role).toBe('interviewer');
    // All or nothing: one bad line, nothing created.
    const bad = await as.olive.post(`/api/rounds/${r}/interviews/bulk`, { lines: [{ candidate: 'Good One', panel: [ids.olive] }, { candidate: 'Bad 123', panel: [ids.olive] }, { candidate: 'Late', time: '09:00', panel: [ids.olive] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([expect.stringMatching(/^Line 2: /), expect.stringMatching(/^Line 3: A time needs a date/)]);
    expect((await as.olive.get(`/api/rounds/${r}/interviews`)).body).toHaveLength(25);
    expect((await as.olive.post(`/api/rounds/${r}/interviews/bulk`, { lines: [] })).status).toBe(400);
  });

  it('TEAM-2 AUD-2: a planned interview’s date, time, panel and note can be changed, and it can be cancelled; both are audited; a started interview cannot be', async () => {
    const r = ids.roundA;
    const id = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Eli Wu' }, panel: [ids.olive], date: '2026-12-03' })).body.id as string;
    const changed = await as.olive.patch(`/api/interviews/${id}`, { date: '2026-12-04', time: '11:15', panel: [ids.ian], note: 'Moved' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ date: '2026-12-04', time: '11:15', note: 'Moved', panel: [{ id: ids.ian }] });
    const [entry] = await audit('interview.changed');
    expect(entry.before).toMatchObject({ date: '2026-12-03', panel: [ids.olive] });
    expect(entry.after).toMatchObject({ date: '2026-12-04', time: '11:15', panel: [ids.ian], noteChanged: true });
    expect(JSON.stringify(entry)).not.toMatch(/Moved/);
    // Clearing the date clears the time.
    expect((await as.olive.patch(`/api/interviews/${id}`, { date: null })).body).toMatchObject({ date: null, time: null });
    expect((await as.ian.patch(`/api/interviews/${id}`, { note: 'x' })).status).toBe(403);
    expect((await as.ian.post(`/api/interviews/${id}/cancel`, {})).status).toBe(403);
    expect((await as.olive.post(`/api/interviews/${id}/cancel`, { reason: 'Withdrew' })).status).toBe(204);
    expect((await as.olive.get(`/api/interviews/${id}`)).status).toBe(404);
    expect(((await as.olive.get(`/api/rounds/${r}/interviews`)).body as InterviewSummary[]).some((i) => i.id === id)).toBe(false);
    expect((await audit('interview.cancelled'))[0]).toMatchObject({ entity_id: id, reason: 'Withdrew' });
    // Once started (step 2b), the plan no longer changes here.
    const started = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Fay Li' }, panel: [ids.olive] })).body.id as string;
    await t.db.updateTable('interviews').set({ state: 'in_progress', started_at: new Date() }).where('id', '=', started).execute();
    expect((await as.olive.patch(`/api/interviews/${started}`, { note: 'x' })).status).toBe(409);
    expect((await as.olive.post(`/api/interviews/${started}/cancel`, {})).status).toBe(409);
    // A team member on a panel cannot be removed until they are taken off it.
    expect((await as.olive.del(`/api/rounds/${r}/members/${ids.ian}`)).body.error.message).toMatch(/on the panel of/);
  });

  it('ROUND-4 TEAM-2 TEAM-16 FLOW-1 FLOW-34: the Dashboard lists the interviews of my rounds, marks the ones I am on, soonest first, with where each one is', async () => {
    const mine = (await as.ian.get('/api/my/interviews')).body as InterviewSummary[];
    expect(mine.length).toBeGreaterThan(3);
    const ianRounds = ((await as.ian.get('/api/rounds')).body as RoundSummary[]).map((x) => x.id);
    expect(ianRounds).toContain(ids.roundA);
    expect(mine.every((i) => ianRounds.includes(i.roundId))).toBe(true);
    expect(mine.filter((i) => i.onMyPanel).length).toBeGreaterThan(0);
    expect(mine.filter((i) => !i.onMyPanel).length).toBeGreaterThan(0);
    const inProgress = mine.find((i) => i.status === 'in-progress');
    expect(inProgress?.candidate.name).toBe('Fay Li');
    // "Waiting for judgements" once someone has submitted.
    await t.db.updateTable('interview_panel').set({ status: 'submitted' }).where('interview_id', '=', inProgress!.id).execute();
    expect(((await as.ian.get('/api/my/interviews')).body as InterviewSummary[]).find((i) => i.id === inProgress!.id)!.status).toBe('waiting');
    const counts = ((await as.ian.get('/api/rounds')).body as RoundSummary[]).find((x) => x.id === ids.roundA)!.counts;
    expect(counts).toMatchObject({ inProgress: 0, waiting: 1, finished: 0 });
    expect(counts.upcoming).toBe(mine.filter((i) => i.roundId === ids.roundA).length - 1);
    expect((await as.oscar.get('/api/my/interviews')).body).toEqual([]);
    expect((await as.rita.get('/api/my/interviews')).status).toBe(403);
  });
});

describe('closed rounds, settings and the round’s audit log (ROUND-5, HPRIV-4)', () => {
  it('ROUND-1 LIVE-3: the round’s name, requisition, retention date and the hide-other-people’s-scores setting are changed by its organisers, audited', async () => {
    const r = ids.roundA;
    const res = await as.olive.patch(`/api/rounds/${r}`, { name: 'Web engineers 2027', requisitionId: '', retentionUntil: '2027-06-30', hideOthersScores: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Web engineers 2027', requisitionId: null, retentionUntil: '2027-06-30', hideOthersScores: true });
    // Planned interviews follow the round's retention date (PRIV-5).
    const i = await t.db.selectFrom('interviews').select('retention_until').where('round_id', '=', r).where('state', '=', 'planned').execute();
    expect(new Set(i.map((x) => x.retention_until))).toEqual(new Set(['2027-06-30']));
    expect((await audit('round.changed'))[0].after).toEqual({ name: 'Web engineers 2027', requisitionId: null, retentionUntil: '2027-06-30', hideOthersScores: true });
    expect((await as.olive.patch(`/api/rounds/${r}`, { retentionUntil: '2020-01-01' })).status).toBe(400);
    expect((await as.ian.patch(`/api/rounds/${r}`, { name: 'x' })).status).toBe(403);
  });

  it('ROUND-5 HPRIV-4: closing a round makes it read-only for everyone; it can be reopened with a reason; organisers read their round’s audit entries, interviewers do not', async () => {
    const r = await newRound(as.olive, { name: 'Closing round' });
    await as.olive.put(`/api/rounds/${r}/members/${ids.ian}`, { role: 'interviewer' });
    const planned = (await as.olive.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'Gus Ng' }, panel: [ids.ian] })).body.id as string;
    expect((await as.ian.post(`/api/rounds/${r}/close`, {})).status).toBe(403);
    const closed = await as.olive.post(`/api/rounds/${r}/close`, { reason: 'Role filled' });
    expect(closed.body).toMatchObject({ state: 'closed', canPlan: false, canManage: true, closeReason: 'Role filled' });
    const set = await setOf(as.olive, r);
    for (const c of [as.olive, as.admin]) {
      expect((await c.post(`/api/rounds/${r}/interviews`, { candidate: { name: 'New' }, panel: [ids.olive] })).status).toBe(403);
      expect((await c.post(`/api/rounds/${r}/interviews/bulk`, { lines: [] })).status).toBe(403);
      expect((await c.patch(`/api/interviews/${planned}`, { note: 'x' })).status).toBe(403);
      expect((await c.post(`/api/interviews/${planned}/cancel`, {})).status).toBe(403);
      expect((await c.put(`/api/rounds/${r}/question-set`, { ...setInput(set), baseSetId: set.id, baseVersion: set.version })).status).toBe(403);
      expect((await c.patch(`/api/rounds/${r}`, { name: 'Renamed' })).status).toBe(409);
      expect((await c.put(`/api/rounds/${r}/members/${ids.ivy}`, { role: 'interviewer' })).status).toBe(409);
      expect((await c.del(`/api/rounds/${r}/members/${ids.ian}`)).status).toBe(409);
    }
    // Reading still works for the team.
    expect((await as.ian.get(`/api/rounds/${r}/interviews`)).status).toBe(200);
    expect((await as.ian.get(`/api/interviews/${planned}`)).body.canPlan).toBe(false);
    // Reopening needs a reason.
    expect((await as.olive.post(`/api/rounds/${r}/reopen`, { reason: ' ' })).status).toBe(400);
    expect((await as.olive.post(`/api/rounds/${r}/reopen`, { reason: 'Second opening' })).body).toMatchObject({ state: 'open', canPlan: true });
    expect((await as.olive.patch(`/api/interviews/${planned}`, { note: 'x' })).status).toBe(200);
    const log = (await as.olive.get(`/api/rounds/${r}/audit`)).body as Array<{ action: string; reason: string | null }>;
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['round.created', 'round.member_added', 'question_set.fixed', 'interview.planned', 'round.closed', 'round.reopened', 'interview.changed']));
    expect(log.find((e) => e.action === 'round.reopened')!.reason).toBe('Second opening');
    expect((await as.ian.get(`/api/rounds/${r}/audit`)).status).toBe(403);
    expect((await as.oscar.get(`/api/rounds/${r}/audit`)).status).toBe(404);
  });

  it('ROUND-2 HOST-5: only the round’s team (and administrators) can follow its live updates', async () => {
    const actor = (name: string, role: (typeof PEOPLE)[keyof typeof PEOPLE]) => ({ id: ids[name], email: `${name}@example.test`, name, role });
    const topic = `round:${ids.roundA}`;
    expect(await topicAllowed(a.ctx, actor('ian', 'interviewer'), topic)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('olive', 'organiser'), topic)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('admin', 'admin'), topic)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('oscar', 'organiser'), topic)).toBe(false);
    expect(await topicAllowed(a.ctx, actor('rita', 'reviewer'), topic)).toBe(false);
    expect(await topicAllowed(a.ctx, actor('ian', 'interviewer'), 'round:00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(await topicAllowed(a.ctx, actor('ian', 'interviewer'), 'rounds')).toBe(false);
    expect(await topicAllowed(a.ctx, actor('admin', 'admin'), 'rounds')).toBe(true);
  });
});
