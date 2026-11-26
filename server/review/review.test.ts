// REVIEW-1 to REVIEW-7: proposals, comments, "looks good" and review requests, against PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { addUser, client, createTestDb, seedBank, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { draftFromQuestion } from '../../src/domain/bankEdit';
import type { Question } from '../../src/domain/types';

let t: TestDb;
let a: TestApp;
let org: ReturnType<typeof client>;
let rita: ReturnType<typeof client>;
let remy: ReturnType<typeof client>;
let ritaId: string;
let remyId: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t);
  await seedBank(t.db);
  await addUser(t.db, 'olive@example.test', 'organiser', { name: 'Olive' });
  ritaId = await addUser(t.db, 'rita@example.test', 'reviewer', { name: 'Rita' });
  remyId = await addUser(t.db, 'remy@example.test', 'reviewer', { name: 'Remy' });
  org = client(a.app, await signIn(a.app, 'olive@example.test'));
  rita = client(a.app, await signIn(a.app, 'rita@example.test'));
  remy = client(a.app, await signIn(a.app, 'remy@example.test'));
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

const question = async (id: string): Promise<Question> => (await org.get(`/api/bank/tracks/${id.replace(/-\d+$/, '')}`)).body.questions.find((q: Question) => q.id === id);

describe('what a reviewer sees', () => {
  it('REVIEW-1: the bank a reviewer reads carries the questions only: no usage, scores or interview data', async () => {
    const tracks = (await rita.get('/api/bank/tracks')).body;
    expect(Object.keys(tracks[0]).sort()).toEqual(['active', 'categories', 'changedAt', 'exportedAt', 'id', 'name', 'questions', 'version']);
    const bank = (await rita.get('/api/bank/tracks/qa')).body;
    expect(Object.keys(bank).sort()).toEqual(['categories', 'changedAt', 'questions', 'track']);
    expect(Object.keys(bank.questions[0]).sort()).toEqual(
      ['categoryId', 'description', 'difficulty', 'id', 'lookFor', 'number', 'probes', 'redFlags', 'rubricOverride', 'status', 'text', 'timeMin', 'trackId', 'type', 'version'].sort(),
    );
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(bank);
    walk(tracks);
    expect([...keys].filter((k) => /score|interview|round|candidate|used|usage|session|plan/i.test(k))).toEqual([]);
  });

  it('REVIEW-1 USER-2: a reviewer cannot edit the bank directly, decide proposals or ask for reviews', async () => {
    const q = await question('qa-1');
    expect((await rita.put('/api/bank/questions/qa-1', { draft: draftFromQuestion(q) })).status).toBe(403);
    expect((await rita.post('/api/reviews', { trackId: 'qa', scope: 'track', reviewerIds: [ritaId] })).status).toBe(403);
    expect((await rita.get('/api/reviews')).status).toBe(403);
    expect((await rita.post('/api/bank/import', { files: [], dryRun: true })).status).toBe(403);
  });
});

describe('proposals', () => {
  let changeId = '';
  it('REVIEW-2: a reviewer proposes a change with a reason; the bank does not change until it is accepted', async () => {
    const q = await question('qa-2');
    const before = JSON.stringify(q);
    const bad = await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-2', baseVersion: q.version, draft: { ...draftFromQuestion(q), text: '' }, reason: 'Clearer' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.text).toBeTruthy();
    const same = await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-2', baseVersion: q.version, draft: draftFromQuestion(q), reason: 'No change' });
    expect(same.status).toBe(400);
    const r = await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-2', baseVersion: q.version, draft: { ...draftFromQuestion(q), text: `${q.text} Explain your choice.` }, reason: 'Asks for the reasoning.' });
    expect(r.status).toBe(201);
    changeId = r.body.id;
    expect(JSON.stringify(await question('qa-2'))).toBe(before);
    const mine = (await rita.get('/api/proposals?status=all')).body;
    expect(mine).toEqual([expect.objectContaining({ id: changeId, status: 'open', kind: 'change', questionNumber: 2, outOfDate: false, reason: 'Asks for the reasoning.' })]);
  });

  it('REVIEW-1 REVIEW-2: reviewers see only their own proposals', async () => {
    expect((await remy.get('/api/proposals?status=all')).body).toEqual([]);
    expect((await remy.get(`/api/proposals/${changeId}`)).status).toBe(404);
    expect((await remy.post(`/api/proposals/${changeId}/withdraw`)).status).toBe(404);
    expect((await org.get('/api/proposals')).body.map((p: { id: string }) => p.id)).toContain(changeId);
  });

  it('REVIEW-5 BANK-11 FLOW-8: accepting applies it like an edit (version up, audited with proposer and accepter) and leaves fixed question sets alone', async () => {
    const q = await question('qa-2');
    // A question set already fixed for an interview holds its own snapshot of the question.
    const r = await t.db.insertInto('rounds').values({ name: 'R', track_id: 'qa', retention_until: '2027-12-31' }).returning('id').executeTakeFirstOrThrow();
    await sql`INSERT INTO question_sets (round_id, track_id, track_version, name, questions, categories, time_budget_min, fingerprint)
      VALUES (${r.id}, 'qa', '2026.11', 'set', ${JSON.stringify([q])}::jsonb, '[]'::jsonb, 60, ${'a'.repeat(64)})`.execute(t.db);
    const detail = (await org.get(`/api/proposals/${changeId}`)).body;
    expect(detail.current.text).toBe(q.text);
    expect(detail.proposed.text).toBe(`${q.text} Explain your choice.`);
    const acc = await org.post(`/api/proposals/${changeId}/accept`, {});
    expect(acc.body).toMatchObject({ status: 'accepted', questionId: 'qa-2', version: q.version + 1, bumped: true });
    expect((await question('qa-2')).text).toBe(`${q.text} Explain your choice.`);
    const set = await sql<{ questions: Question[] }>`SELECT questions FROM question_sets WHERE round_id = ${r.id}`.execute(t.db);
    expect(set.rows[0].questions[0].text).toBe(q.text);
    expect(set.rows[0].questions[0].version).toBe(q.version);
    const audit = await t.db.selectFrom('audit_events').selectAll().where('entity_id', '=', 'qa-2').where('action', '=', 'bank.question_edited').executeTakeFirstOrThrow();
    expect(audit.actor_label).toBe('Olive <olive@example.test>');
    expect(audit.reason).toBe('Proposal by Rita <rita@example.test>, accepted by Olive <olive@example.test>');
    expect((await rita.get(`/api/proposals/${changeId}`)).body).toMatchObject({ status: 'accepted', decidedBy: { name: 'Olive' }, resultVersion: q.version + 1 });
    expect((await org.post(`/api/proposals/${changeId}/accept`, {})).status).toBe(409);
  });

  it('REVIEW-5: accepting with edits applies the edited wording; declining needs a reason the proposer sees', async () => {
    const q = await question('qa-3');
    const p1 = (await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-3', baseVersion: q.version, draft: { ...draftFromQuestion(q), text: 'Draft wording?' }, reason: 'Shorter' })).body.id;
    const p2 = (await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-4', baseVersion: (await question('qa-4')).version, draft: { ...draftFromQuestion(await question('qa-4')), text: 'Something else?' }, reason: 'Different angle' })).body.id;
    const acc = await org.post(`/api/proposals/${p1}/accept`, { draft: { ...draftFromQuestion(q), text: 'Final wording?' }, note: 'Tightened it.' });
    expect(acc.body.status).toBe('accepted_with_edits');
    expect((await question('qa-3')).text).toBe('Final wording?');
    expect((await org.post(`/api/proposals/${p2}/decline`, {})).status).toBe(400);
    expect((await org.post(`/api/proposals/${p2}/decline`, { reason: 'We want to keep the scope.' })).status).toBe(204);
    const mine = (await rita.get('/api/proposals?status=decided')).body;
    expect(mine.find((x: { id: string }) => x.id === p1)).toMatchObject({ status: 'accepted_with_edits', decisionReason: 'Tightened it.' });
    expect(mine.find((x: { id: string }) => x.id === p2)).toMatchObject({ status: 'declined', decisionReason: 'We want to keep the scope.' });
  });

  it('REVIEW-6: a proposal written against an older version is out of date and is accepted only after it is checked against the current wording', async () => {
    const q = await question('qa-5');
    const p = (await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-5', baseVersion: q.version, draft: { ...draftFromQuestion(q), probes: [...q.probes, 'And then?'] }, reason: 'Another probe' })).body.id;
    await org.put('/api/bank/questions/qa-5', { draft: { ...draftFromQuestion(q), text: `${q.text} (edited meanwhile)` } });
    const detail = (await org.get(`/api/proposals/${p}`)).body;
    expect(detail).toMatchObject({ outOfDate: true, baseVersion: q.version, currentVersion: q.version + 1 });
    expect(detail.base.text).toBe(q.text);
    expect(detail.current.text).toBe(`${q.text} (edited meanwhile)`);
    const refused = await org.post(`/api/proposals/${p}/accept`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual(['out-of-date']);
    // The organiser merges it with the current wording and accepts.
    const merged = { ...draftFromQuestion(detail.current), probes: detail.proposed.probes };
    const ok = await org.post(`/api/proposals/${p}/accept`, { draft: merged, confirmOutOfDate: true });
    expect(ok.body).toMatchObject({ status: 'accepted_with_edits', version: q.version + 2 });
    expect((await question('qa-5')).text).toBe(`${q.text} (edited meanwhile)`);
  });

  it('REVIEW-3: a reviewer proposes new questions, one with a suggested new category, and several at once; accepting creates them', async () => {
    const q = await question('qa-6');
    const one = await rita.post('/api/proposals', { kind: 'new', trackId: 'qa', draft: { ...draftFromQuestion(q), text: 'How do you test accessibility?', categoryId: '' }, newCategory: { name: 'Accessibility' }, reason: 'Missing topic' });
    expect(one.status).toBe(201);
    const bulk = await rita.post('/api/proposals/bulk', {
      trackId: 'qa',
      drafts: [
        { ...draftFromQuestion(q), text: 'Bulk one?' },
        { ...draftFromQuestion(q), text: 'Bulk two?', categoryId: 'qa-security' },
      ],
      newCategories: [{ id: 'qa-security', name: 'Security testing' }],
      reason: 'From our workshop',
    });
    expect(bulk.status).toBe(201);
    expect(bulk.body.ids).toHaveLength(2);
    const before = (await org.get('/api/bank/tracks/qa')).body.questions.length;
    const acc = await org.post(`/api/proposals/${one.body.id}/accept`, {});
    expect(acc.body).toMatchObject({ status: 'accepted', version: 1 });
    const bank = (await org.get('/api/bank/tracks/qa')).body;
    expect(bank.questions).toHaveLength(before + 1);
    expect(bank.categories.map((c: { name: string }) => c.name)).toContain('Accessibility');
    const two = (await org.get(`/api/proposals/${bulk.body.ids[1]}`)).body;
    expect(two.newCategoryName).toBe('Security testing');
  });

  it('REVIEW-2: a reviewer withdraws an open proposal of their own', async () => {
    const q = await question('qa-7');
    const p = (await rita.post('/api/proposals', { kind: 'change', questionId: 'qa-7', baseVersion: q.version, draft: { ...draftFromQuestion(q), timeMin: q.timeMin + 2 }, reason: 'Needs longer' })).body.id;
    expect((await rita.post(`/api/proposals/${p}/withdraw`)).status).toBe(204);
    expect((await rita.post(`/api/proposals/${p}/withdraw`)).status).toBe(409);
    expect((await org.post(`/api/proposals/${p}/accept`, {})).status).toBe(409);
  });
});

describe('comments and "looks good"', () => {
  it('REVIEW-4: reviewers and organisers comment; comments and marks are visible to reviewers, organisers and administrators, not interviewers', async () => {
    expect((await rita.post('/api/bank/questions/qa-8/comments', { text: '  ' })).status).toBe(400);
    expect((await rita.post('/api/bank/questions/qa-8/comments', { text: 'Is "flaky" defined?' })).status).toBe(201);
    expect((await org.post('/api/bank/questions/qa-8/comments', { text: 'Good point.' })).status).toBe(201);
    expect((await remy.put('/api/bank/questions/qa-8/looks-good', { value: true })).status).toBe(204);
    const fb = (await remy.get('/api/bank/questions/qa-8/feedback')).body;
    expect(fb.comments.map((c: { author: string; text: string }) => [c.author, c.text])).toEqual([
      ['Rita', 'Is "flaky" defined?'],
      ['Olive', 'Good point.'],
    ]);
    expect(fb.looksGood).toEqual([expect.objectContaining({ name: 'Remy', mine: true })]);
    await addUser(t.db, 'ian@example.test', 'interviewer');
    const ian = client(a.app, await signIn(a.app, 'ian@example.test'));
    expect((await ian.get('/api/bank/questions/qa-8/feedback')).status).toBe(403);
    await remy.put('/api/bank/questions/qa-8/looks-good', { value: false });
    expect((await remy.get('/api/bank/questions/qa-8/feedback')).body.looksGood).toEqual([]);
  });
});

describe('review requests', () => {
  let requestId = '';
  it('REVIEW-7: an organiser asks two reviewers to review a category, with a note and a due date', async () => {
    expect((await org.get('/api/reviews/reviewers')).body.map((r: { email: string }) => r.email)).toEqual(['remy@example.test', 'rita@example.test']);
    const ian = (await t.db.selectFrom('users').select('id').where('email', '=', 'ian@example.test').executeTakeFirstOrThrow()).id;
    expect((await org.post('/api/reviews', { trackId: 'qa', scope: 'category', categoryId: 'qa-performance', reviewerIds: [ian], note: '' })).status).toBe(400);
    const r = await org.post('/api/reviews', { trackId: 'qa', scope: 'category', categoryId: 'qa-performance', reviewerIds: [ritaId, remyId], note: 'Please check the numbers.', dueDate: '2026-12-15' });
    expect(r.status).toBe(201);
    requestId = r.body.id;
    const list = (await org.get('/api/reviews')).body;
    expect(list[0]).toMatchObject({ id: requestId, scopeLabel: 'Performance', note: 'Please check the numbers.', dueDate: '2026-12-15', reviewers: [expect.objectContaining({ name: 'Remy', done: 0 }), expect.objectContaining({ name: 'Rita', done: 0 })] });
    expect(list[0].total).toBeGreaterThan(2);
  });

  it('REVIEW-7: each reviewer sees their list and works through it; every action counts as progress; the organiser sees it', async () => {
    const mine = (await rita.get('/api/my-reviews')).body;
    expect(mine).toEqual([expect.objectContaining({ id: requestId, done: 0, requestedBy: 'Olive' })]);
    const detail = (await rita.get(`/api/my-reviews/${requestId}`)).body;
    const [q1, q2, q3] = detail.items.map((i: { questionId: string }) => i.questionId);
    expect((await rita.get('/api/review-counts')).body.openReviewItems).toBe(detail.total);
    await rita.put(`/api/bank/questions/${q1}/looks-good`, { value: true, requestId });
    await rita.post(`/api/bank/questions/${q2}/comments`, { text: 'Which tool?', requestId });
    const q3q = await question(q3);
    await rita.post('/api/proposals', { kind: 'change', questionId: q3, baseVersion: q3q.version, draft: { ...draftFromQuestion(q3q), text: `${q3q.text} With numbers.` }, reason: 'Concrete', requestId });
    const after = (await rita.get(`/api/my-reviews/${requestId}`)).body;
    expect(after.done).toBe(3);
    expect(after.items.slice(0, 3).map((i: { outcome: string }) => i.outcome)).toEqual(['looks_good', 'commented', 'proposed']);
    expect((await rita.put(`/api/my-reviews/${requestId}/items/${detail.items[3].questionId}`, { done: true })).status).toBe(204);
    const org1 = (await org.get(`/api/reviews/${requestId}`)).body;
    expect(org1.reviewers.find((r: { name: string }) => r.name === 'Rita')).toMatchObject({ done: 4, proposals: 1, comments: 1 });
    expect(org1.reviewers.find((r: { name: string }) => r.name === 'Remy')).toMatchObject({ done: 0 });
    expect(org1.proposals).toEqual([expect.objectContaining({ questionId: q3, proposedBy: expect.objectContaining({ name: 'Rita' }) })]);
    expect((await org.get('/api/review-counts')).body.openProposals).toBeGreaterThan(0);
  });

  it('REVIEW-7 REVIEW-1: a reviewer cannot open or act on a request they are not on', async () => {
    const other = (await org.post('/api/reviews', { trackId: 'web', scope: 'track', reviewerIds: [remyId] })).body.id;
    expect((await rita.get(`/api/my-reviews/${other}`)).status).toBe(404);
    expect((await rita.put(`/api/bank/questions/web-1/looks-good`, { value: true, requestId: other })).status).toBe(404);
    expect((await rita.put(`/api/my-reviews/${other}/items/web-1`, { done: true })).status).toBe(404);
    expect((await rita.get('/api/my-reviews')).body.map((r: { id: string }) => r.id)).not.toContain(other);
    expect((await org.post(`/api/reviews/${other}/close`)).status).toBe(204);
    expect((await remy.put(`/api/my-reviews/${other}/items/web-1`, { done: true })).status).toBe(404); // closed
  });
});
