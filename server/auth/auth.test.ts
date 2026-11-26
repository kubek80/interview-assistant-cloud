// AUTH-1…AUTH-4: Google sign-in callback handling with a stand-in provider (Google itself cannot be
// reached from tests; see oidc-real.test.ts for the real library against a local issuer), sessions,
// sign-out, bootstrap administrators and the "no access" outcome.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { addUser, client, cookieFrom, createTestDb, startApp, TEST_ORIGIN, type TestApp, type TestDb } from '../test/harness';
import { checkClaims, SignInRefused, type IdClaims, type OidcProvider } from './oidc';
import { safeReturnPath } from './routes';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';

/** A provider that hands back whatever claims the test sets, and records what it was asked. */
class FakeProvider implements OidcProvider {
  issuer = ISSUER;
  clientId = CLIENT_ID;
  claims: (nonce: string) => IdClaims = (nonce) => this.valid('person@example.test', nonce);
  lastAuth: { state: string; nonce: string; codeChallenge: string; redirectUri: string } | null = null;
  lastExchange: { codeVerifier: string; state: string; nonce: string } | null = null;
  async authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }) {
    this.lastAuth = p;
    return new URL(`https://accounts.google.com/o/oauth2/v2/auth?state=${p.state}`);
  }
  async exchange(p: { codeVerifier: string; state: string; nonce: string }) {
    this.lastExchange = p;
    return this.claims(p.nonce);
  }
  valid(email: string, nonce: string, extra: Partial<IdClaims> = {}): IdClaims {
    return { iss: ISSUER, aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: `sub-${email}`, email, email_verified: true, name: 'Pat Person', ...extra };
  }
}

let t: TestDb;
let a: TestApp;
const provider = new FakeProvider();

beforeAll(async () => {
  t = await createTestDb();
  a = await startApp(t, { oidc: provider, env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret' } });
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

/** Runs start → (Google) → callback; returns the callback response. */
async function googleSignIn(opts: { returnTo?: string; tamperState?: boolean; cookie?: string; dropLoginCookie?: boolean } = {}): Promise<LightMyRequestResponse> {
  const start = await a.app.inject({ method: 'GET', url: `/api/auth/google/start${opts.returnTo ? `?returnTo=${encodeURIComponent(opts.returnTo)}` : ''}` });
  expect(start.statusCode).toBe(302);
  const login = start.cookies.find((c) => c.name === 'ia_login')!;
  const state = opts.tamperState ? 'x'.repeat(43) : provider.lastAuth!.state;
  const cookies = [opts.dropLoginCookie ? '' : `ia_login=${login.value}`, opts.cookie ?? ''].filter(Boolean).join('; ');
  return a.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${state}`, headers: cookies ? { cookie: cookies } : {} });
}

const location = (r: LightMyRequestResponse) => r.headers.location as string;

beforeEach(() => {
  provider.claims = (nonce) => provider.valid('person@example.test', nonce);
});

describe('Google sign-in (stand-in provider)', () => {
  it('AUTH-1: start redirects to Google with PKCE (S256), a fresh state and nonce, and a short-lived HttpOnly login cookie', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(r.statusCode).toBe(302);
    expect(location(r)).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(provider.lastAuth!.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(provider.lastAuth!.redirectUri).toBe(`${TEST_ORIGIN}/api/auth/google/callback`);
    const c = r.cookies.find((x) => x.name === 'ia_login')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.maxAge).toBe(600);
  });

  it('AUTH-1 AUTH-2 AUTH-4: an invited person signs in; the session cookie is HttpOnly, SameSite=Lax; /api/me works', async () => {
    await addUser(t.db, 'person@example.test', 'interviewer');
    const r = await googleSignIn({ returnTo: '/bank/qa' });
    expect(r.statusCode).toBe(303);
    expect(location(r)).toBe(`${TEST_ORIGIN}/#/bank/qa`);
    const c = r.cookies.find((x) => x.name === 'ia_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.path).toBe('/');
    const me = await client(a.app, cookieFrom(r)).get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'person@example.test', role: 'interviewer', name: 'Pat Person' });
    expect(provider.lastExchange!.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const u = await t.db.selectFrom('users').selectAll().where('email', '=', 'person@example.test').executeTakeFirstOrThrow();
    expect(u.google_sub).toBe('sub-person@example.test');
    expect(u.last_sign_in_at).not.toBeNull();
  });

  it('AUTH-2: someone not on the Users list is sent to the no-access page and gets no session', async () => {
    provider.claims = (nonce) => provider.valid('stranger@example.test', nonce);
    const r = await googleSignIn();
    expect(location(r)).toBe(`${TEST_ORIGIN}/#/no-access`);
    expect(r.cookies.find((x) => x.name === 'ia_session')).toBeUndefined();
    expect(await t.db.selectFrom('users').select('id').where('email', '=', 'stranger@example.test').executeTakeFirst()).toBeUndefined();
  });

  it('AUTH-2: an email Google has not verified is refused', async () => {
    await addUser(t.db, 'unverified@example.test', 'admin');
    provider.claims = (nonce) => provider.valid('unverified@example.test', nonce, { email_verified: false });
    const r = await googleSignIn();
    expect(location(r)).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-1: an ID token for another client (wrong audience) or another issuer is refused', async () => {
    await addUser(t.db, 'aud@example.test', 'admin');
    provider.claims = (nonce) => provider.valid('aud@example.test', nonce, { aud: 'someone-else' });
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/no-access`);
    provider.claims = (nonce) => provider.valid('aud@example.test', nonce, { iss: 'https://evil.example' });
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-1: a nonce or state that does not match the sign-in that started it is refused', async () => {
    await addUser(t.db, 'nonce@example.test', 'admin');
    provider.claims = (nonce) => provider.valid('nonce@example.test', `${nonce}x`);
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/no-access`);
    provider.claims = (nonce) => provider.valid('nonce@example.test', nonce);
    expect(location(await googleSignIn({ tamperState: true }))).toBe(`${TEST_ORIGIN}/#/no-access`);
    // Without the login cookie (a callback forged in another browser) nothing happens either.
    expect(location(await googleSignIn({ dropLoginCookie: true }))).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-1: a sign-in record is used once (a replayed callback is refused)', async () => {
    await addUser(t.db, 'replay@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('replay@example.test', nonce);
    const start = await a.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    const cookie = `ia_login=${start.cookies.find((c) => c.name === 'ia_login')!.value}`;
    const url = `/api/auth/google/callback?code=abc&state=${provider.lastAuth!.state}`;
    const first = await a.app.inject({ method: 'GET', url, headers: { cookie } });
    expect(location(first)).toBe(`${TEST_ORIGIN}/#/`);
    const again = await a.app.inject({ method: 'GET', url, headers: { cookie } });
    expect(location(again)).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-2 USER-3: a deactivated person is refused', async () => {
    await addUser(t.db, 'gone@example.test', 'organiser', { active: false });
    provider.claims = (nonce) => provider.valid('gone@example.test', nonce);
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-3: a bootstrap administrator from configuration can always sign in, and is created or restored as an active administrator', async () => {
    provider.claims = (nonce) => provider.valid('boot@example.test', nonce);
    const r = await googleSignIn();
    expect(location(r)).toBe(`${TEST_ORIGIN}/#/`);
    let u = await t.db.selectFrom('users').selectAll().where('email', '=', 'boot@example.test').executeTakeFirstOrThrow();
    expect(u).toMatchObject({ role: 'admin', active: true });
    await t.db.updateTable('users').set({ role: 'interviewer', active: false }).where('id', '=', u.id).execute();
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/`);
    u = await t.db.selectFrom('users').selectAll().where('id', '=', u.id).executeTakeFirstOrThrow();
    expect(u).toMatchObject({ role: 'admin', active: true });
    const audit = await t.db.selectFrom('audit_events').select(['action', 'actor_label']).where('entity_id', '=', u.id).execute();
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['user.added', 'user.changed', 'auth.signed_in']));
  });

  it('AUTH-1: the same email arriving from a different Google account (another subject) is refused', async () => {
    await addUser(t.db, 'sub@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('sub@example.test', nonce);
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/`);
    provider.claims = (nonce) => provider.valid('sub@example.test', nonce, { sub: 'another-account' });
    expect(location(await googleSignIn())).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-4: signing in ends the session the browser already had (no session fixation) and issues a new id', async () => {
    await addUser(t.db, 'fix@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('fix@example.test', nonce);
    const first = cookieFrom(await googleSignIn());
    const second = await googleSignIn({ cookie: first });
    const secondCookie = cookieFrom(second);
    expect(secondCookie).not.toBe(first);
    expect((await client(a.app, first).get('/api/me')).status).toBe(401);
    expect((await client(a.app, secondCookie).get('/api/me')).status).toBe(200);
  });

  it('AUTH-1: the page to return to after signing in cannot lead off the app (open redirect)', async () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/../x', 'javascript:alert(1)', '/a//b', '/no-access']) expect(safeReturnPath(bad)).toBe('/');
    expect(safeReturnPath('/bank/qa')).toBe('/bank/qa');
    await addUser(t.db, 'redir@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('redir@example.test', nonce);
    expect(location(await googleSignIn({ returnTo: '//evil.example/x' }))).toBe(`${TEST_ORIGIN}/#/`);
  });

  it('AUTH-1: claims are checked independently of the library (unit)', () => {
    const base = provider.valid('x@example.test', 'n');
    expect(checkClaims(base, { issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n' })).toEqual({ sub: 'sub-x@example.test', email: 'x@example.test', name: 'Pat Person' });
    const reason = (c: IdClaims) => {
      try {
        checkClaims(c, { issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n' });
        return 'ok';
      } catch (e) {
        return (e as SignInRefused).reason;
      }
    };
    expect(reason({ ...base, iss: 'accounts.google.com' })).toBe('ok');
    expect(reason({ ...base, aud: [CLIENT_ID, 'other'] })).toBe('wrong_audience'); // several audiences need azp
    expect(reason({ ...base, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID })).toBe('ok');
    expect(reason({ ...base, exp: 1 })).toBe('expired');
    expect(reason({ ...base, email: undefined })).toBe('no_email');
    expect(reason({ ...base, email_verified: undefined })).toBe('email_not_verified');
    expect(checkClaims({ ...base, email: ' Mixed@Example.TEST ' }, { issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n' }).email).toBe('mixed@example.test');
  });
});

describe('sessions', () => {
  it('AUTH-4: signing out ends the session on the server and clears the cookie', async () => {
    await addUser(t.db, 'out@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('out@example.test', nonce);
    const cookie = cookieFrom(await googleSignIn());
    const r = await client(a.app, cookie).post('/api/auth/sign-out');
    expect(r.status).toBe(204);
    expect(String(r.headers['set-cookie'])).toMatch(/ia_session=;.*Expires=Thu, 01 Jan 1970/);
    expect((await client(a.app, cookie).get('/api/me')).status).toBe(401);
  });

  it('AUTH-4: a session idle for longer than the configured time ends', async () => {
    await addUser(t.db, 'idle@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('idle@example.test', nonce);
    const cookie = cookieFrom(await googleSignIn());
    expect((await client(a.app, cookie).get('/api/me')).status).toBe(200);
    await sql`UPDATE auth_sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'idle@example.test')`.execute(t.db);
    expect((await client(a.app, cookie).get('/api/me')).status).toBe(401);
  });

  it('AUTH-4: the cookie holds a random token; the database stores only its keyed hash', async () => {
    await addUser(t.db, 'hash@example.test', 'interviewer');
    provider.claims = (nonce) => provider.valid('hash@example.test', nonce);
    const token = cookieFrom(await googleSignIn()).split('=')[1];
    const rows = await t.db.selectFrom('auth_sessions').select('id_hash').execute();
    expect(rows.some((r) => r.id_hash.toString('base64url') === token || r.id_hash.toString() === token)).toBe(false);
    expect(rows.every((r) => r.id_hash.length === 32)).toBe(true);
  });

  it('AUTH-4: Secure and the __Host- prefix are used when the app is served over https', async () => {
    const t2 = await createTestDb();
    const a2 = await startApp(t2, { env: { PUBLIC_URL: 'https://interviews.example.test' } });
    try {
      await addUser(t2.db, 'https@example.test', 'interviewer');
      const r = await a2.app.inject({ method: 'POST', url: '/api/auth/dev/sign-in', headers: { 'x-ia-request': '1', origin: 'https://interviews.example.test' }, payload: { email: 'https@example.test' } });
      const c = r.cookies.find((x) => x.name === '__Host-ia_session')!;
      expect(c.secure).toBe(true);
      expect(c.httpOnly).toBe(true);
      expect(c.path).toBe('/');
      expect(c.domain).toBeUndefined();
    } finally {
      await a2.close();
      await t2.drop();
    }
  });

  it('AUTH-1: sign-in endpoints are rate limited', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await a.app.inject({ method: 'GET', url: '/api/auth/google/start', remoteAddress: '203.0.113.9' });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
