// LIVE-1…LIVE-8, FLOW-7, FLOW-10, FLOW-13…FLOW-25, FLOW-31, FLOW-32, AUD-2, AUD-4, HOST-5, HOST-6,
// RES-1, RES-2: interviewing together, against a real PostgreSQL, through the HTTP API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, seedBank, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { topicAllowed } from '../live/routes';
import type { LiveEvent, LiveRecords, LiveState, QuestionSetDetail, RecordDetail, RecordOp, ScorecardData } from '../../src/shared/api';

let t: TestDb;
let a: TestApp;
type C = ReturnType<typeof client>;
const as: Record<string, C> = {};
const ids: Record<string, string> = {};

/** Olive organises the round; Ana, Ben and Cy are interviewers on it; Ivy is on the team but not on panels. */
const PEOPLE = {
  admin: 'admin',
  olive: 'organiser',
  oscar: 'organiser', // not on the round
  ana: 'interviewer',
  ben: 'interviewer',
  cy: 'interviewer',
  ivy: 'interviewer',
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
  const r = await as.olive.post('/api/rounds', { name: 'Live round', trackId: 'qa' });
  ids.round = r.body.id;
  for (const p of ['ana', 'ben', 'cy', 'ivy']) await as.olive.put(`/api/rounds/${ids.round}/members/${ids[p]}`, { role: 'interviewer' });
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

async function plan(panel: string[], extra: Record<string, unknown> = {}, round = ids.round): Promise<string> {
  const r = await as.olive.post(`/api/rounds/${round}/interviews`, { candidate: { name: `Cand ${Math.random().toString(36).slice(2, 6).replace(/\d/g, 'x')}` }, panel: panel.map((p) => ids[p]), ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
}
const state = async (by: C, id: string): Promise<LiveState> => (await by.get(`/api/interviews/${id}/live`)).body;
const records = async (by: C, id: string): Promise<LiveRecords> => (await by.get(`/api/interviews/${id}/records`)).body;
const setOf = async (id: string): Promise<QuestionSetDetail> => (await as.olive.get(`/api/interviews/${id}`)).body.set;
const ops = (by: C, recordId: string, list: RecordOp[]) => by.post(`/api/records/${recordId}/ops`, { ops: list });
const audit = async (action: string, entityId?: string) => {
  let q = t.db.selectFrom('audit_events').selectAll().where('action', '=', action);
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.orderBy('id', 'desc').execute();
};
const uuid = () => crypto.randomUUID();

/** Plans, starts (Ana) and joins (Ben) an interview; returns ids. */
async function running(panel = ['ana', 'ben']) {
  const id = await plan(panel);
  const s = await as.ana.post(`/api/interviews/${id}/start`, { consent: true });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const joins: Record<string, string> = { ana: s.body.state.me.recordId };
  for (const p of panel.slice(1)) {
    const j = await as[p].post(`/api/interviews/${id}/join`, {});
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    joins[p] = j.body.recordId;
  }
  return { id, rec: joins, set: await setOf(id) };
}

/** Resolves every question of a record and fills the overall assessment, so it can be submitted. */
async function complete(by: C, recordId: string, set: QuestionSetDetail, score: 1 | 2 | 3 | 4 = 3) {
  const list: RecordOp[] = set.questions.map((q) => ({ t: 'score', q: q.id, v: score }));
  if (score === 1 || score === 4) for (const q of set.questions) list.push({ t: 'note.add', id: uuid(), q: q.id, atSec: 5, text: 'Said something specific', by: null });
  list.push({ t: 'overall', rating: 3, recommendation: 'hire', rationale: 'Solid answers.' });
  const r = await ops(by, recordId, list);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('starting and joining (FLOW-7, FLOW-10, LIVE-6, LIVE-8)', () => {
  it('LIVE-6 FLOW-10 FLOW-7 PRIV-4 AUD-2 RES-2 DATA-6: a panel member confirms consent and starts; consent is stored once with who, when and the recording notice; the starter leads; the timers run from the server’s clock', async () => {
    const id = await plan(['ana', 'ben'], { recordingNotice: true });
    expect((await as.ana.post(`/api/interviews/${id}/start`, {})).status).toBe(400); // the confirmation is required
    expect((await as.ana.post(`/api/interviews/${id}/start`, { consent: false })).status).toBe(400);
    const before = await state(as.ana, id);
    expect(before).toMatchObject({ state: 'planned', consent: null, me: { onPanel: true, canStart: true, recordId: null } });
    const r = await as.ana.post(`/api/interviews/${id}/start`, { consent: true });
    expect(r.status).toBe(200);
    const s: LiveState = r.body.state;
    const set = await setOf(id);
    expect(s).toMatchObject({ state: 'in_progress', currentQuestionId: set.questions[0].id, leadUserId: ids.ana, consent: { byName: 'Ana', recordingNotice: true } });
    expect(s.me.recordId).toMatch(/^[0-9a-f-]{36}$/);
    // RES-2: the timers are timestamps in the server's clock, not counters.
    expect(s.timer.accumulatedMs).toBe(0);
    expect(Math.abs(s.serverNow - s.timer.runningSince!)).toBeLessThan(5_000);
    expect(s.questionTimers[set.questions[0].id].runningSince).toBe(s.timer.runningSince);
    // Consent is stored once: a second start (Ben, a moment later) changes nothing.
    const again = await as.ben.post(`/api/interviews/${id}/start`, { consent: true });
    expect(again.body.alreadyStarted).toBe(true);
    const after = await state(as.ben, id);
    expect(after.consent).toEqual(s.consent);
    expect(after.leadUserId).toBe(ids.ana);
    expect(after.me).toMatchObject({ status: 'expected', recordId: null, canStart: false });
    // AUD-2: consent confirmed and the start, in the round's log, without candidate details.
    const [consent] = await audit('interview.consent_confirmed', id);
    expect(consent).toMatchObject({ actor_id: ids.ana, round_id: ids.round, after: { recordingNotice: true } });
    expect((await audit('interview.started', id))).toHaveLength(1);
    expect(JSON.stringify(consent)).not.toContain('Cand');
    const row = await t.db.selectFrom('interviews').select(['consent_at', 'consent_by', 'recording_consent_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.consent_by).toBe(ids.ana);
    expect(row.recording_consent_at?.getTime()).toBe(row.consent_at?.getTime());
  });

  it('LIVE-8 LIVE-1: others who open the interview see it running and join; joining again changes nothing; people not on the panel cannot join', async () => {
    const id = await plan(['ana', 'ben']);
    await as.ana.post(`/api/interviews/${id}/start`, { consent: true });
    const j1 = await as.ben.post(`/api/interviews/${id}/join`, {});
    const j2 = await as.ben.post(`/api/interviews/${id}/join`, {});
    expect(j1.body.recordId).toBe(j2.body.recordId);
    expect((await t.db.selectFrom('records').select('id').where('interview_id', '=', id).execute()).length).toBe(2);
    expect((await state(as.ben, id)).panel.map((p) => [p.name, p.status])).toEqual([
      ['Ana', 'joined'],
      ['Ben', 'joined'],
    ]);
    expect((await as.ivy.post(`/api/interviews/${id}/join`, {})).status).toBe(403);
    expect((await as.olive.post(`/api/interviews/${id}/join`, {})).status).toBe(403);
    expect((await as.oscar.post(`/api/interviews/${id}/join`, {})).status).toBe(404);
    expect((await as.rita.post(`/api/interviews/${id}/join`, {})).status).toBe(404);
    // A planned interview cannot be joined before it starts.
    const planned = await plan(['ana']);
    expect((await as.ana.post(`/api/interviews/${planned}/join`, {})).status).toBe(409);
  });

  it('LIVE-6 FLOW-10: an organiser of the round who is not on the panel can start it; the first panel member to join then leads', async () => {
    const id = await plan(['ben']);
    expect((await as.ivy.post(`/api/interviews/${id}/start`, { consent: true })).status).toBe(403); // on the team, not on the panel
    const s = await as.olive.post(`/api/interviews/${id}/start`, { consent: true });
    expect(s.body.state).toMatchObject({ state: 'in_progress', leadUserId: null, consent: { byName: 'Olive' }, me: { onPanel: false, recordId: null } });
    await as.ben.post(`/api/interviews/${id}/join`, {});
    expect((await state(as.ben, id)).leadUserId).toBe(ids.ben);
  });

  it('LIVE-5 PANEL-2 PANEL-4 DATA-5: two panel members can share one screen and one record with both names on it', async () => {
    const id = await plan(['ana', 'ben', 'cy']);
    const s = await as.ana.post(`/api/interviews/${id}/start`, { consent: true, scoringWith: [ids.ben] });
    const recordId = s.body.state.me.recordId;
    const st: LiveState = s.body.state;
    expect(st.panel.find((p) => p.id === ids.ben)).toMatchObject({ status: 'joined', onRecordOf: ids.ana, recordId: null });
    const rec = (await records(as.ana, id)).mine!;
    expect(rec).toMatchObject({ id: recordId, names: ['Ana', 'Ben'], sharedWith: [ids.ben] });
    // Ben sees Ana's record as his; he cannot write it, nor join on his own as well.
    const benView = await records(as.ben, id);
    expect(benView.mine?.id).toBe(recordId);
    expect((await state(as.ben, id)).me.onRecordOf).toBe(ids.ana);
    expect((await as.ben.post(`/api/interviews/${id}/join`, {})).body.error.message).toMatch(/scoring with Ana on their screen/);
    expect((await ops(as.ben, recordId, [{ t: 'flag', q: st.currentQuestionId!, on: true }])).status).toBe(403);
    // Only panel members who have not joined can share a screen.
    await as.cy.post(`/api/interviews/${id}/join`, {});
    const other = await plan(['ana', 'ivy']);
    expect((await as.ana.post(`/api/interviews/${other}/start`, { consent: true, scoringWith: [ids.cy] })).status).toBe(400);
  });
});

describe('the shared interview (LIVE-2, HOST-5)', () => {
  it('LIVE-2 FLOW-20: the lead’s moves move everyone; a follower’s are refused; anyone who joined takes the lead with one click', async () => {
    const { id, set } = await running();
    const [q1, q2, q3] = set.questions.map((q) => q.id);
    const moved = await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: q2 });
    expect(moved.body.currentQuestionId).toBe(q2);
    expect((await state(as.ben, id)).currentQuestionId).toBe(q2);
    const refused = await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: q2, to: q3 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('Ana is leading now. Take the lead to move everyone.');
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'pause' })).status).toBe(409);
    const v = (await state(as.ben, id)).version;
    const lead = await as.ben.post(`/api/interviews/${id}/command`, { type: 'lead' });
    expect(lead.body).toMatchObject({ leadUserId: ids.ben, version: v + 1 });
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'lead' })).body.version).toBe(v + 1); // idempotent
    expect((await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q2, to: q3 })).status).toBe(409);
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: q2, to: q1 })).body.currentQuestionId).toBe(q1);
    // A jump anywhere in the set (FLOW-20), but not outside it.
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: set.questions[9].id })).body.currentQuestionId).toBe(set.questions[9].id);
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: set.questions[9].id, to: 'web-1' })).status).toBe(400);
    expect((await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: q2, extra: 1 })).status).toBe(400);
  });

  it('LIVE-2 HOST-5: two people pressing Next at the same moment move the panel on by one question, not two', async () => {
    const { id, set } = await running();
    const [q1, q2] = set.questions.map((q) => q.id);
    // The same "from question 1 to question 2", sent at once from two tabs of the lead.
    const results = await Promise.all(Array.from({ length: 5 }, () => as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: q2 })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const s = await state(as.ana, id);
    expect(s.currentQuestionId).toBe(q2);
    // The lead's Next racing a take-over: exactly one of them wins, and the panel moves at most once.
    const [next, take] = await Promise.all([as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q2, to: set.questions[2].id }), as.ben.post(`/api/interviews/${id}/command`, { type: 'lead' })]);
    expect(take.status).toBe(200);
    const after = await state(as.ana, id);
    expect([q2, set.questions[2].id]).toContain(after.currentQuestionId);
    expect(next.status === 200).toBe(after.currentQuestionId === set.questions[2].id);
    // A stale move (the panel is no longer where the sender thought) is refused, with where it is.
    const stale = await as.ben.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: q2 });
    if (after.currentQuestionId !== q2) expect(stale.body.error.message).toMatch(/already moved to question 3/);
  });

  it('FLOW-21 FLOW-19 RES-2 LIVE-2 DATA-3: pause stops both timers for everyone, resume restarts them; each question keeps its own time', async () => {
    const { id, set } = await running();
    const [q1, q2] = set.questions.map((q) => q.id);
    await new Promise((r) => setTimeout(r, 120));
    await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q1, to: q2 });
    const paused: LiveState = (await as.ana.post(`/api/interviews/${id}/command`, { type: 'pause' })).body;
    expect(paused.state).toBe('paused');
    expect(paused.timer.runningSince).toBeNull();
    expect(paused.questionTimers[q1].runningSince).toBeNull();
    expect(paused.questionTimers[q1].accumulatedMs).toBeGreaterThanOrEqual(100);
    expect(paused.questionTimers[q2].runningSince).toBeNull();
    expect(paused.timer.accumulatedMs).toBeGreaterThanOrEqual(paused.questionTimers[q1].accumulatedMs + paused.questionTimers[q2].accumulatedMs - 5);
    expect((await as.ana.post(`/api/interviews/${id}/command`, { type: 'pause' })).body.version).toBe(paused.version); // idempotent
    // Moving while paused keeps the timers stopped.
    const movedPaused: LiveState = (await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: q2, to: q1 })).body;
    expect(movedPaused.questionTimers[q1].runningSince).toBeNull();
    const resumed: LiveState = (await as.ana.post(`/api/interviews/${id}/command`, { type: 'resume' })).body;
    expect(resumed.state).toBe('in_progress');
    expect(resumed.timer.accumulatedMs).toBe(paused.timer.accumulatedMs);
    expect(resumed.questionTimers[q1].runningSince).toBe(resumed.timer.runningSince);
    expect((await state(as.ben, id)).state).toBe('in_progress');
  });

  it('HOST-5 LIVE-2: a change made through one server instance reaches a listener on another instance through the database, within a second, carrying no data', async () => {
    const second = await startApp(t);
    try {
      const { id, set } = await running();
      const got: Array<{ e: LiveEvent; at: number }> = [];
      const off = second.ctx.live.subscribe([`interview:${id}`], (e) => got.push({ e: e as LiveEvent, at: Date.now() }));
      const sent = Date.now();
      await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: set.questions[0].id, to: set.questions[1].id });
      await expect.poll(() => got.length, { timeout: 2_000 }).toBeGreaterThan(0);
      off();
      expect(got[0].e).toEqual({ topic: `interview:${id}`, kind: 'state' });
      expect(got[0].at - sent).toBeLessThan(1_000);
      // The second instance serves the same state (nothing is kept in memory).
      const viaSecond = client(second.app, await signIn(second.app, 'ben@example.test'));
      expect((await state(viaSecond, id)).currentQuestionId).toBe(set.questions[1].id);
    } finally {
      await second.close();
    }
  });

  it('HOST-5 LIVE-2: only the round’s team (and administrators) can follow an interview’s live updates', async () => {
    const id = await plan(['ana']);
    const actor = (name: keyof typeof PEOPLE) => ({ id: ids[name], email: `${name}@example.test`, name, role: PEOPLE[name] });
    expect(await topicAllowed(a.ctx, actor('ana'), `interview:${id}`)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('ivy'), `interview:${id}`)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('admin'), `interview:${id}`)).toBe(true);
    expect(await topicAllowed(a.ctx, actor('oscar'), `interview:${id}`)).toBe(false);
    expect(await topicAllowed(a.ctx, actor('rita'), `interview:${id}`)).toBe(false);
    expect(await topicAllowed(a.ctx, actor('ana'), 'interview:00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('LIVE-3 HOST-5: presence is a heartbeat stored in the database; only panel members show; leaving removes it', async () => {
    const { id } = await running();
    expect((await as.ana.post(`/api/interviews/${id}/presence`, { here: true })).status).toBe(204);
    await as.ivy.post(`/api/interviews/${id}/presence`, { here: true }); // on the team, not the panel: not shown
    const s = await state(as.ben, id);
    const ana = s.panel.find((p) => p.id === ids.ana)!;
    expect(Math.abs(ana.seenAt! - s.serverNow)).toBeLessThan(5_000);
    expect(s.panel.find((p) => p.id === ids.ben)!.seenAt).toBeNull();
    expect(s.panel.some((p) => p.id === ids.ivy)).toBe(false);
    await as.ana.post(`/api/interviews/${id}/presence`, { here: false });
    expect((await state(as.ben, id)).panel.find((p) => p.id === ids.ana)!.seenAt).toBeNull();
    expect((await as.oscar.post(`/api/interviews/${id}/presence`, { here: true })).status).toBe(404);
  });

  it('FLOW-11 LIVE-7: the candidate window gets only the number and text of the panel’s question; nothing while paused or before the start', async () => {
    const id = await plan(['ana']);
    expect((await as.ana.get(`/api/interviews/${id}/present`)).body).toEqual({ state: 'planned', position: null, total: 14, text: null });
    await as.ana.post(`/api/interviews/${id}/start`, { consent: true });
    const set = await setOf(id);
    await as.ana.post(`/api/interviews/${id}/command`, { type: 'move', from: set.questions[0].id, to: set.questions[3].id });
    const p = (await as.ana.get(`/api/interviews/${id}/present`)).body;
    expect(p).toEqual({ state: 'in_progress', position: 4, total: 14, text: set.questions[3].text });
    expect(Object.keys(p).sort()).toEqual(['position', 'state', 'text', 'total']);
    await as.ana.post(`/api/interviews/${id}/command`, { type: 'pause' });
    expect((await as.ana.get(`/api/interviews/${id}/present`)).body).toMatchObject({ state: 'paused', text: null });
    expect((await as.oscar.get(`/api/interviews/${id}/present`)).status).toBe(404);
  });
});

describe('each person’s record (LIVE-1, FLOW-13…FLOW-18, RES-1, HOST-6)', () => {
  it('LIVE-1 FLOW-13 FLOW-14 FLOW-15 FLOW-17 FLOW-18 RUB-3: the owner ticks, scores, notes (with the elapsed time), flags and skips; the server stores exactly what the browser showed', async () => {
    const { rec, set } = await running();
    const q = set.questions[0];
    const noteId = uuid();
    const r = await ops(as.ana, rec.ana, [
      { t: 'kp', q: q.id, i: 0, on: true },
      { t: 'kp', q: q.id, i: 2, on: true },
      { t: 'rf', q: q.id, i: 1, on: true },
      { t: 'probe', q: q.id, on: true },
      { t: 'score', q: q.id, v: 2 },
      { t: 'flag', q: q.id, on: true },
      { t: 'note.add', id: noteId, q: q.id, atSec: 95, text: 'Explained the trade-off', by: null },
      { t: 'skip', q: set.questions[1].id, reason: 'Ran short' },
    ]);
    expect(r.status).toBe(200);
    const mine: RecordDetail = r.body;
    expect(mine.answers.find((x) => x.questionId === q.id)).toEqual({ questionId: q.id, score: 2, coveredKeyPoints: [0, 2], redFlagsSeen: [1], probeHandled: true, flagged: true, skipped: false, skipReason: null });
    expect(mine.answers.find((x) => x.questionId === set.questions[1].id)).toMatchObject({ skipped: true, skipReason: 'Ran short', score: null });
    expect(mine.notes).toEqual([{ id: noteId, questionId: q.id, atSec: 95, text: 'Explained the trade-off', by: null }]);
    // FLOW-17: choosing a score undoes a skip; unskip clears the reason.
    const r2: RecordDetail = (await ops(as.ana, rec.ana, [{ t: 'score', q: set.questions[1].id, v: 3 }])).body;
    expect(r2.answers.find((x) => x.questionId === set.questions[1].id)).toMatchObject({ skipped: false, skipReason: null, score: 3 });
    // Notes are edited and deleted by id.
    const r3: RecordDetail = (await ops(as.ana, rec.ana, [{ t: 'note.edit', id: noteId, text: 'Explained the trade-off well' }])).body;
    expect(r3.notes[0].text).toBe('Explained the trade-off well');
    expect(((await ops(as.ana, rec.ana, [{ t: 'note.del', id: noteId }])).body as RecordDetail).notes).toEqual([]);
  });

  it('LIVE-1 AUTH-5: only the owner writes a record: another panel member, an organiser and an administrator are refused; people off the round get "not found"', async () => {
    const { rec, set } = await running();
    const op: RecordOp[] = [{ t: 'score', q: set.questions[0].id, v: 4 }];
    expect((await ops(as.ben, rec.ana, op)).status).toBe(403);
    expect((await ops(as.olive, rec.ana, op)).status).toBe(403);
    expect((await ops(as.admin, rec.ana, op)).status).toBe(403);
    expect((await ops(as.ivy, rec.ana, op)).status).toBe(403);
    expect((await ops(as.oscar, rec.ana, op)).status).toBe(404);
    expect((await ops(as.rita, rec.ana, op)).status).toBe(404);
    expect((await as.ben.post(`/api/records/${rec.ana}/submit`)).status).toBe(403);
    expect((await as.admin.post(`/api/records/${rec.ana}/amend`, { reason: 'x', overall: { rating: 1 } })).status).toBe(403);
    // Nothing was written.
    expect((await records(as.ana, (await t.db.selectFrom('records').select('interview_id').where('id', '=', rec.ana).executeTakeFirstOrThrow()).interview_id)).mine!.answers).toEqual([]);
  });

  it('HOST-6 RES-1 OV-1: changes resent after a lost connection, and the same changes from two tabs, are stored once and never undo each other', async () => {
    const { rec, set } = await running();
    const q = set.questions[0].id;
    const noteId = uuid();
    const batch: RecordOp[] = [
      { t: 'kp', q, i: 0, on: true },
      { t: 'note.add', id: noteId, q, atSec: 10, text: 'First', by: null },
    ];
    await ops(as.ana, rec.ana, batch);
    await ops(as.ana, rec.ana, batch); // the same batch again (the reply was lost)
    // Two tabs tick different key points at the same moment: both stay ticked.
    await Promise.all([ops(as.ana, rec.ana, [{ t: 'kp', q, i: 1, on: true }]), ops(as.ana, rec.ana, [{ t: 'kp', q, i: 3, on: true }])]);
    const mine = (await as.ana.get(`/api/records/${rec.ana}`)).body as ScorecardData;
    expect(mine.record.notes.map((n) => n.id)).toEqual([noteId]);
    expect(mine.record.answers[0].coveredKeyPoints).toEqual([0, 1, 3]);
    // A note id taken by another record is refused.
    expect((await ops(as.ben, rec.ben, [{ t: 'note.add', id: noteId, q, atSec: 1, text: 'x', by: null }])).status).toBe(409);
  });

  it('RES-1 SEC-2: changes are validated strictly: unknown questions, key points and fields are refused, and one bad change refuses the whole batch', async () => {
    const { rec, set } = await running();
    const q = set.questions[0];
    const bad = async (list: unknown[]) => (await as.ana.post(`/api/records/${rec.ana}/ops`, { ops: list })).status;
    expect(await bad([{ t: 'score', q: 'web-1', v: 3 }])).toBe(400);
    expect(await bad([{ t: 'kp', q: q.id, i: q.lookFor.length, on: true }])).toBe(400);
    expect(await bad([{ t: 'score', q: q.id, v: 5 }])).toBe(400);
    expect(await bad([{ t: 'score', q: q.id, v: 3, owner: 'x' }])).toBe(400);
    expect(await bad([{ t: 'skip', q: q.id, reason: '  ' }])).toBe(400);
    expect(await bad([{ t: 'score', q: q.id, v: 3 }, { t: 'kp', q: q.id, i: 99, on: true }])).toBe(400);
    expect(await bad([])).toBe(400);
    expect((await as.ana.get(`/api/records/${rec.ana}`)).body.record.answers).toEqual([]);
  });
});

describe('other people’s marks (LIVE-3, FLOW-27)', () => {
  it('LIVE-3: by default each panel member sees whether the others have scored a question, and their score, ticks and notes', async () => {
    const { id, rec, set } = await running();
    const q = set.questions[0].id;
    await ops(as.ben, rec.ben, [{ t: 'score', q, v: 3 }, { t: 'kp', q, i: 1, on: true }, { t: 'note.add', id: uuid(), q, atSec: 3, text: 'Ben’s note', by: null }]);
    const seen = await records(as.ana, id);
    expect(seen.hidden).toBe(false);
    expect(seen.others).toHaveLength(1);
    expect(seen.others[0]).toMatchObject({ ownerId: ids.ben, names: ['Ben'], state: 'draft', resolved: [q] });
    expect(seen.others[0].marks!.answers[0]).toMatchObject({ score: 3, coveredKeyPoints: [1] });
    expect(seen.others[0].marks!.notes[0].text).toBe('Ben’s note');
    // An organiser watching sees the same; the overall assessment of a draft is not shown.
    expect((await records(as.olive, id)).others.find((o) => o.ownerId === ids.ben)!.marks!.overall).toEqual({ rating: null, recommendation: null, rationale: '' });
  });

  it('LIVE-3 FLOW-27 AUTH-5: when the round hides them, the server sends nobody another person’s marks until their own record is submitted; who has scored still shows', async () => {
    const r = await as.olive.post('/api/rounds', { name: 'Blind round', trackId: 'qa' });
    const round = r.body.id as string;
    for (const p of ['ana', 'ben']) await as.olive.put(`/api/rounds/${round}/members/${ids[p]}`, { role: 'interviewer' });
    await as.olive.patch(`/api/rounds/${round}`, { hideOthersScores: true });
    const id = await plan(['ana', 'ben'], {}, round);
    const ana = (await as.ana.post(`/api/interviews/${id}/start`, { consent: true })).body.state.me.recordId as string;
    const ben = (await as.ben.post(`/api/interviews/${id}/join`, {})).body.recordId as string;
    const set = await setOf(id);
    await complete(as.ben, ben, set, 2);
    await ops(as.ana, ana, [{ t: 'score', q: set.questions[0].id, v: 4 }]);
    const forAna = await records(as.ana, id);
    expect(forAna.hidden).toBe(true);
    expect(forAna.others[0].marks).toBeNull();
    expect(forAna.others[0].resolved).toHaveLength(set.questions.length);
    expect(JSON.stringify(forAna)).not.toContain('Solid answers');
    // The organiser (no record of their own) sees nothing either while the interview runs.
    expect((await records(as.olive, id)).others.every((o) => o.marks === null)).toBe(true);
    // Ben submits; he now sees Ana's marks. Ana still does not see his, nor his scorecard.
    expect((await as.ben.post(`/api/records/${ben}/submit`)).status).toBe(200);
    expect((await records(as.ben, id)).others[0].marks!.answers[0].score).toBe(4);
    expect((await records(as.ana, id)).others[0].marks).toBeNull();
    const hiddenCard = await as.ana.get(`/api/records/${ben}`);
    expect(hiddenCard.status).toBe(403);
    expect(JSON.stringify(hiddenCard.body)).not.toContain('Solid answers');
    // Ana submits: now she sees Ben's marks and scorecard.
    await complete(as.ana, ana, set, 4);
    await as.ana.post(`/api/records/${ana}/submit`);
    expect((await records(as.ana, id)).others[0].marks!.overall.rationale).toBe('Solid answers.');
    expect((await as.ana.get(`/api/records/${ben}`)).status).toBe(200);
    expect((await as.olive.get(`/api/records/${ben}`)).status).toBe(200); // complete: the round's organisers see it
  });
});

describe('finishing (LIVE-4, FLOW-22, FLOW-23, AUD-4)', () => {
  it('FLOW-22 FLOW-16 RUB-4 UX-6: a record is submitted only when every question is scored or skipped, each 1 or 4 has a note, and the overall assessment is complete', async () => {
    const { rec, set } = await running();
    const r1 = await as.ana.post(`/api/records/${rec.ana}/submit`);
    expect(r1.status).toBe(400);
    expect(r1.body.error.details).toEqual(expect.arrayContaining(['Question 1 is neither scored nor skipped.', 'Give an overall rating (1-4).', 'Choose a recommendation.', 'Write a rationale for your recommendation.']));
    await ops(as.ana, rec.ana, [...set.questions.map((q): RecordOp => ({ t: 'score', q: q.id, v: 3 })), { t: 'score', q: set.questions[4].id, v: 4 }, { t: 'overall', rating: 3, recommendation: 'hire', rationale: 'Good.' }]);
    const r2 = await as.ana.post(`/api/records/${rec.ana}/submit`);
    expect(r2.body.error.details).toEqual(['Question 5 is scored 4 and needs a note of what the candidate said.']);
    await ops(as.ana, rec.ana, [{ t: 'note.add', id: uuid(), q: set.questions[4].id, atSec: 400, text: 'Quantified the outcome', by: null }]);
    expect((await as.ana.post(`/api/records/${rec.ana}/submit`)).status).toBe(200);
  });

  it('LIVE-4 FLOW-23 AUD-2 TEAM-6 DATA-2: each member submits their own record; it is then read-only; the interview waits for those who joined and completes when the last one submits; the timers stop', async () => {
    const { id, rec, set } = await running(['ana', 'ben', 'cy']);
    await complete(as.ana, rec.ana, set);
    await as.ana.post(`/api/records/${rec.ana}/submit`);
    expect((await ops(as.ana, rec.ana, [{ t: 'score', q: set.questions[0].id, v: 1 }])).status).toBe(409);
    let s = await state(as.ben, id);
    expect(s.state).toBe('in_progress');
    expect(s.panel.map((p) => [p.name, p.status])).toEqual([
      ['Ana', 'submitted'],
      ['Ben', 'joined'],
      ['Cy', 'joined'],
    ]);
    // The lead passes on when the lead submits.
    expect(s.leadUserId).toBe(ids.ben);
    const summary = (await as.ivy.get(`/api/rounds/${ids.round}/interviews`)).body.find((x: { id: string }) => x.id === id);
    expect(summary.status).toBe('waiting');
    await complete(as.ben, rec.ben, set);
    await as.ben.post(`/api/records/${rec.ben}/submit`);
    await complete(as.cy, rec.cy, set, 2);
    await as.cy.post(`/api/records/${rec.cy}/submit`);
    s = await state(as.ana, id);
    expect(s.state).toBe('completed');
    expect(s.timer.runningSince).toBeNull();
    expect(Object.values(s.questionTimers).every((x) => x.runningSince === null)).toBe(true);
    expect((await as.ivy.get(`/api/rounds/${ids.round}/interviews`)).body.find((x: { id: string }) => x.id === id).status).toBe('finished');
    expect((await audit('record.submitted')).filter((e) => (e.after as { interviewId: string }).interviewId === id)).toHaveLength(3);
    expect(await audit('interview.completed', id)).toHaveLength(1);
    // Nothing can be joined or moved once complete.
    expect((await as.ana.post(`/api/interviews/${id}/command`, { type: 'resume' })).status).toBe(409);
  });

  it('LIVE-4: a panel member who never joined does not hold the interview up; an organiser marks them "did not take part" and can take it back; interviewers cannot', async () => {
    const { id, rec, set } = await running(['ana', 'ben']);
    const third = await plan(['ana', 'cy']);
    // Cy never joins the second interview.
    await as.ana.post(`/api/interviews/${third}/start`, { consent: true });
    expect((await as.ana.put(`/api/interviews/${third}/panel/${ids.cy}`, { didNotTakePart: true })).status).toBe(403);
    expect((await as.olive.put(`/api/interviews/${third}/panel/${ids.cy}`, { didNotTakePart: true })).body.panel.find((p: { id: string }) => p.id === ids.cy).status).toBe('did_not_take_part');
    expect((await as.cy.post(`/api/interviews/${third}/join`, {})).status).toBe(409);
    expect((await as.olive.put(`/api/interviews/${third}/panel/${ids.cy}`, { didNotTakePart: false })).body.panel.find((p: { id: string }) => p.id === ids.cy).status).toBe('expected');
    expect((await as.olive.put(`/api/interviews/${third}/panel/${ids.ana}`, { didNotTakePart: true })).status).toBe(409); // Ana joined
    expect(await audit('interview.marked_did_not_take_part', third)).toHaveLength(1);
    // In the first interview Ben joined: Ana's submission alone does not complete it.
    await complete(as.ana, rec.ana, set);
    await as.ana.post(`/api/records/${rec.ana}/submit`);
    expect((await state(as.ana, id)).state).toBe('in_progress');
    // In the second, Cy never joined: Ana's submission completes it.
    const set3 = await setOf(third);
    const anaRec = (await state(as.ana, third)).me.recordId!;
    await complete(as.ana, anaRec, set3);
    await as.ana.post(`/api/records/${anaRec}/submit`);
    expect((await state(as.ana, third)).state).toBe('completed');
  });

  it('AUD-4 FLOW-23: a submitted record is amended only by its owner, with a reason; the log keeps the values before and after; the finish rules still hold', async () => {
    const { rec, set } = await running(['ana']);
    await complete(as.ana, rec.ana, set);
    await as.ana.post(`/api/records/${rec.ana}/submit`);
    const q = set.questions[2].id;
    expect((await as.ana.post(`/api/records/${rec.ana}/amend`, { reason: ' ', question: { id: q, score: 2 } })).status).toBe(400);
    expect((await as.ana.post(`/api/records/${rec.ana}/amend`, { reason: 'Re-read notes', question: { id: q, score: 3 } })).body.error.message).toBe('Nothing has changed.');
    // A 4 needs a note, even when amending.
    const four = await as.ana.post(`/api/records/${rec.ana}/amend`, { reason: 'Re-read notes', question: { id: q, score: 4 } });
    expect(four.status).toBe(400);
    expect(four.body.error.details).toEqual(['Question 3 is scored 4 and needs a note of what the candidate said.']);
    const ok = await as.ana.post(`/api/records/${rec.ana}/amend`, { reason: 'Re-read my notes', question: { id: q, score: 4, notes: [{ atSec: 300, text: 'Gave numbers for the outcome' }] } });
    expect(ok.status).toBe(200);
    expect((ok.body as RecordDetail).answers.find((x) => x.questionId === q)!.score).toBe(4);
    const [entry] = await audit('record.amended', rec.ana);
    expect(entry).toMatchObject({ actor_id: ids.ana, reason: 'Re-read my notes', before: { question: q, score: 3, notes: [] }, after: { question: q, score: 4, notes: ['Gave numbers for the outcome'] } });
    const overall = await as.ana.post(`/api/records/${rec.ana}/amend`, { reason: 'Talked it over', overall: { recommendation: 'strong_hire' } });
    expect(overall.body.overall.recommendation).toBe('strong_hire');
    expect((await audit('record.amended', rec.ana))[0]).toMatchObject({ before: { recommendation: 'hire' }, after: { recommendation: 'strong_hire' } });
    // Not the owner: refused, whoever it is.
    for (const c of [as.olive, as.admin, as.ivy]) expect((await c.post(`/api/records/${rec.ana}/amend`, { reason: 'x', overall: { rating: 1 } })).status).toBe(403);
  });

  it('ROUND-5 AUD-4: in a closed round an interviewer can no longer change anything, while an organiser can still amend their own submitted record with a reason', async () => {
    const r = await as.olive.post('/api/rounds', { name: 'Closing live round', trackId: 'qa' });
    const round = r.body.id as string;
    await as.olive.put(`/api/rounds/${round}/members/${ids.ana}`, { role: 'interviewer' });
    const id = await plan(['olive', 'ana'], {}, round);
    const olive = (await as.olive.post(`/api/interviews/${id}/start`, { consent: true })).body.state.me.recordId as string;
    const ana = (await as.ana.post(`/api/interviews/${id}/join`, {})).body.recordId as string;
    const set = await setOf(id);
    for (const [c, rid] of [[as.olive, olive], [as.ana, ana]] as const) {
      await complete(c, rid, set);
      await c.post(`/api/records/${rid}/submit`);
    }
    await as.olive.post(`/api/rounds/${round}/close`, {});
    expect((await as.ana.post(`/api/records/${ana}/amend`, { reason: 'x', overall: { rating: 2 } })).status).toBe(403);
    expect((await as.olive.post(`/api/records/${olive}/amend`, { reason: 'Correction after the round closed', overall: { rating: 2 } })).status).toBe(200);
    expect((await as.ana.get(`/api/records/${ana}`)).status).toBe(200); // reading still works
  });
});

describe('scorecards (FLOW-24, FLOW-31, FLOW-32)', () => {
  it('FLOW-24 FLOW-32: a scorecard comes with the interview, its questions and the time per question; exports are recorded in the audit log', async () => {
    const { rec, set } = await running(['ana']);
    await complete(as.ana, rec.ana, set);
    await as.ana.post(`/api/records/${rec.ana}/submit`);
    const sc: ScorecardData = (await as.ana.get(`/api/records/${rec.ana}`)).body;
    expect(sc).toMatchObject({ mine: true, record: { state: 'submitted', names: ['Ana'] }, interview: { set: { id: set.id } } });
    expect(Object.keys(sc.elapsedSec)).toContain(set.questions[0].id);
    for (const format of ['markdown', 'csv', 'print']) expect((await as.ana.post(`/api/records/${rec.ana}/exported`, { format })).status).toBe(204);
    expect((await as.ana.post(`/api/records/${rec.ana}/exported`, { format: 'pdf' })).status).toBe(400);
    expect((await audit('scorecard.exported', rec.ana)).map((e) => (e.after as { format: string }).format).sort()).toEqual(['csv', 'markdown', 'print']);
    // Another member of the round sees a submitted scorecard (the round does not hide scores); outsiders do not.
    expect((await as.ivy.get(`/api/records/${rec.ana}`)).body.mine).toBe(false);
    expect((await as.oscar.get(`/api/records/${rec.ana}`)).status).toBe(404);
    expect((await as.rita.get(`/api/records/${rec.ana}`)).status).toBe(404);
  });

  it('FLOW-24 LIVE-1: a draft record is not anyone else’s scorecard', async () => {
    const { rec } = await running();
    expect((await as.ana.get(`/api/records/${rec.ana}`)).status).toBe(200);
    expect((await as.ben.get(`/api/records/${rec.ana}`)).status).toBe(404);
  });
});

describe('route protection for interviewing (AUTH-5, ROUND-2, REVIEW-1)', () => {
  it('ROUND-2 AUTH-5 REVIEW-1 HPRIV-1: every interview and record route answers people off the round, and question reviewers, with "not found"; interviewers cannot mark panel members', async () => {
    const { id, rec } = await running();
    const routes = a.routes.filter((r) => r.url.startsWith('/api/records') || /^\/api\/interviews\/:id\/(live|records|present|start|join|command|presence|panel)/.test(r.url));
    expect(routes.length).toBe(13);
    const fill = (url: string) => url.replace(':userId', ids.ben).replace(':id', url.startsWith('/api/records') ? rec.ana : id);
    const wrong: string[] = [];
    for (const r of routes) {
      for (const [who, c] of [['organiser not on it', as.oscar], ['reviewer', as.rita]] as const) {
        const res = r.method === 'GET' ? await c.get(fill(r.url)) : r.method === 'PUT' ? await c.put(fill(r.url), {}) : await c.post(fill(r.url), {});
        if (res.status !== 404 || res.body?.error?.message !== 'That was not found.') wrong.push(`${who} ${r.method} ${r.url} → ${res.status}`);
      }
      // An interviewer on the round reaches everything but planning (marking panel members).
      const res = r.method === 'GET' ? await as.ivy.get(fill(r.url)) : r.method === 'PUT' ? await as.ivy.put(fill(r.url), {}) : await as.ivy.post(fill(r.url), {});
      const refusedByPolicy = res.status === 403 && res.body?.error?.message === 'You do not have permission to do that.';
      if (refusedByPolicy !== (r.access === 'round:round.plan')) wrong.push(`interviewer ${r.method} ${r.url} → ${res.status} ${res.body?.error?.message ?? ''}`);
    }
    expect(wrong).toEqual([]);
    // Ids that do not exist, or are malformed, are "not found" too.
    expect((await as.ana.get('/api/records/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await as.ana.get('/api/interviews/not-a-uuid/live')).status).toBe(404);
  });

  it('LIVE-3 RES-1: presence and autosave are rate limited per person, so people sharing one office address do not throttle each other', async () => {
    const { id } = await running();
    const beats = await Promise.all(Array.from({ length: 31 }, () => as.ana.post(`/api/interviews/${id}/presence`, { here: true })));
    // 30 a minute per person (Ana's earlier heartbeats in this file count too).
    expect(beats.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(beats.filter((r) => r.status === 204).length).toBeLessThanOrEqual(30);
    expect(beats.find((r) => r.status === 429)!.body.error.code).toBe('rate_limited');
    // Ben, from the same address, is not affected.
    expect((await as.ben.post(`/api/interviews/${id}/presence`, { here: true })).status).toBe(204);
  });

  it('ROUND-2 AUTH-5: ids from another round are refused (no IDOR)', async () => {
    const r = await as.admin.post('/api/rounds', { name: 'Other round', trackId: 'qa' });
    await as.admin.put(`/api/rounds/${r.body.id}/members/${ids.oscar}`, { role: 'organiser' });
    const other = (await as.admin.post(`/api/rounds/${r.body.id}/interviews`, { candidate: { name: 'Elsewhere' }, panel: [ids.oscar] })).body.id as string;
    const otherRec = (await as.oscar.post(`/api/interviews/${other}/start`, { consent: true })).body.state.me.recordId as string;
    for (const url of [`/api/interviews/${other}/live`, `/api/interviews/${other}/records`, `/api/records/${otherRec}`]) expect((await as.ana.get(url)).status).toBe(404);
    expect((await ops(as.ana, otherRec, [{ t: 'flag', q: 'qa-1', on: true }])).status).toBe(404);
  });
});
