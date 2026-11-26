// AUTH-1: the real openid-client library (discovery, PKCE, code exchange, ID token signature,
// issuer, audience and nonce checks) against a local OpenID provider that behaves like Google's,
// with keys made for the test. Only the transport differs (http on localhost, allowed for tests).
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { addUser, client, cookieFrom, createTestDb, startApp, TEST_ORIGIN, type TestApp, type TestDb } from '../test/harness';
import { createOidcProvider } from './oidc';

const CLIENT_ID = 'real-client';
const CLIENT_SECRET = 'real-secret';

let issuer = '';
let server: Server;
let t: TestDb;
let a: TestApp;
const codes = new Map<string, { challenge: string; nonce: string; email: string }>();
let tokenOverrides: Record<string, unknown> = {};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      const [id, secret] = basic.split(':').map(decodeURIComponent);
      if ((id || form.get("client_id")) !== CLIENT_ID || (secret || form.get("client_secret")) !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (form.get('redirect_uri') !== `${TEST_ORIGIN}/api/auth/google/callback`) return json(400, { error: 'invalid_grant' });
      const idToken = await new SignJWT({ email: grant.email, email_verified: true, nonce: grant.nonce, name: 'Real Person', ...tokenOverrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience((tokenOverrides.aud as string) ?? CLIENT_ID)
        .setSubject(`sub-${grant.email}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t = await createTestDb();
  a = await startApp(t, {
    oidc: createOidcProvider({ issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowInsecureForTests: true }),
    env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET },
  });
});

afterAll(async () => {
  await a.close();
  await t.drop();
  server.close();
});

/** Plays the browser and the provider's consent screen: start, "approve", callback. */
async function flow(email: string, tamper?: (code: string) => void) {
  const start = await a.app.inject({ method: 'GET', url: '/api/auth/google/start?returnTo=%2Fusers' });
  const auth = new URL(start.headers.location as string);
  expect(auth.origin + auth.pathname).toBe(`${issuer}/auth`);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('scope')).toBe('openid email profile');
  expect(auth.searchParams.get('client_id')).toBe(CLIENT_ID);
  const code = `code-${Math.random()}`;
  codes.set(code, { challenge: auth.searchParams.get('code_challenge')!, nonce: auth.searchParams.get('nonce')!, email });
  tamper?.(code);
  const login = start.cookies.find((c) => c.name === 'ia_login')!;
  return a.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=${code}&state=${auth.searchParams.get('state')}`, headers: { cookie: `ia_login=${login.value}` } });
}

describe('openid-client against a local OpenID provider', () => {
  it('AUTH-1: discovery, PKCE, code exchange and ID token verification sign an invited person in', async () => {
    tokenOverrides = {};
    await addUser(t.db, 'real@example.test', 'organiser');
    const r = await flow('real@example.test');
    expect(r.headers.location).toBe(`${TEST_ORIGIN}/#/users`);
    const me = await client(a.app, cookieFrom(r)).get('/api/me');
    expect(me.body).toMatchObject({ email: 'real@example.test', role: 'organiser', name: 'Real Person' });
  });

  it('AUTH-1: a code exchanged with the wrong PKCE verifier is refused', async () => {
    tokenOverrides = {};
    await addUser(t.db, 'pkce@example.test', 'organiser');
    const r = await flow('pkce@example.test', (code) => {
      codes.get(code)!.challenge = 'not-the-challenge';
    });
    expect(r.headers.location).toBe(`${TEST_ORIGIN}/#/no-access`);
  });

  it('AUTH-1: an ID token for another audience, or with another nonce, is rejected by the library', async () => {
    await addUser(t.db, 'aud2@example.test', 'organiser');
    tokenOverrides = { aud: 'another-client' };
    expect((await flow('aud2@example.test')).headers.location).toBe(`${TEST_ORIGIN}/#/no-access`);
    tokenOverrides = { nonce: 'forged' };
    expect((await flow('aud2@example.test')).headers.location).toBe(`${TEST_ORIGIN}/#/no-access`);
    tokenOverrides = { email_verified: false };
    expect((await flow('aud2@example.test')).headers.location).toBe(`${TEST_ORIGIN}/#/no-access`);
    tokenOverrides = {};
    expect((await flow('aud2@example.test')).headers.location).toBe(`${TEST_ORIGIN}/#/users`);
  });
});
