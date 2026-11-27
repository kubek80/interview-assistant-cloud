// AUTH-1…AUTH-4, AUTH-6: signing in and out.
//
// Google: /api/auth/google/start stores a one-time sign-in record (state, nonce, PKCE verifier,
// where to go afterwards) keyed by the hash of a random value in a short-lived HttpOnly cookie, and
// redirects to Google. /api/auth/google/callback takes that record (once), checks the state against
// it, lets the provider exchange the code and verify the ID token, checks the claims again, then
// admits the person only if their verified email is on the Users list and active (AUTH-2), or is a
// bootstrap administrator from configuration (AUTH-3). A new session id is issued at every sign-in
// and any session cookie the browser already had is ended (no session fixation).
//
// Everyone refused, for whatever reason, lands on the same "no access" page, which shows nothing
// about the app. The reason goes to the server log without the email address (HOST-7).
//
// Development sign-in (AUTH-6) exists only when DEV_SIGN_IN=true, which config.ts refuses in
// production; its routes are not even registered otherwise.
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { ApiError } from '../http/errors';
import { appendAudit } from '../audit/audit';
import { permissionsOf, type Actor } from '../authz/policy';
import { publish } from '../live/bus';
import type { Executor } from '../db/pool';
import type { Me, AuthOptions, DevUser } from '../../src/shared/api';
import { checkClaims, pkceChallenge, randomPkceVerifier, SignInRefused } from './oidc';
import {
  clearSessionCookie,
  createSession,
  endSession,
  keyedHash,
  loginCookieName,
  lookupSession,
  newToken,
  purgeExpired,
  sessionTokenOf,
  setSessionCookie,
} from './sessions';

const LOGIN_TTL_MS = 10 * 60_000;
const AUTH_RATE = 30;

/**
 * Where to go after signing in: a path inside the app's hash routes ("/bank/qa" → "/#/bank/qa").
 * Anything else (other sites, "//", backslashes, schemes, odd characters) becomes "/". The redirect
 * is always built on PUBLIC_URL, so it cannot leave the app either way.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) return '/';
  if (!/^\/[A-Za-z0-9\-._~/?=&%]*$/.test(value)) return '/';
  if (value.startsWith('//') || value.includes('/..') || /\/\//.test(value)) return '/';
  if (value.startsWith('/no-access') || value.startsWith('/sign-in')) return '/';
  return value;
}

const appUrl = (ctx: AppContext, hashPath: string) => `${ctx.config.publicUrl}/#${hashPath}`;
const redirectUri = (ctx: AppContext) => `${ctx.config.publicUrl}/api/auth/google/callback`;

/** The outcome of an identity arriving from Google or development sign-in. Throws SignInRefused. */
export async function admitUser(db: Executor, ctx: AppContext, id: { email: string; sub: string | null; name: string | null }): Promise<Actor> {
  const email = id.email.trim().toLowerCase();
  const bootstrap = ctx.config.bootstrapAdmins.includes(email);
  let user = await db.selectFrom('users').selectAll().where('email', '=', email).forUpdate().executeTakeFirst();
  const system = { system: 'system (bootstrap administrator from configuration)' };
  if (!user) {
    if (!bootstrap) throw new SignInRefused('not_invited');
    user = await db.insertInto('users').values({ email, name: id.name, role: 'admin' }).returningAll().executeTakeFirstOrThrow();
    await appendAudit(db, system, { action: 'user.added', entity: 'user', entityId: user.id, after: { email, role: 'admin', source: 'BOOTSTRAP_ADMINS' } });
  } else if (bootstrap && (!user.active || user.role !== 'admin')) {
    // AUTH-3: a bootstrap administrator can always sign in, so the app cannot be locked out of.
    const before = { role: user.role, active: user.active };
    user = await db.updateTable('users').set({ role: 'admin', active: true, deactivated_at: null, updated_at: new Date() }).where('id', '=', user.id).returningAll().executeTakeFirstOrThrow();
    await appendAudit(db, system, { action: 'user.changed', entity: 'user', entityId: user.id, before, after: { role: 'admin', active: true, source: 'BOOTSTRAP_ADMINS' } });
  } else if (!user.active) {
    throw new SignInRefused('deactivated');
  }
  if (id.sub && user.google_sub && user.google_sub !== id.sub) throw new SignInRefused('account_mismatch');
  const updated = await db
    .updateTable('users')
    .set({
      last_sign_in_at: new Date(),
      google_sub: user.google_sub ?? id.sub,
      name: id.name ?? user.name,
    })
    .where('id', '=', user.id)
    .returning(['id', 'email', 'name', 'role'])
    .executeTakeFirstOrThrow();
  return updated;
}

async function startSession(req: FastifyRequest, reply: FastifyReply, ctx: AppContext, actor: Actor, method: 'google' | 'dev', db: Executor) {
  // No session fixation: whatever session cookie came in is ended; a fresh id is always issued.
  const old = await lookupSession(ctx.db, ctx.config, sessionTokenOf(req, ctx.config));
  if (old) await endSession(db, old.idHash);
  const token = await createSession(db, ctx.config, actor.id, method);
  await appendAudit(db, actor, { action: 'auth.signed_in', entity: 'user', entityId: actor.id, after: { method } });
  await publish(db, { topic: 'users', kind: 'signed-in', id: actor.id });
  setSessionCookie(reply, ctx.config, token);
}

function refuse(req: FastifyRequest, reply: FastifyReply, ctx: AppContext, reason: string) {
  req.log.info({ signIn: 'refused', reason }, 'sign-in refused');
  return reply.redirect(appUrl(ctx, '/no-access'), 303);
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config } = ctx;

  route(app, ctx, {
    method: 'GET',
    url: '/api/auth/options',
    access: { public: true },
    handler: (): AuthOptions => ({ google: !!ctx.oidc, devSignIn: config.devSignIn }),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/me',
    access: { signedIn: true },
    handler: ({ actor }): Me => ({ ...actor, permissions: permissionsOf(actor) }),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/auth/sign-out',
    access: { public: true },
    handler: async ({ req, reply }) => {
      if (req.sessionHash) {
        await ctx.db.transaction().execute(async (trx) => {
          await endSession(trx, req.sessionHash!);
          if (req.actor) await appendAudit(trx, req.actor, { action: 'auth.signed_out', entity: 'user', entityId: req.actor.id });
        });
      }
      clearSessionCookie(reply, config);
      return undefined;
    },
  });

  if (ctx.oidc) {
    const provider = ctx.oidc;
    route(app, ctx, {
      method: 'GET',
      url: '/api/auth/google/start',
      access: { public: true },
      rateLimitPerMinute: AUTH_RATE,
      query: z.object({ returnTo: z.string().max(400).optional() }),
      handler: async ({ reply, query }) => {
        const flow = newToken();
        const state = newToken();
        const nonce = newToken();
        const verifier = randomPkceVerifier();
        await ctx.db
          .insertInto('auth_logins')
          .values({ flow_hash: keyedHash(config.sessionSecret, flow), state, nonce, code_verifier: verifier, return_to: safeReturnPath(query.returnTo) })
          .execute();
        reply.setCookie(loginCookieName(config), flow, { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge: LOGIN_TTL_MS / 1000 });
        const url = await provider.authorizationUrl({ redirectUri: redirectUri(ctx), state, nonce, codeChallenge: await pkceChallenge(verifier) });
        return reply.redirect(url.href, 302);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/api/auth/google/callback',
      access: { public: true },
      rateLimitPerMinute: AUTH_RATE,
      query: z.object({ code: z.string().max(4096).optional(), state: z.string().max(512).optional(), error: z.string().max(200).optional() }).loose(),
      handler: async ({ req, reply, query }) => {
        const flow = req.cookies[loginCookieName(config)];
        reply.clearCookie(loginCookieName(config), { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' });
        if (!flow || !/^[A-Za-z0-9_-]{43}$/.test(flow)) return refuse(req, reply, ctx, 'flow_missing');
        // One use only: the record is deleted as it is read.
        const login = await ctx.db.deleteFrom('auth_logins').where('flow_hash', '=', keyedHash(config.sessionSecret, flow)).returningAll().executeTakeFirst();
        if (!login || Date.now() - login.created_at.getTime() > LOGIN_TTL_MS) return refuse(req, reply, ctx, 'flow_expired');
        if (query.error) return reply.redirect(appUrl(ctx, '/sign-in'), 303); // cancelled at Google: back to the sign-in page
        const s = Buffer.from(query.state ?? '');
        const e = Buffer.from(login.state);
        if (!query.code || s.length !== e.length || !timingSafeEqual(s, e)) return refuse(req, reply, ctx, 'state_mismatch');
        let identity;
        try {
          const claims = await provider.exchange({
            callbackUrl: new URL(req.url, config.publicUrl),
            redirectUri: redirectUri(ctx),
            codeVerifier: login.code_verifier,
            state: login.state,
            nonce: login.nonce,
          });
          identity = checkClaims(claims, { issuer: provider.issuer, clientId: provider.clientId, nonce: login.nonce });
        } catch (err) {
          return refuse(req, reply, ctx, err instanceof SignInRefused ? err.reason : `provider_error:${(err as Error).name}`);
        }
        try {
          await ctx.db.transaction().execute(async (trx) => {
            const actor = await admitUser(trx, ctx, identity);
            await startSession(req, reply, ctx, actor, 'google', trx);
          });
        } catch (err) {
          if (err instanceof SignInRefused) return refuse(req, reply, ctx, err.reason);
          throw err;
        }
        purgeExpired(ctx.db, config).catch(() => {});
        return reply.redirect(appUrl(ctx, login.return_to), 303);
      },
    });
  }

  if (config.devSignIn) {
    route(app, ctx, {
      method: 'GET',
      url: '/api/auth/dev/users',
      access: { public: true },
      handler: async (): Promise<DevUser[]> =>
        ctx.db.selectFrom('users').select(['email', 'name', 'role']).where('active', '=', true).orderBy('role').orderBy('email').limit(50).execute(),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/api/auth/dev/sign-in',
      access: { public: true },
      // Development and tests only (refused in production, AUTH-6): the end-to-end suite signs in
      // many browser contexts from one address at once.
      rateLimitPerMinute: 1000,
      body: z.object({ email: z.email().max(254), returnTo: z.string().max(400).optional() }).strict(),
      handler: async ({ req, reply, body }) => {
        try {
          await ctx.db.transaction().execute(async (trx) => {
            const actor = await admitUser(trx, ctx, { email: body.email, sub: null, name: null });
            await startSession(req, reply, ctx, actor, 'dev', trx);
          });
        } catch (err) {
          if (err instanceof SignInRefused) {
            req.log.info({ signIn: 'refused', reason: err.reason }, 'sign-in refused');
            throw new ApiError(403, 'forbidden', 'This account does not have access.');
          }
          throw err;
        }
        return { returnTo: safeReturnPath(body.returnTo) };
      },
    });
  }
}
