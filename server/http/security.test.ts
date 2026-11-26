// SEC-1 (hosted), SEC-2, HOST-3, HOST-7, AUTH-6: headers, errors, limits, health, logs and configuration.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, signIn, startApp, testConfig, writeHeaders, type TestApp, type TestDb } from '../test/harness';
import { ConfigError, describeConfig, loadConfig } from '../config';
import { CONTENT_SECURITY_POLICY } from './security';
import { defaultLogger } from '../app';

let t: TestDb;
let a: TestApp;
const logLines: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  // The production logger configuration, writing to memory.
  a = await startApp(t, { build: { logger: { ...(defaultLogger('info') as object), stream: sink } } });
  await addUser(t.db, 'admin@example.test', 'admin', { name: 'Ada' });
});
afterAll(async () => {
  await a.close();
  await t.drop();
});

describe('response headers', () => {
  it('SEC-1: the Content Security Policy is sent as a header: own origin only, no inline script, no framing', async () => {
    for (const url of ['/healthz', '/api/auth/options', '/api/nope', '/']) {
      const r = await a.app.inject({ method: 'GET', url });
      expect(r.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    }
    const csp = CONTENT_SECURITY_POLICY;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it('SEC-1: other security headers are set; API responses are never cached; HSTS only in production over https', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/api/auth/options' });
    expect(r.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin' });
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    const t2 = await createTestDb();
    const prod = await startApp(t2, { env: { NODE_ENV: 'production', PUBLIC_URL: 'https://interviews.example.test', DEV_SIGN_IN: 'false', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' } });
    try {
      const p = await prod.app.inject({ method: 'GET', url: '/healthz' });
      expect(p.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
      // AUTH-6: development sign-in does not exist in production.
      expect((await prod.app.inject({ method: 'POST', url: '/api/auth/dev/sign-in', headers: { 'x-ia-request': '1' }, payload: { email: 'admin@example.test' } })).statusCode).toBe(404);
      expect(JSON.parse((await prod.app.inject({ method: 'GET', url: '/api/auth/options' })).body)).toEqual({ google: false, devSignIn: false });
    } finally {
      await prod.close();
      await t2.drop();
    }
  });
});

describe('errors and limits', () => {
  it('SEC-2: errors have one shape with a safe message: no stack traces, SQL or internals', async () => {
    const cookie = await signIn(a.app, 'admin@example.test');
    const bad = await client(a.app, cookie).patch('/api/users/not-a-uuid', { role: 'admin' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: 'invalid', message: 'The address is not valid.', details: { id: expect.any(String) } } });
    const json = await a.app.inject({ method: 'POST', url: '/api/users/preview', headers: { ...writeHeaders(cookie), 'content-type': 'application/json' }, payload: '{"text": ' });
    expect(json.statusCode).toBe(400);
    expect(JSON.parse(json.body).error.code).toBe('invalid');
    for (const r of [bad.raw, json]) expect(r.body).not.toMatch(/at \w+ \(|\.ts:|SELECT|node_modules/);
  });

  it('SEC-2: request bodies are limited in size', async () => {
    const cookie = await signIn(a.app, 'admin@example.test');
    const r = await client(a.app, cookie).post('/api/users/preview', { text: 'x'.repeat(200_000) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
  });

  it('SEC-2: text that looks like SQL is only ever data', async () => {
    const cookie = await signIn(a.app, 'admin@example.test');
    const c = client(a.app, cookie);
    const r = await c.get(`/api/users?q=${encodeURIComponent("' OR 1=1; DROP TABLE users; --")}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect((await c.get('/api/users?q=%25')).body.items).toEqual([]); // "%" is matched literally
    expect((await c.get('/api/users')).body.items.length).toBeGreaterThan(0);
  });
});

describe('health and logs', () => {
  it('HOST-7: the health check says whether the database answers', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok', database: 'ok' });
    const t2 = await createTestDb();
    const down = await startApp(t2);
    await t2.drop(); // the database goes away
    const d = await down.app.inject({ method: 'GET', url: '/healthz' });
    expect(d.statusCode).toBe(503);
    expect(JSON.parse(d.body)).toEqual({ status: 'unavailable', database: 'unreachable' });
    await down.close().catch(() => {});
  });

  it('HOST-7 PRIV-3: request logs carry a request id, method, path and status, never emails, cookies, tokens, query strings or bodies', async () => {
    logLines.length = 0;
    const cookie = await signIn(a.app, 'admin@example.test');
    await client(a.app, cookie).post('/api/users', { text: 'secret-candidate@example.test', role: 'interviewer' });
    await client(a.app, cookie).get('/api/users?q=Jane%20Candidate');
    const all = logLines.join('\n');
    expect(all).toMatch(/"reqId":"[0-9a-f-]{36}"/);
    expect(all).toMatch(/"path":"\/api\/users"/);
    expect(all).not.toMatch(/example\.test|Jane|Candidate|ia_session|cookie|x-ia-request/i);
    expect(all).not.toContain(cookie.split('=')[1]);
  });
});

describe('configuration', () => {
  it('HOST-3 AUTH-3: missing or unsafe settings stop the server with every problem listed', () => {
    let err: ConfigError | null = null;
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.problems.join('\n')).toMatch(/PUBLIC_URL/);
    expect(err!.problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(err!.problems.join('\n')).toMatch(/SESSION_SECRET/);
    expect(err!.problems.join('\n')).toMatch(/GOOGLE_CLIENT_ID/);
    expect(err!.problems.join('\n')).toMatch(/BOOTSTRAP_ADMINS/);
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'http://x.example', DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', BOOTSTRAP_ADMINS: 'a@b.co' })).toThrow(/https/);
  });

  it('AUTH-6: development sign-in is refused at startup in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.example', DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', BOOTSTRAP_ADMINS: 'a@b.co', DEV_SIGN_IN: 'true' }),
    ).toThrow(/DEV_SIGN_IN must not be enabled/);
  });

  it('HOST-3: what is logged about the configuration contains no secret', () => {
    const c = testConfig('postgres://ia:pw-123@127.0.0.1/x', { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'google-secret-xyz', DB_PASSWORD: 'db-secret' });
    const text = JSON.stringify(describeConfig(c));
    for (const secret of ['pw-123', 'google-secret-xyz', 'db-secret', c.sessionSecret, 'boot@example.test']) expect(text).not.toContain(secret);
  });
});
