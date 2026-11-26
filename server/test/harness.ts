// Test harness for server tests: a fresh database per test file (cloned from the migrated
// template), an app context with development sign-in, and helpers to sign people in.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig, type Config } from '../config';
import { createDb, createPool, type Db } from '../db/pool';
import { LiveBus } from '../live/bus';
import { RateLimiter } from '../http/route';
import { buildApp, type BuildOptions, type RouteInfo } from '../app';
import type { AppContext } from '../context';
import type { OidcProvider } from '../auth/oidc';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type Role } from '../../src/shared/api';

export const TEST_ORIGIN = 'http://localhost:8099';

export interface TestDb {
  url: string;
  name: string;
  pool: pg.Pool;
  db: Db;
  drop: () => Promise<void>;
}

/** A new, migrated, empty database for this test file. */
export async function createTestDb(opts: { empty?: boolean } = {}): Promise<TestDb> {
  const template = inject('templateDb');
  const adminUrl = inject('adminUrl');
  const tplPid = template.replace(/^ia_tpl_/, '');
  const name = `ia_t_${tplPid}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Cloning needs the template to be idle; parallel files can collide briefly, so retry.
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${opts.empty ? 'template0' : template}`);
      break;
    } catch (err) {
      if (i > 50) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool({ databaseUrl: url.href, max: 5 });
  const db = createDb(pool);
  return {
    url: url.href,
    name,
    pool,
    db,
    drop: async () => {
      await db.destroy().catch(() => {});
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function testConfig(databaseUrl: string, env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: TEST_ORIGIN,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    DEV_SIGN_IN: 'true',
    BOOTSTRAP_ADMINS: 'boot@example.test',
    ...env,
  });
}

export interface TestApp {
  ctx: AppContext;
  app: FastifyInstance;
  routes: RouteInfo[];
  close: () => Promise<void>;
}

export async function startApp(tdb: TestDb, opts: { env?: Record<string, string>; oidc?: OidcProvider | null; build?: BuildOptions } = {}): Promise<TestApp> {
  const config = testConfig(tdb.url, opts.env);
  const live = new LiveBus({ connectionString: tdb.url }, { warn: () => {}, info: () => {} });
  await live.start();
  const ctx: AppContext = { config, pool: tdb.pool, db: tdb.db, live, oidc: opts.oidc ?? null, rateLimiter: new RateLimiter() };
  const { app, routes } = await buildApp(ctx, { serveStatic: false, ...opts.build });
  return {
    ctx,
    app,
    routes,
    close: async () => {
      await live.stop();
      await app.close();
    },
  };
}

export async function addUser(db: Db, email: string, role: Role, extra: { active?: boolean; name?: string; signedIn?: boolean } = {}): Promise<string> {
  const r = await db
    .insertInto('users')
    .values({ email, role, active: extra.active ?? true, name: extra.name ?? null, last_sign_in_at: extra.signedIn ? new Date() : null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

/** Signs in through development sign-in and returns the Cookie header value. */
export async function signIn(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev/sign-in', headers: writeHeaders(), payload: { email } });
  if (res.statusCode !== 200) throw new Error(`sign-in as ${email} failed: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'ia_session' || x.name === '__Host-ia_session');
  if (!c) throw new Error('no session cookie');
  return `${c.name}=${c.value}`;
}

/** Headers a same-origin browser request from the app sends on a change (AUTH-5 CSRF). */
export function writeHeaders(cookie?: string): Record<string, string> {
  return { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) };
}

/** Convenience wrapper around app.inject for JSON calls as a signed-in person. */
export function client(app: FastifyInstance, cookie?: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: method === 'GET' ? (cookie ? { cookie } : {}) : writeHeaders(cookie), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: any = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers, raw: res };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}

/** Imports the bundled seed files (as `npm run db:seed` does). */
export async function seedBank(db: Db): Promise<void> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { importQuestions } = await import('../bank/import');
  const files = readdirSync('seed').filter((f) => f.endsWith('.json')).map((f) => ({ name: f, text: readFileSync(`seed/${f}`, 'utf8') }));
  const r = await importQuestions(db, { system: 'test seed' }, files, { dryRun: false });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
}
