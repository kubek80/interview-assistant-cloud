// How every API route is declared (AUTH-5). A route names who may call it (`access`) and the
// shape of its input (zod schemas for params, query and body); this helper signs the request in
// from its session cookie, checks the permission through server/authz/policy.ts, validates the
// input and only then runs the handler with typed, parsed values. Unknown body fields are rejected
// (no mass assignment). A route registered any other way is refused at startup (see app.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z } from 'zod';
import { can, canInRound, type Actor, type GlobalAction, type RoundAccess, type RoundAction } from '../authz/policy';
import { lookupSession, sessionTokenOf } from '../auth/sessions';
import { ApiError, forbidden, notFound, notSignedIn, zodDetails } from './errors';
import type { AppContext } from '../context';

/** Who may call a route. There is no default: every route says. */
export type Access =
  /** Anyone, signed in or not (health check, sign-in endpoints). */
  | { public: true }
  /** Any signed-in, active user. */
  | { signedIn: true }
  /** A global permission from the policy (USER-2); with a list, any one of them. */
  | { action: GlobalAction | readonly GlobalAction[] }
  /**
   * A permission on one round (ROUND-2). `roundOf` finds the round the target belongs to, from
   * the database, never from the request body (no IDOR): e.g. the round of the interview in the
   * URL. Unknown targets and rounds the actor is not on both answer 404, so ids cannot be probed.
   */
  | { round: RoundAction; roundOf: (req: FastifyRequest, ctx: AppContext) => Promise<string | null> };

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    sessionHash: Buffer | null;
    /** Set for round-scoped routes once access is granted. */
    round: RoundAccess | null;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}

export interface Handled<P, Q, B> {
  req: FastifyRequest;
  reply: FastifyReply;
  ctx: AppContext;
  /** The signed-in actor (null only on public routes). */
  actor: Actor;
  params: P;
  query: Q;
  body: B;
  round: RoundAccess | null;
}

export interface RouteDef<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  method: HTTPMethods;
  url: string;
  access: Access;
  params?: P;
  query?: Q;
  body?: B;
  /** Bytes; default 100 kB (server-wide limit in app.ts). */
  bodyLimit?: number;
  /** Rate limit for this route: requests per minute per client address. */
  rateLimitPerMinute?: number;
  handler: (h: Handled<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<unknown> | unknown;
}

const EMPTY = z.object({}).strict();

export function describeAccess(a: Access): string {
  if ('public' in a) return 'public';
  if ('signedIn' in a) return 'signedIn';
  if ('action' in a) return [a.action].flat().join('|');
  return `round:${a.round}`;
}

/** Loads the actor's place in a round (null when the round does not exist). */
export async function loadRoundAccess(ctx: AppContext, actorId: string, roundId: string): Promise<RoundAccess | null> {
  if (!z.uuid().safeParse(roundId).success) return null;
  const row = await ctx.db
    .selectFrom('rounds as r')
    .leftJoin('round_members as m', (j) => j.onRef('m.round_id', '=', 'r.id').on('m.user_id', '=', actorId))
    .select(['r.id', 'r.state', 'm.role'])
    .where('r.id', '=', roundId)
    .executeTakeFirst();
  return row ? { roundId: row.id, state: row.state, memberRole: row.role ?? null } : null;
}

/** Signs the request in from its session cookie (sets req.actor), without checking any permission. */
export async function authenticate(req: FastifyRequest, ctx: AppContext): Promise<Actor | null> {
  if (req.actor !== undefined && req.actor !== null) return req.actor;
  const found = await lookupSession(ctx.db, ctx.config, sessionTokenOf(req, ctx.config));
  req.actor = found?.actor ?? null;
  req.sessionHash = found?.idHash ?? null;
  return req.actor;
}

export async function checkAccess(req: FastifyRequest, ctx: AppContext, access: Access): Promise<void> {
  if ('public' in access) {
    await authenticate(req, ctx);
    return;
  }
  const actor = await authenticate(req, ctx);
  if (!actor) throw notSignedIn();
  if ('signedIn' in access) return;
  if ('action' in access) {
    if (![access.action].flat().some((x) => can(actor, x))) throw forbidden();
    return;
  }
  const roundId = await access.roundOf(req, ctx);
  const round = roundId ? await loadRoundAccess(ctx, actor.id, roundId) : null;
  // Not on the round (and not an administrator): answer as if it did not exist.
  if (!round || (actor.role !== 'admin' && !round.memberRole)) throw notFound();
  if (!canInRound(actor, access.round, round)) throw forbidden();
  req.round = round;
}

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, what: string): z.infer<T> {
  const s: z.ZodType = schema ?? EMPTY;
  const r = s.safeParse(value ?? {});
  if (!r.success) throw new ApiError(400, 'invalid', what === 'body' ? 'Some of the details are not valid.' : `The ${what} is not valid.`, zodDetails(r.error));
  return r.data as z.infer<T>;
}

/** Fixed-window rate limiter per client address and route (per instance; see docs/deploy). */
export class RateLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  check(key: string, perMinute: number, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
      this.hits.set(key, { n: 1, until: now + 60_000 });
      return true;
    }
    h.n += 1;
    return h.n <= perMinute;
  }
}

export function route<P extends z.ZodType = typeof EMPTY, Q extends z.ZodType = typeof EMPTY, B extends z.ZodType = typeof EMPTY>(
  app: FastifyInstance,
  ctx: AppContext,
  def: RouteDef<P, Q, B>,
): void {
  if (!def.access) throw new Error(`Route ${def.method} ${def.url} has no access rule`);
  app.route({
    method: def.method,
    url: def.url,
    bodyLimit: def.bodyLimit,
    config: { access: def.access },
    preHandler: async (req) => {
      if (def.rateLimitPerMinute && !ctx.rateLimiter.check(`${def.url}|${req.ip}`, def.rateLimitPerMinute)) {
        throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
      }
      await checkAccess(req, ctx, def.access);
    },
    handler: async (req, reply) => {
      const params = parse(def.params, req.params, 'address');
      const query = parse(def.query, req.query, 'query');
      const body = parse(def.body, req.body, 'body');
      const result = await def.handler({ req, reply, ctx, actor: req.actor as Actor, params, query, body, round: req.round });
      if (reply.sent) return reply;
      if (result === undefined) return reply.status(reply.statusCode === 200 ? 204 : reply.statusCode).send();
      return reply.send(result);
    },
  });
}
