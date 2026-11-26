// AUTH-4: server-side sessions in PostgreSQL. The browser holds only an opaque random token in an
// HttpOnly, Secure, SameSite=Lax cookie; the database holds HMAC-SHA256(SESSION_SECRET, token), so
// neither a copy of the table nor the secret alone lets anyone sign in. Each request looks the
// session up together with the user: a deactivated or removed user, or a session idle for longer
// than the configured time, is refused at once, on every instance (HOST-5).
import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Actor } from '../authz/policy';
import type { Db, Executor } from '../db/pool';

/** Last-seen times are written at most this often, so reads stay reads. */
const TOUCH_EVERY_MS = 60_000;

export const sessionCookieName = (c: Pick<Config, 'secureCookies'>) => (c.secureCookies ? '__Host-ia_session' : 'ia_session');
export const loginCookieName = (c: Pick<Config, 'secureCookies'>) => (c.secureCookies ? '__Host-ia_login' : 'ia_login');

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function keyedHash(secret: string, token: string): Buffer {
  return createHmac('sha256', secret).update(token).digest();
}

/** A well-formed token: 43 base64url characters (32 random bytes). Anything else is not looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function createSession(db: Executor, config: Config, userId: string, method: 'google' | 'dev'): Promise<string> {
  const token = newToken();
  await db.insertInto('auth_sessions').values({ id_hash: keyedHash(config.sessionSecret, token), user_id: userId, method }).execute();
  return token;
}

export interface SessionLookup {
  actor: Actor;
  idHash: Buffer;
}

export async function lookupSession(db: Db, config: Config, token: string | undefined): Promise<SessionLookup | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const idHash = keyedHash(config.sessionSecret, token);
  const row = await db
    .selectFrom('auth_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['u.id', 'u.email', 'u.name', 'u.role', 's.last_seen_at'])
    .where('s.id_hash', '=', idHash)
    .where('u.active', '=', true)
    .where('s.last_seen_at', '>', sql<Date>`now() - make_interval(secs => ${config.sessionIdleMs / 1000})`)
    .where('s.created_at', '>', sql<Date>`now() - make_interval(secs => ${config.sessionMaxMs / 1000})`)
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > TOUCH_EVERY_MS) {
    await db.updateTable('auth_sessions').set({ last_seen_at: sql`now()` }).where('id_hash', '=', idHash).execute();
  }
  return { actor: { id: row.id, email: row.email, name: row.name, role: row.role }, idHash };
}

/** AUTH-4, USER-3: ends every session of a user (deactivated, removed, role changed by force). */
export async function revokeUserSessions(db: Executor, userId: string): Promise<number> {
  const r = await db.deleteFrom('auth_sessions').where('user_id', '=', userId).executeTakeFirst();
  return Number(r.numDeletedRows);
}

export async function endSession(db: Executor, idHash: Buffer): Promise<void> {
  await db.deleteFrom('auth_sessions').where('id_hash', '=', idHash).execute();
}

/** Housekeeping: expired sessions and abandoned sign-ins (run opportunistically at sign-in). */
export async function purgeExpired(db: Executor, config: Config): Promise<void> {
  await db
    .deleteFrom('auth_sessions')
    .where((eb) =>
      eb.or([
        eb('last_seen_at', '<', sql<Date>`now() - make_interval(secs => ${config.sessionIdleMs / 1000})`),
        eb('created_at', '<', sql<Date>`now() - make_interval(secs => ${config.sessionMaxMs / 1000})`),
      ]),
    )
    .execute();
  await db.deleteFrom('auth_logins').where('created_at', '<', sql<Date>`now() - interval '15 minutes'`).execute();
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(sessionCookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: Math.floor(config.sessionMaxMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(sessionCookieName(config), { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' });
}

export function sessionTokenOf(req: FastifyRequest, config: Config): string | undefined {
  return req.cookies[sessionCookieName(config)];
}
