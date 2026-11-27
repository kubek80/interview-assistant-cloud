// LIVE-9, TEAM-6…TEAM-12, SUM-1…SUM-6, ROUND-5, ROUND-6: the API of the debrief, the panel decision,
// judgements entered on someone's behalf, written summaries, the Summary and the round report.
//
// Round-scoped routes find their round from the interview, record or candidate in the URL, in the
// database (no IDOR); people not on the round get 404; server/authz/policy.ts decides the rest: the
// round-level permission here, and canOnInterview() in the service for "organisers and this
// interview's panel". Reviewers hold no interview data and are refused everything (REVIEW-1). The
// cross-round Summary and the report check every round against the same policy (visibleRounds).
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import type { Tx } from '../db/pool';
import * as panel from './service';

const ID = z.object({ id: z.uuid() }).strict();
const SCORE = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const RECOMMENDATION = z.enum(['strong_hire', 'hire', 'lean_no_hire', 'no_hire']);
const QID = z.string().min(1).max(40);
const REASON = z.string().max(2000).optional();

const uuid = (v: string | undefined) => !!v && z.uuid().safeParse(v).success;

/** The round of the interview in the URL (cancelled interviews do not exist). */
const roundOfInterview = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!uuid(id)) return null;
  return (await ctx.db.selectFrom('interviews').select('round_id').where('id', '=', id!).where('state', '!=', 'cancelled').executeTakeFirst())?.round_id ?? null;
};
/** The round of the record in the URL, through its interview. */
const roundOfRecord = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!uuid(id)) return null;
  return (await ctx.db.selectFrom('records as r').innerJoin('interviews as i', 'i.id', 'r.interview_id').select('i.round_id').where('r.id', '=', id!).where('i.state', '!=', 'cancelled').executeTakeFirst())?.round_id ?? null;
};
/** The round of the candidate in the URL. */
const roundOfCandidate = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!uuid(id)) return null;
  return (await ctx.db.selectFrom('candidates').select('round_id').where('id', '=', id!).executeTakeFirst())?.round_id ?? null;
};
const roundOfParam = async (req: FastifyRequest) => (req.params as { roundId?: string }).roundId ?? null;

const DECISION = z
  .object({
    recommendation: RECOMMENDATION,
    rationale: z.string().max(20_000),
    participants: z.array(z.object({ userId: z.uuid().nullable(), name: z.string().max(400) }).strict()).max(40),
    rating: SCORE.nullable(),
    scores: z.record(QID, SCORE),
    reason: REASON,
    baseVersion: z.number().int().min(1).nullable(),
  })
  .strict();

const ENTERED = z
  .object({
    forUserId: z.uuid().nullable(),
    name: z.string().max(400).nullable(),
    rating: SCORE,
    recommendation: RECOMMENDATION,
    rationale: z.string().max(20_000),
    scores: z.record(QID, SCORE),
    notes: z.record(QID, z.string().max(4000)),
    reason: REASON,
  })
  .strict();

export function registerPanelRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tx = <T>(fn: (trx: Tx) => Promise<T>) => ctx.db.transaction().execute(fn);

  // ---- Reading
  // LIVE-9, SUM-3: the debrief and the candidate page of one interview, as this reader may see it.
  route(app, ctx, {
    method: 'GET',
    url: '/api/interviews/:id/debrief',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: ID,
    handler: ({ actor, params, round }) => panel.loadDebrief(ctx.db, actor, round!, params.id),
  });

  // SUM-1, SUM-2, ROUND-6: one round's Summary.
  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId/summary',
    access: { round: 'round.read', roundOf: roundOfParam },
    params: z.object({ roundId: z.uuid() }).strict(),
    handler: ({ actor, params }) => panel.summary(ctx.db, actor, params.roundId),
  });

  // ROUND-6: the Summary across every round the reader can see (each checked by the policy).
  route(app, ctx, {
    method: 'GET',
    url: '/api/summary',
    access: { action: 'rounds.list' },
    handler: ({ actor }) => panel.summary(ctx.db, actor, 'all'),
  });

  // SUM-5: the round report of the rows shown (Markdown, CSV, or the print layout's data); audited.
  route(app, ctx, {
    method: 'POST',
    url: '/api/summary/report',
    access: { action: 'rounds.list' },
    body: z.object({ format: z.enum(['markdown', 'csv', 'print']), interviewIds: z.array(z.uuid()).min(1).max(1000), scope: z.string().max(400) }).strict(),
    bodyLimit: 200_000,
    handler: ({ actor, body }) => tx((trx) => panel.report(trx, actor, body)),
  });

  // ---- The panel decision (TEAM-9…TEAM-11)
  route(app, ctx, {
    method: 'PUT',
    url: '/api/interviews/:id/decision',
    access: { round: 'panel.decide', roundOf: roundOfInterview },
    params: ID,
    body: DECISION,
    handler: ({ actor, params, body, round }) => tx((trx) => panel.saveDecision(trx, actor, round!, params.id, body)),
  });

  // ---- Judgements entered on someone's behalf (TEAM-7, TEAM-8)
  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/judgements',
    access: { round: 'panel.enter', roundOf: roundOfInterview },
    params: ID,
    body: ENTERED,
    handler: async ({ actor, params, body, round, reply }) => {
      const id = await tx((trx) => panel.enterJudgement(trx, actor, round!, params.id, body));
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/records/:id/entered',
    access: { round: 'round.read', roundOf: roundOfRecord },
    params: ID,
    handler: ({ actor, params }) => panel.enteredInput(ctx.db, actor, params.id),
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/records/:id/entered',
    access: { round: 'panel.enter', roundOf: roundOfRecord },
    params: ID,
    body: ENTERED.omit({ forUserId: true, name: true }).extend({ reason: z.string().max(2000) }).strict(),
    handler: async ({ actor, params, body, round }) => {
      await tx((trx) => panel.correctEntered(trx, actor, round!, params.id, { ...body, forUserId: null, name: null }));
      return undefined;
    },
  });

  // TEAM-8: organisers (and administrators) remove an entered judgement, with a reason.
  route(app, ctx, {
    method: 'POST',
    url: '/api/records/:id/remove',
    access: { round: 'round.decide', roundOf: roundOfRecord },
    params: ID,
    body: z.object({ reason: z.string().max(2000) }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => panel.removeEntered(trx, actor, params.id, body.reason));
      return undefined;
    },
  });

  // ---- The written summary (SUM-4)
  route(app, ctx, {
    method: 'PUT',
    url: '/api/candidates/:id/summary',
    access: { round: 'panel.summary', roundOf: roundOfCandidate },
    params: ID,
    body: z.object({ text: z.string().max(20_000), baseVersion: z.number().int().min(1).nullable(), reason: REASON }).strict(),
    // Saved as it is typed (debounced in the browser); limited per person.
    rateLimitPerMinute: 240,
    rateLimitBy: 'person',
    handler: ({ actor, params, body, round }) => tx((trx) => panel.saveSummary(trx, actor, round!, params.id, body)),
  });
}
