// DB-1, DB-4, BANK-1, BANK-2, BANK-5, BANK-7…BANK-15, RUB-1…RUB-6: the question bank in the database.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, seedBank, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { draftFromQuestion } from '../../src/domain/bankEdit';
import { parseBulkQuestions } from '../../src/domain/bankCsv';
import type { Question } from '../../src/domain/types';

let t: TestDb;
let a: TestApp;
let org: ReturnType<typeof client>;
let viewer: ReturnType<typeof client>;
const seed = (id: string) => JSON.parse(readFileSync(`seed/${id}.json`, 'utf8'));

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t);
  await seedBank(t.db);
  await addUser(t.db, 'olive@example.test', 'organiser', { name: 'Olive' });
  await addUser(t.db, 'ian@example.test', 'interviewer');
  org = client(a.app, await signIn(a.app, 'olive@example.test'));
  viewer = client(a.app, await signIn(a.app, 'ian@example.test'));
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

const question = async (id: string): Promise<Question> => {
  const bank = (await viewer.get(`/api/bank/tracks/${id.replace(/-\d+$/, '')}`)).body;
  return bank.questions.find((q: Question) => q.id === id);
};

describe('reading the bank', () => {
  it('DB-1 BANK-1 BANK-8 OV-2 HOST-1: the four bundled tracks are in the database, 207 questions, every field present', async () => {
    const r = await viewer.get('/api/bank/tracks');
    expect(r.body.map((x: { id: string }) => x.id)).toEqual(['aks', 'edge', 'qa', 'web']);
    expect(r.body.reduce((n: number, x: { questions: number }) => n + x.questions, 0)).toBe(207);
    const qa = (await viewer.get('/api/bank/tracks/qa')).body;
    expect(qa.questions).toHaveLength(50);
    for (const q of qa.questions) {
      expect(q.text && q.description && q.categoryId && q.difficulty && q.type).toBeTruthy();
      expect(q.lookFor.length).toBeGreaterThan(0);
      expect(q.redFlags.length).toBeGreaterThan(0);
      expect(q.probes.length).toBeGreaterThan(0);
      expect(q.timeMin).toBeGreaterThan(0);
    }
  });

  it('BANK-2 BANK-15 RUB-2 RUB-6: a track comes back exactly as its seed file: order, categories, lists, rubric overrides, tags', async () => {
    const qa = (await viewer.get('/api/bank/tracks/qa')).body;
    const file = seed('qa');
    expect(qa.categories.map((c: { id: string }) => c.id)).toEqual(file.categories.map((c: { id: string }) => c.id));
    expect(qa.questions.map((q: Question) => ({ ...q, trackId: undefined }))).toEqual(file.questions.map((q: Question) => ({ ...q, trackId: undefined, rubricOverride: q.rubricOverride ?? null })));
  });

  it('DB-1 USER-2: interviewers read the bank but cannot change it', async () => {
    const q = await question('qa-1');
    expect((await viewer.put('/api/bank/questions/qa-1', { draft: draftFromQuestion(q) })).status).toBe(403);
    expect((await viewer.patch('/api/bank/questions/qa-1/status', { status: 'retired' })).status).toBe(403);
    expect((await viewer.post('/api/bank/tracks/qa/categories', { name: 'X' })).status).toBe(403);
    expect((await viewer.post('/api/bank/tracks/qa/export', {})).status).toBe(403);
  });

  it('BANK-2: an unknown track or question is "not found"', async () => {
    expect((await viewer.get('/api/bank/tracks/nope')).status).toBe(404);
    expect((await viewer.get("/api/bank/tracks/qa';DROP TABLE users;--")).status).toBe(400);
    expect((await viewer.get('/api/bank/questions/qa-9999/versions')).status).toBe(404);
  });
});

describe('editing the bank', () => {
  it('BANK-9 BANK-11 DB-1: editing the text raises the version by one, keeps the old version in the history, and is audited with before and after', async () => {
    const q = await question('qa-1');
    const r = await org.put('/api/bank/questions/qa-1', { draft: { ...draftFromQuestion(q), text: `${q.text} (edited)` } });
    expect(r.body).toEqual({ id: 'qa-1', number: 1, version: q.version + 1, bumped: true, changed: true });
    const versions = (await viewer.get('/api/bank/questions/qa-1/versions')).body;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([q.version + 1, q.version]);
    expect(versions[1].question.text).toBe(q.text);
    const audit = await t.db.selectFrom('audit_events').selectAll().where('entity_id', '=', 'qa-1').where('action', '=', 'bank.question_edited').executeTakeFirstOrThrow();
    expect(audit.before).toEqual({ text: q.text, version: q.version });
    expect(audit.after).toEqual({ text: `${q.text} (edited)`, version: q.version + 1 });
    expect(audit.actor_label).toBe('Olive <olive@example.test>');
  });

  it('BANK-11: changing only the category or time estimate saves without a new version; saving with no change writes nothing', async () => {
    const q = await question('qa-2');
    const r = await org.put('/api/bank/questions/qa-2', { draft: { ...draftFromQuestion(q), timeMin: q.timeMin + 1 } });
    expect(r.body).toMatchObject({ version: q.version, bumped: false, changed: true });
    const before = await t.db.selectFrom('audit_events').select('id').execute();
    const same = await org.put('/api/bank/questions/qa-2', { draft: { ...draftFromQuestion(q), timeMin: q.timeMin + 1, text: `  ${q.text} ` } });
    expect(same.body).toMatchObject({ changed: false });
    expect(await t.db.selectFrom('audit_events').select('id').execute()).toHaveLength(before.length);
  });

  it('BANK-9 BANK-10 BANK-5: a new question gets the next number, never a reused one; the form problems come back by field', async () => {
    const q = await question('qa-3');
    const bad = await org.post('/api/bank/tracks/qa/questions', { draft: { ...draftFromQuestion(q), text: '', probes: [] } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(['text', 'probes']));
    const r = await org.post('/api/bank/tracks/qa/questions', { draft: { ...draftFromQuestion(q), text: 'A brand new question?' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'qa-51', number: 51, version: 1 });
  });

  it('BANK-9 BANK-12: a question can be saved with a new category created at the same time', async () => {
    const q = await question('qa-3');
    const r = await org.post('/api/bank/tracks/qa/questions', { draft: { ...draftFromQuestion(q), text: 'Another new one?', categoryId: '' }, newCategory: { name: 'Exploratory testing' } });
    expect(r.status).toBe(201);
    const bank = (await viewer.get('/api/bank/tracks/qa')).body;
    expect(bank.categories.at(-1)).toMatchObject({ id: 'qa-exploratory-testing', name: 'Exploratory testing', weight: 1, mustHave: false });
    expect(bank.questions.find((x: Question) => x.id === r.body.id).categoryId).toBe('qa-exploratory-testing');
  });

  it('BANK-10: retiring and restoring keeps the version and is audited', async () => {
    const q = await question('qa-4');
    expect((await org.patch('/api/bank/questions/qa-4/status', { status: 'retired' })).status).toBe(204);
    expect(await question('qa-4')).toMatchObject({ status: 'retired', version: q.version });
    await org.patch('/api/bank/questions/qa-4/status', { status: 'active' });
    const actions = await t.db.selectFrom('audit_events').select('action').where('entity_id', '=', 'qa-4').orderBy('id').execute();
    expect(actions.map((x) => x.action)).toEqual(['bank.question_retired', 'bank.question_restored']);
  });

  it('BANK-12: categories are renamed without changing their id; one in use cannot be removed; an unused one can', async () => {
    const r = await org.patch('/api/bank/categories/qa-performance', { name: 'Performance & load', weight: 1.5, mustHave: true });
    expect(r.status).toBe(204);
    const bank = (await viewer.get('/api/bank/tracks/qa')).body;
    expect(bank.categories.find((c: { id: string }) => c.id === 'qa-performance')).toMatchObject({ name: 'Performance & load', weight: 1.5, mustHave: true });
    const inUse = await org.del('/api/bank/categories/qa-performance');
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toMatch(/still has \d+ questions/);
    const added = await org.post('/api/bank/tracks/qa/categories', { name: 'Empty one' });
    expect((await org.del(`/api/bank/categories/${added.body.id}`)).status).toBe(204);
    expect((await org.post('/api/bank/tracks/qa/categories', { name: 'Performance & load' })).status).toBe(400);
    expect((await org.patch('/api/bank/categories/qa-performance', { weight: 99 })).status).toBe(400);
  });

  it('BANK-12: a new track can be created with its first category; ids and names must be new', async () => {
    expect((await org.post('/api/bank/tracks/check', { id: 'qa', name: 'Senior QA Engineer' })).body).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    const r = await org.post('/api/bank/tracks', { id: 'data', name: 'Data Engineer', firstCategory: { name: 'Pipelines' } });
    expect(r.status).toBe(201);
    const bank = (await viewer.get('/api/bank/tracks/data')).body;
    expect(bank.categories).toEqual([{ id: 'data-pipelines', trackId: 'data', name: 'Pipelines', weight: 1, mustHave: false }]);
    expect(bank.changedAt).not.toBeNull();
  });

  it('BANK-13: many questions are added at once from parsed CSV rows, all or nothing, with new categories', async () => {
    const qa = (await viewer.get('/api/bank/tracks/qa')).body;
    const csv = 'Question,Description,Category,Difficulty,Type,Key points,Red flags,Probes,Time (min)\n"How do you test a queue?","About queues.","Messaging",advanced,knowledge,"A;B","C","D?",\n"How do you test search?","About search.","Strategy & risk",core,knowledge,"A;B","C","D?",4\n';
    const parsed = parseBulkQuestions(csv, 'qa', qa.categories);
    expect(parsed.rows.every((r) => !r.problems.length)).toBe(true);
    const r = await org.post('/api/bank/tracks/qa/questions/bulk', { drafts: parsed.rows.map((x) => x.draft), newCategories: parsed.newCategories.map((name) => ({ id: `qa-${name.toLowerCase()}`, name })) });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ids: ['qa-53', 'qa-54'], categories: ['Messaging'] });
    const bad = await org.post('/api/bank/tracks/qa/questions/bulk', { drafts: [{ ...parsed.rows[0].draft, text: 'ok?' }, { ...parsed.rows[0].draft, text: '' }], newCategories: [] });
    expect(bad.status).toBe(400);
    expect((await viewer.get('/api/bank/tracks/qa')).body.questions.find((q: Question) => q.text === 'ok?')).toBeUndefined();
  });

  it('BANK-14: changes mark the track as not yet exported; exporting with a new version clears the mark (DB-4)', async () => {
    let qa = (await viewer.get('/api/bank/tracks')).body.find((x: { id: string }) => x.id === 'qa');
    expect(qa.changedAt).not.toBeNull();
    const r = await org.post('/api/bank/tracks/qa/export', { version: '2099.01' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fileName: 'qa.json', version: '2099.01' });
    const file = JSON.parse(r.body.text);
    expect(file.track.version).toBe('2099.01');
    expect(file.questions.find((q: Question) => q.id === 'qa-1').version).toBe((await question('qa-1')).version);
    expect(file.questions.find((q: Question) => q.id === 'qa-1').text).toMatch(/\(edited\)$/);
    qa = (await viewer.get('/api/bank/tracks')).body.find((x: { id: string }) => x.id === 'qa');
    expect(qa).toMatchObject({ changedAt: null, version: '2099.01' });
    expect((await org.post('/api/bank/tracks/qa/export', { version: '2001.01' })).status).toBe(400);
  });

  it('DB-4 BANK-7 BANK-4: an untouched track exports as a file identical to its seed file; CSV export works for interviewers too', async () => {
    const r = await org.post('/api/bank/tracks/edge/export', {});
    expect(JSON.parse(r.body.text)).toEqual(seed('edge'));
    const csv = await viewer.post('/api/bank/tracks/edge/export-csv');
    expect(csv.status).toBe(200);
    expect(csv.body.text.split('\n')[0]).toMatch(/^Question,Description,Category/);
    const back = parseBulkQuestions(csv.body.text, 'edge', seed('edge').categories);
    expect(back.rows).toHaveLength(seed('edge').questions.length);
  });

  it('BANK-9 RUB-2 RUB-5: per-level rubric texts and behavioural questions are saved like the local app saves them', async () => {
    const q = await question('web-1');
    const r = await org.put('/api/bank/questions/web-1', { draft: { ...draftFromQuestion(q), rubricOverride: { '4': 'Names the failure modes.' } } });
    expect(r.body.bumped).toBe(true);
    expect((await question('web-1')).rubricOverride).toEqual({ '4': 'Names the failure modes.' });
    const b = await org.post('/api/bank/tracks/web/questions', { draft: { ...draftFromQuestion(q), text: 'Tell us about a hard call.', type: 'behavioural', difficulty: 'expert', rubricOverride: null } });
    expect((await question(b.body.id)).difficulty).toBe('core');
  });

  it('BANK-10: two people adding questions to one track at the same moment get different numbers', async () => {
    const q = await question('aks-1');
    const second = client(a.app, await signIn(a.app, 'olive@example.test'));
    const [r1, r2] = await Promise.all([
      org.post('/api/bank/tracks/aks/questions', { draft: { ...draftFromQuestion(q), text: 'Parallel one?' } }),
      second.post('/api/bank/tracks/aks/questions', { draft: { ...draftFromQuestion(q), text: 'Parallel two?' } }),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(new Set([r1.body.number, r2.body.number]).size).toBe(2);
  });
});
