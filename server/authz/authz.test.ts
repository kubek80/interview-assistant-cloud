// AUTH-5, USER-2, ROUND-2: every route is checked on the server. These tests enumerate the routes
// the app actually registers, so a new route is covered the moment it exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from 'kysely';
import { addUser, client, createTestDb, signIn, startApp, writeHeaders, type TestApp, type TestDb } from '../test/harness';
import { route } from '../http/route';
import { can, canInRound, GLOBAL_ACTIONS, type GlobalAction } from './policy';
import type { Role } from '../../src/shared/api';

/** USER-2 written out independently of policy.ts: what each role may do among what exists so far. */
const EXPECTED: Record<Role, readonly GlobalAction[]> = {
  admin: GLOBAL_ACTIONS.filter((a) => a !== 'bank.propose' && a !== 'reviews.respond'),
  organiser: ['bank.read', 'bank.edit', 'bank.comment', 'bank.review', 'settings.read', 'rounds.create', 'rounds.list'],
  interviewer: ['bank.read', 'settings.read', 'rounds.list'],
  // REVIEW-1: the question bank, their own proposals and comments, and their review requests. Nothing else.
  reviewer: ['bank.read', 'bank.propose', 'bank.comment', 'reviews.respond'],
};

/** REVIEW-1: every route a question reviewer can reach, written out. Any other route must refuse them. */
const REVIEWER_REACHABLE = [
  'GET /healthz',
  'GET /api/auth/options',
  'POST /api/auth/sign-out',
  'GET /api/auth/dev/users',
  'POST /api/auth/dev/sign-in',
  'GET /api/me',
  'GET /api/live',
  'GET /api/bank/tracks',
  'GET /api/bank/tracks/:trackId',
  'GET /api/bank/questions/:questionId/versions',
  'POST /api/bank/tracks/:trackId/export-csv',
  'GET /api/review-counts',
  'GET /api/proposals',
  'GET /api/proposals/:id',
  'POST /api/proposals',
  'POST /api/proposals/bulk',
  'POST /api/proposals/:id/withdraw',
  'GET /api/bank/questions/:questionId/feedback',
  'POST /api/bank/questions/:questionId/comments',
  'PUT /api/bank/questions/:questionId/looks-good',
  'GET /api/my-reviews',
  'GET /api/my-reviews/:id',
  'PUT /api/my-reviews/:id/items/:questionId',
].sort();

let t: TestDb;
let a: TestApp;
const cookies: Record<Role, string> = { admin: '', organiser: '', interviewer: '', reviewer: '' };
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t, {
    build: {
      // Round-scoped routes arrive in step 2; these stand in for them to test the mechanism now.
      extraRoutes: (app, ctx) => {
        const roundOf = async (req: { params: unknown }) => (req.params as { roundId: string }).roundId;
        route(app, ctx, { method: 'GET', url: '/api/test/rounds/:roundId', access: { round: 'round.read', roundOf }, params: z.object({ roundId: z.string() }), handler: ({ round }) => round });
        route(app, ctx, { method: 'POST', url: '/api/test/rounds/:roundId/manage', access: { round: 'round.manage', roundOf }, params: z.object({ roundId: z.string() }), handler: () => ({ ok: true }) });
        route(app, ctx, { method: 'POST', url: '/api/test/rounds/:roundId/plan', access: { round: 'round.plan', roundOf }, params: z.object({ roundId: z.string() }), handler: () => ({ ok: true }) });
      },
    },
  });
  for (const role of ['admin', 'organiser', 'interviewer', 'reviewer'] as const) {
    ids[role] = await addUser(t.db, `${role}@example.test`, role);
    cookies[role] = await signIn(a.app, `${role}@example.test`);
  }
  ids.member = await addUser(t.db, 'member@example.test', 'interviewer');
  ids.leader = await addUser(t.db, 'leader@example.test', 'interviewer');
  await sql`INSERT INTO tracks (id, name, version) VALUES ('rt', 'Round track', '2026.11')`.execute(t.db);
  const round = await t.db.insertInto('rounds').values({ name: 'Round A', track_id: 'rt', retention_until: '2027-01-01' }).returning('id').executeTakeFirstOrThrow();
  ids.round = round.id;
  await t.db.insertInto('round_members').values([
    { round_id: round.id, user_id: ids.member, role: 'interviewer' },
    { round_id: round.id, user_id: ids.leader, role: 'organiser' },
    // REVIEW-1: even put on a round by mistake, a reviewer gets nothing from it.
    { round_id: round.id, user_id: ids.reviewer, role: 'organiser' },
  ]).execute();
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

const fill = (url: string) =>
  url
    .replace(':trackId', 'qa')
    .replace(':questionId', 'qa-1')
    .replace(':categoryId', 'qa-strategy-risk')
    .replace(':roundId', '00000000-0000-4000-8000-000000000000')
    .replace(/:[a-zA-Z]+/g, '00000000-0000-4000-8000-000000000001');

describe('route protection', () => {
  it('AUTH-5: every API route declares who may call it, and only sign-in, sign-out and the health check are public', () => {
    const publicRoutes = a.routes.filter((r) => r.access === 'public' && (r.url.startsWith('/api') || r.url === '/healthz')).map((r) => `${r.method} ${r.url}`);
    expect(publicRoutes.sort()).toEqual(
      ['GET /api/auth/options', 'POST /api/auth/sign-out', 'GET /api/auth/dev/users', 'POST /api/auth/dev/sign-in', 'GET /healthz'].sort(),
    );
    expect(a.routes.filter((r) => r.url.startsWith('/api')).length).toBeGreaterThan(20);
  });

  it('AUTH-5: no non-public API route can be reached without signing in', async () => {
    const reached: string[] = [];
    for (const r of a.routes.filter((x) => x.access !== 'public' && x.url.startsWith('/api'))) {
      const res = await a.app.inject({ method: r.method as 'GET', url: fill(r.url), headers: r.method === 'GET' ? {} : writeHeaders(), ...(r.method === 'GET' ? {} : { payload: {} }) });
      if (res.statusCode !== 401) reached.push(`${r.method} ${r.url} → ${res.statusCode}`);
      else expect(JSON.parse(res.body).error.code).toBe('not_signed_in');
    }
    expect(reached).toEqual([]);
  });

  it('USER-2 AUTH-5: each role gets exactly the permissions of its row in the roles table', () => {
    for (const role of ['admin', 'organiser', 'interviewer', 'reviewer'] as const) {
      const actor = { id: 'x', email: 'x@example.test', name: null, role };
      expect(GLOBAL_ACTIONS.filter((p) => can(actor, p))).toEqual([...EXPECTED[role]]);
    }
  });

  it('USER-2 AUTH-5: every permission-checked route lets in exactly the roles USER-2 allows', async () => {
    const wrong: string[] = [];
    for (const r of a.routes.filter((x) => x.url.startsWith('/api') && !['public', 'signedIn'].includes(x.access) && !x.access.startsWith('round:'))) {
      if (r.url === '/api/live') continue;
      for (const role of ['admin', 'organiser', 'interviewer', 'reviewer'] as const) {
        const res = await a.app.inject({ method: r.method as 'GET', url: fill(r.url), headers: r.method === 'GET' ? { cookie: cookies[role] } : writeHeaders(cookies[role]), ...(r.method === 'GET' ? {} : { payload: {} }) });
        const allowed = r.access.split('|').some((x) => (EXPECTED[role] as readonly string[]).includes(x));
        const refused = res.statusCode === 403;
        if (allowed === refused) wrong.push(`${role} ${r.method} ${r.url} (${r.access}) → ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('AUTH-5: a request that changes data without the anti-forgery header, or from another origin, is refused', async () => {
    const noHeader = await a.app.inject({ method: 'POST', url: '/api/users/preview', headers: { cookie: cookies.admin, origin: 'http://localhost:8099' }, payload: { text: 'x@example.test' } });
    expect(noHeader.statusCode).toBe(403);
    expect(JSON.parse(noHeader.body).error.code).toBe('csrf');
    const otherOrigin = await a.app.inject({ method: 'POST', url: '/api/users/preview', headers: { ...writeHeaders(cookies.admin), origin: 'https://evil.example' }, payload: { text: 'x@example.test' } });
    expect(otherOrigin.statusCode).toBe(403);
    const crossSite = await a.app.inject({ method: 'POST', url: '/api/users/preview', headers: { ...writeHeaders(cookies.admin), 'sec-fetch-site': 'cross-site' }, payload: { text: 'x@example.test' } });
    expect(crossSite.statusCode).toBe(403);
    const ok = await a.app.inject({ method: 'POST', url: '/api/users/preview', headers: writeHeaders(cookies.admin), payload: { text: 'x@example.test' } });
    expect(ok.statusCode).toBe(200);
  });

  it('AUTH-5: there is no CORS: preflights are refused and no Access-Control headers are sent', async () => {
    const pre = await a.app.inject({ method: 'OPTIONS', url: '/api/users', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(405);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const get = await a.app.inject({ method: 'GET', url: '/api/bank/tracks', headers: { cookie: cookies.admin, origin: 'https://evil.example' } });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('AUTH-5 USER-3 HOST-5: a deactivated person is refused on their very next request, whatever they call', async () => {
    const id = await addUser(t.db, 'soon-gone@example.test', 'organiser');
    const c = await signIn(a.app, 'soon-gone@example.test');
    expect((await client(a.app, c).get('/api/bank/tracks')).status).toBe(200);
    await t.db.updateTable('users').set({ active: false }).where('id', '=', id).execute();
    expect((await client(a.app, c).get('/api/bank/tracks')).status).toBe(401);
    expect((await client(a.app, c).get('/api/me')).status).toBe(401);
  });
});

describe('question reviewers (REVIEW-1)', () => {
  it('REVIEW-1 AUTH-5: a question reviewer can reach exactly the bank, their proposals, comments and review requests, and nothing else', async () => {
    const reachable: string[] = [];
    for (const r of a.routes.filter((x) => x.url.startsWith('/api') || x.url === '/healthz')) {
      if (r.url === '/api/auth/sign-out') {
        reachable.push('POST /api/auth/sign-out'); // public; calling it would end the session used here
        continue;
      }
      const res = await a.app.inject({ method: r.method as 'GET', url: fill(r.url), headers: r.method === 'GET' ? { cookie: cookies.reviewer } : writeHeaders(cookies.reviewer), ...(r.method === 'GET' ? {} : { payload: {} }) });
      const refused = res.statusCode === 401 || res.statusCode === 403 || (r.access.startsWith('round:') && res.statusCode === 404);
      if (!refused) reachable.push(`${r.method} ${r.url}`);
    }
    expect(reachable.filter((x) => !x.startsWith('GET /api/test') && !x.startsWith('POST /api/test')).sort()).toEqual(REVIEWER_REACHABLE);
  });

  it('REVIEW-1: nothing inside a round, even one a reviewer was put on as its organiser, and no audit log, users or settings', async () => {
    const reviewer = client(a.app, cookies.reviewer);
    expect((await reviewer.get(`/api/test/rounds/${ids.round}`)).status).toBe(403);
    expect((await reviewer.post(`/api/test/rounds/${ids.round}/manage`)).status).toBe(403);
    for (const url of ['/api/audit', '/api/users', '/api/settings', '/api/reviews']) expect((await reviewer.get(url)).status).toBe(403);
    // Permissions a later step adds are closed to reviewers unless they are listed as question-bank permissions.
    expect(can({ id: 'x', email: 'x', name: null, role: 'reviewer' }, 'rounds.list')).toBe(false);
    expect(canInRound({ id: 'x', email: 'x', name: null, role: 'reviewer' }, 'round.read', { roundId: 'r', memberRole: 'organiser', state: 'open' })).toBe(false);
  });
});

describe('round-scoped permissions (groundwork for step 2)', () => {
  const as = async (email: string) => client(a.app, await signIn(a.app, email));

  it('ROUND-2 AUTH-5: people see only the rounds they are on; others get "not found", not "forbidden"', async () => {
    const member = await as('member@example.test');
    expect((await member.get(`/api/test/rounds/${ids.round}`)).body).toMatchObject({ roundId: ids.round, memberRole: 'interviewer' });
    const outsider = client(a.app, cookies.organiser);
    expect((await outsider.get(`/api/test/rounds/${ids.round}`)).status).toBe(404);
    expect((await outsider.get('/api/test/rounds/00000000-0000-4000-8000-000000000009')).status).toBe(404);
    expect((await outsider.get('/api/test/rounds/not-a-uuid')).status).toBe(404);
    expect((await client(a.app, cookies.admin).get(`/api/test/rounds/${ids.round}`)).status).toBe(200);
  });

  it('ROUND-2 USER-2: within a round, its organisers manage it and its interviewers do not', async () => {
    expect((await (await as('member@example.test')).post(`/api/test/rounds/${ids.round}/manage`)).status).toBe(403);
    expect((await (await as('leader@example.test')).post(`/api/test/rounds/${ids.round}/manage`)).status).toBe(200);
    expect((await client(a.app, cookies.admin).post(`/api/test/rounds/${ids.round}/manage`)).status).toBe(200);
  });

  it('ROUND-5: a closed round refuses planning, even to administrators; reading still works', async () => {
    await t.db.updateTable('rounds').set({ state: 'closed', closed_at: new Date() }).where('id', '=', ids.round).execute();
    expect((await client(a.app, cookies.admin).post(`/api/test/rounds/${ids.round}/plan`)).status).toBe(403);
    expect((await (await as('member@example.test')).get(`/api/test/rounds/${ids.round}`)).status).toBe(200);
    expect(canInRound({ id: 'x', email: 'x', name: null, role: 'admin' }, 'round.manage', { roundId: 'r', memberRole: null, state: 'closed' })).toBe(true);
    expect(canInRound(null, 'round.read', { roundId: 'r', memberRole: 'organiser', state: 'open' })).toBe(false);
  });
});
