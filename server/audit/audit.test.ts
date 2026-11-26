// HPRIV-4, AUD-3: reading, filtering and exporting the audit log; nothing can change it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, signIn, startApp, type TestApp, type TestDb } from '../test/harness';

let t: TestDb;
let a: TestApp;
let admin: ReturnType<typeof client>;

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t);
  await addUser(t.db, 'ada@example.test', 'admin', { name: 'Ada' });
  admin = client(a.app, await signIn(a.app, 'ada@example.test'));
  await admin.post('/api/users', { text: 'p1@example.test\np2@example.test\np3@example.test', role: 'interviewer' });
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

describe('audit log', () => {
  it('AUD-3 HPRIV-4: administrators read the log newest first, filtered by action, date and text, a page at a time', async () => {
    const all = await admin.get('/api/audit');
    expect(all.body.items[0].action).toBe('user.added');
    expect(all.body.items.map((e: { id: number }) => e.id)).toEqual([...all.body.items.map((e: { id: number }) => e.id)].sort((x, y) => y - x));
    const added = await admin.get('/api/audit?action=user.added');
    expect(added.body.items).toHaveLength(3);
    const text = await admin.get('/api/audit?q=p2%40example');
    expect(text.body.items).toHaveLength(1);
    expect(text.body.items[0]).toMatchObject({ actor: 'Ada <ada@example.test>', entity: 'user', after: { email: 'p2@example.test', role: 'interviewer' } });
    const future = await admin.get(`/api/audit?from=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    expect(future.body.items).toEqual([]);
    const page1 = await admin.get('/api/audit?limit=2');
    expect(page1.body.items).toHaveLength(2);
    const page2 = await admin.get(`/api/audit?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items[0].id).toBeLessThan(page1.body.items[1].id);
  });

  it('AUD-3 HPRIV-4: the export is CSV with the same filters, and is itself recorded', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/api/audit/export?action=user.added', headers: { cookie: (await signIn(a.app, 'ada@example.test')) } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.body.trim().split(/\r?\n/);
    expect(lines[0]).toBe('Id,Time,Actor,Action,Entity,Entity id,Before,After,Reason');
    expect(lines).toHaveLength(4);
    expect((await admin.get('/api/audit?action=audit.exported')).body.items).toHaveLength(1);
  });

  it('HPRIV-4 USER-2: organisers and interviewers cannot read the whole log; no route changes or deletes entries', async () => {
    await addUser(t.db, 'org@example.test', 'organiser');
    const org = client(a.app, await signIn(a.app, 'org@example.test'));
    expect((await org.get('/api/audit')).status).toBe(403);
    expect((await org.get('/api/audit/export')).status).toBe(403);
    const id = (await admin.get('/api/audit')).body.items[0].id;
    expect((await admin.del(`/api/audit/${id}`)).status).toBe(404);
    expect((await admin.patch(`/api/audit/${id}`, { reason: 'x' })).status).toBe(404);
    expect(a.routes.filter((r) => r.url.startsWith('/api/audit') && r.method !== 'GET')).toEqual([]);
  });
});
