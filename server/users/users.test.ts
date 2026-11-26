// USER-1…USER-4: the Users page's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { previewInvites } from './routes';

let t: TestDb;
let a: TestApp;
let admin: ReturnType<typeof client>;
let adminId: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t);
  adminId = await addUser(t.db, 'ada@example.test', 'admin', { name: 'Ada Admin' });
  admin = client(a.app, await signIn(a.app, 'ada@example.test'));
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

const auditFor = (entityId: string) => t.db.selectFrom('audit_events').selectAll().where('entity_id', '=', entityId).orderBy('id').execute();

describe('Users page API', () => {
  it('USER-1: lists people with name, email, role, whether active, last sign-in and rounds', async () => {
    const r = await admin.get('/api/users');
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ email: 'ada@example.test', name: 'Ada Admin', role: 'admin', active: true, rounds: [] });
    expect(r.body.items[0].lastSignInAt).toMatch(/^\d{4}-/);
  });

  it('USER-1: pasting many emails shows a preview first: new, already there, repeated, not an email', async () => {
    const lines = await previewInvites(t.db, 'one@example.test, Two <TWO@example.test>\nada@example.test\none@example.test; not-an-email');
    expect(lines.map((l) => [l.email, l.outcome])).toEqual([
      ['one@example.test', 'add'],
      ['two@example.test', 'add'],
      ['ada@example.test', 'exists'],
      ['one@example.test', 'duplicate'],
      [null, 'invalid'],
    ]);
    const viaApi = await admin.post('/api/users/preview', { text: 'x@example.test y@example.test' });
    expect(viaApi.body.map((l: { outcome: string }) => l.outcome)).toEqual(['add', 'add']);
    expect((await admin.get('/api/users')).body.items).toHaveLength(1); // the preview added nobody
  });

  it('USER-1 USER-4 HPRIV-4: adds people by email with a role; each addition is audited (who, whom, when)', async () => {
    const r = await admin.post('/api/users', { text: 'one@example.test\ntwo@example.test\nada@example.test', role: 'interviewer' });
    expect(r.status).toBe(201);
    expect(r.body.added.map((u: { email: string }) => u.email)).toEqual(['one@example.test', 'two@example.test']);
    expect(r.body.skipped.map((l: { outcome: string }) => l.outcome)).toEqual(['exists']);
    const audit = await auditFor(r.body.added[0].id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'user.added', actor_id: adminId, actor_label: 'Ada Admin <ada@example.test>', after: { email: 'one@example.test', role: 'interviewer' } });
  });

  it('USER-1: rejects unknown fields and bad roles (no mass assignment)', async () => {
    expect((await admin.post('/api/users', { text: 'z@example.test', role: 'owner' })).status).toBe(400);
    expect((await admin.post('/api/users', { text: 'z@example.test', role: 'admin', active: false })).status).toBe(400);
    const one = (await admin.get('/api/users?q=one%40')).body.items[0];
    expect((await admin.patch(`/api/users/${one.id}`, { email: 'evil@example.test' })).status).toBe(400);
    expect((await admin.patch(`/api/users/${one.id}`, { google_sub: 'x' })).status).toBe(400);
  });

  it('USER-1 USER-4: changes a role, audited with before and after', async () => {
    const one = (await admin.get('/api/users?q=one%40')).body.items[0];
    const r = await admin.patch(`/api/users/${one.id}`, { role: 'organiser' });
    expect(r.body.role).toBe('organiser');
    const last = (await auditFor(one.id)).at(-1)!;
    expect(last).toMatchObject({ action: 'user.changed', before: { email: 'one@example.test', role: 'interviewer' }, after: { email: 'one@example.test', role: 'organiser' } });
  });

  it('USER-3 AUTH-4: deactivating someone ends their sessions at once; reactivating lets them back in', async () => {
    const id = await addUser(t.db, 'dee@example.test', 'organiser');
    const dee = client(a.app, await signIn(a.app, 'dee@example.test'));
    expect((await dee.get('/api/bank/tracks')).status).toBe(200);
    const r = await admin.patch(`/api/users/${id}`, { active: false });
    expect(r.body.active).toBe(false);
    expect((await dee.get('/api/bank/tracks')).status).toBe(401);
    expect(await t.db.selectFrom('auth_sessions').select('user_id').where('user_id', '=', id).execute()).toEqual([]);
    expect((await a.app.inject({ method: 'POST', url: '/api/auth/dev/sign-in', headers: { 'x-ia-request': '1' }, payload: { email: 'dee@example.test' } })).statusCode).toBe(403);
    await admin.patch(`/api/users/${id}`, { active: true });
    expect((await client(a.app, await signIn(a.app, 'dee@example.test')).get('/api/me')).status).toBe(200);
    expect((await auditFor(id)).map((x) => x.action)).toEqual(['auth.signed_in', 'user.deactivated', 'user.reactivated', 'auth.signed_in']);
  });

  it('USER-1 USER-3: only people who never signed in can be removed; others are deactivated instead', async () => {
    const never = (await admin.get('/api/users?q=two%40')).body.items[0];
    expect((await admin.del(`/api/users/${never.id}`)).status).toBe(204);
    expect((await admin.get('/api/users?q=two%40')).body.items).toEqual([]);
    expect((await auditFor(never.id)).at(-1)).toMatchObject({ action: 'user.removed', before: { email: 'two@example.test' } });
    const signedIn = await addUser(t.db, 'was-here@example.test', 'interviewer', { signedIn: true });
    const r = await admin.del(`/api/users/${signedIn}`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Deactivate them instead/);
  });

  it('USER-3: the last active administrator cannot be demoted, deactivated or removed', async () => {
    const r1 = await admin.patch(`/api/users/${adminId}`, { role: 'organiser' });
    expect(r1.status).toBe(409);
    expect(r1.body.error.message).toMatch(/last active administrator/);
    expect((await admin.patch(`/api/users/${adminId}`, { active: false })).status).toBe(409);
    // A second administrator who has never signed in can be removed; the first cannot remove themself.
    const other = await addUser(t.db, 'bea@example.test', 'admin');
    expect((await admin.del(`/api/users/${adminId}`)).status).toBe(409);
    expect((await admin.patch(`/api/users/${adminId}`, { role: 'organiser' })).status).toBe(200); // now allowed: Bea is an admin
    const bea = client(a.app, await signIn(a.app, 'bea@example.test'));
    expect((await bea.patch(`/api/users/${other}`, { role: 'interviewer' })).status).toBe(409);
    await bea.patch(`/api/users/${adminId}`, { role: 'admin' });
  });

  it('USER-3: two administrators demoting each other at the same moment cannot both succeed', async () => {
    const c1 = await addUser(t.db, 'c1@example.test', 'admin');
    const c2 = await addUser(t.db, 'c2@example.test', 'admin');
    // Leave exactly c1 and c2 as active administrators.
    await t.db.updateTable('users').set({ role: 'organiser' }).where('role', '=', 'admin').where('id', 'not in', [c1, c2]).execute();
    const s1 = client(a.app, await signIn(a.app, 'c1@example.test'));
    const s2 = client(a.app, await signIn(a.app, 'c2@example.test'));
    const [r1, r2] = await Promise.all([s1.patch(`/api/users/${c2}`, { role: 'organiser' }), s2.patch(`/api/users/${c1}`, { role: 'organiser' })]);
    // One wins; the other is refused (409 if it ran first under the lock, 403 if it already lost its role).
    expect([r1.status, r2.status].filter((x) => x === 200)).toHaveLength(1);
    const admins = await t.db.selectFrom('users').select('id').where('role', '=', 'admin').where('active', '=', true).execute();
    expect(admins).toHaveLength(1);
    await t.db.updateTable('users').set({ role: 'admin' }).where('id', '=', adminId).execute();
  });

  it('USER-1: lists page through long lists with a cursor', async () => {
    await admin.post('/api/users', { text: Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}@example.test`).join('\n'), role: 'interviewer' });
    const first = await admin.get('/api/users?limit=10');
    expect(first.body.items).toHaveLength(10);
    const second = await admin.get(`/api/users?limit=10&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items[0].email > first.body.items[9].email).toBe(true);
  });

  it('USER-1 AUTH-5: organisers and interviewers cannot see or change the Users list', async () => {
    await addUser(t.db, 'org@example.test', 'organiser');
    const org = client(a.app, await signIn(a.app, 'org@example.test'));
    expect((await org.get('/api/users')).status).toBe(403);
    expect((await org.post('/api/users', { text: 'x@example.test', role: 'admin' })).status).toBe(403);
    expect((await org.patch(`/api/users/${adminId}`, { active: false })).status).toBe(403);
  });
});
