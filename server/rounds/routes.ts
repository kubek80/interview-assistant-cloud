// ROUND-1…ROUND-5, FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15: the API for hiring rounds, their teams and
// question sets, and the interviews planned in them. Every route inside a round is round-scoped
// (server/http/route.ts): the round is found from the target in the database, people who are not on
// the round get 404, and server/authz/policy.ts decides the rest (interviewers read; the round's
// organisers and administrators manage and plan; a closed round refuses planning, ROUND-5).
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { toEntry } from '../audit/routes';
import * as rounds from './service';

const ROUND = z.object({ roundId: z.uuid() }).strict();
const INTERVIEW = z.object({ id: z.uuid() }).strict();
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-01.');
const TIME = z.string().regex(/^\d{2}:\d{2}$/, 'Use a time like 14:30.');
const PANEL = z.array(z.uuid()).max(50);
const SET = z
  .object({
    questionIds: z.array(z.string().max(40)).max(100),
    categories: z.array(z.object({ id: z.string().max(200), weight: z.number().min(0.1).max(10), mustHave: z.boolean() }).strict()).max(100),
    timeBudgetMin: z.number().int().min(1).max(600),
    name: z.string().max(200).optional(),
  })
  .strict();

/** The round a target belongs to, from the database (never from the request body). */
const roundOfParam = async (req: FastifyRequest) => (req.params as { roundId?: string }).roundId ?? null;
const roundOfInterview = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!id || !z.uuid().safeParse(id).success) return null;
  return (await ctx.db.selectFrom('interviews').select('round_id').where('id', '=', id).where('state', '!=', 'cancelled').executeTakeFirst())?.round_id ?? null;
};
const roundOfSet = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!id || !z.uuid().safeParse(id).success) return null;
  return (await ctx.db.selectFrom('question_sets').select('round_id').where('id', '=', id).executeTakeFirst())?.round_id ?? null;
};

export function registerRoundRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tx = <T>(fn: (trx: import('../db/pool').Tx) => Promise<T>) => ctx.db.transaction().execute(fn);

  // ---- Rounds
  route(app, ctx, { method: 'GET', url: '/api/rounds', access: { action: 'rounds.list' }, handler: ({ actor }) => rounds.listRounds(ctx.db, actor) });

  route(app, ctx, {
    method: 'POST',
    url: '/api/rounds',
    access: { action: 'rounds.create' },
    body: z.object({ name: z.string().max(200), trackId: z.string().max(30), requisitionId: z.string().max(60).nullable().optional() }).strict(),
    handler: async ({ actor, body, reply }) => {
      const id = await tx((trx) => rounds.createRound(trx, actor, body));
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId',
    access: { round: 'round.read', roundOf: roundOfParam },
    params: ROUND,
    handler: ({ actor, params }) => rounds.loadRound(ctx.db, actor, params.roundId),
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/rounds/:roundId',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: ROUND,
    body: z
      .object({ name: z.string().max(200).optional(), requisitionId: z.string().max(60).nullable().optional(), retentionUntil: DAY.optional(), hideOthersScores: z.boolean().optional() })
      .strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.updateRound(trx, actor, params.roundId, body));
      return rounds.loadRound(ctx.db, actor, params.roundId);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/rounds/:roundId/close',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: ROUND,
    body: z.object({ reason: z.string().max(2000).optional() }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.closeRound(trx, actor, params.roundId, body.reason ?? null));
      return rounds.loadRound(ctx.db, actor, params.roundId);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/rounds/:roundId/reopen',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: ROUND,
    body: z.object({ reason: z.string().max(2000) }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.reopenRound(trx, actor, params.roundId, body.reason));
      return rounds.loadRound(ctx.db, actor, params.roundId);
    },
  });

  // HPRIV-4: a round's organisers (and administrators) read its audit entries.
  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId/audit',
    access: { round: 'round.audit', roundOf: roundOfParam },
    params: ROUND,
    handler: async ({ params }) =>
      (await ctx.db.selectFrom('audit_events').select(['id', 'at', 'actor_label', 'action', 'entity', 'entity_id', 'before', 'after', 'reason']).where('round_id', '=', params.roundId).orderBy('id', 'desc').limit(200).execute()).map(toEntry),
  });

  // ---- Team (ROUND-2)
  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId/team-options',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: ROUND,
    handler: () => rounds.teamOptions(ctx.db),
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/rounds/:roundId/members/:userId',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: z.object({ roundId: z.uuid(), userId: z.uuid() }).strict(),
    body: z.object({ role: z.enum(['organiser', 'interviewer']) }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.setMember(trx, actor, params.roundId, params.userId, body.role));
      return rounds.roundTeam(ctx.db, params.roundId);
    },
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/api/rounds/:roundId/members/:userId',
    access: { round: 'round.manage', roundOf: roundOfParam },
    params: z.object({ roundId: z.uuid(), userId: z.uuid() }).strict(),
    handler: async ({ actor, params }) => {
      await tx((trx) => rounds.removeMember(trx, actor, params.roundId, params.userId));
      return rounds.roundTeam(ctx.db, params.roundId);
    },
  });

  // ---- Question sets (ROUND-3, FLOW-2…FLOW-9)
  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId/question-set',
    access: { round: 'round.read', roundOf: roundOfParam },
    params: ROUND,
    handler: async ({ params }) => {
      const r = await ctx.db.selectFrom('rounds').select('default_question_set_id').where('id', '=', params.roundId).executeTakeFirstOrThrow();
      return rounds.loadSet(ctx.db, r.default_question_set_id!);
    },
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/rounds/:roundId/question-set',
    access: { round: 'round.plan', roundOf: roundOfParam },
    params: ROUND,
    body: SET.extend({ baseSetId: z.uuid(), baseVersion: z.number().int().min(1) }).strict(),
    handler: ({ actor, params, body }) => tx((trx) => rounds.saveRoundSet(trx, actor, params.roundId, body)),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/question-sets/:id',
    access: { round: 'round.read', roundOf: roundOfSet },
    params: INTERVIEW,
    handler: ({ params }) => rounds.loadSet(ctx.db, params.id),
  });

  // ---- Interviews (ROUND-4, TEAM-1, TEAM-2, TEAM-15)
  route(app, ctx, {
    method: 'GET',
    url: '/api/rounds/:roundId/interviews',
    access: { round: 'round.read', roundOf: roundOfParam },
    params: ROUND,
    handler: ({ actor, params }) => rounds.interviewSummaries(ctx.db, actor, { roundIds: [params.roundId] }),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/rounds/:roundId/interviews',
    access: { round: 'round.plan', roundOf: roundOfParam },
    params: ROUND,
    body: z
      .object({
        candidate: z.object({ name: z.string().max(200), requisitionId: z.string().max(200).nullable().optional() }).strict(),
        date: DAY.nullable().optional(),
        time: TIME.nullable().optional(),
        panel: PANEL,
        note: z.string().max(5000).optional(),
        recordingNotice: z.boolean().optional(),
        questions: SET.optional(),
      })
      .strict(),
    handler: async ({ actor, params, body, reply }) => {
      const id = await tx((trx) => rounds.planInterview(trx, actor, params.roundId, body));
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/rounds/:roundId/interviews/bulk',
    access: { round: 'round.plan', roundOf: roundOfParam },
    params: ROUND,
    bodyLimit: 1_000_000,
    body: z
      .object({
        lines: z
          .array(
            z
              .object({
                candidate: z.string().max(200),
                requisitionId: z.string().max(200).nullable().optional(),
                date: DAY.nullable().optional(),
                time: TIME.nullable().optional(),
                panel: PANEL,
                note: z.string().max(5000).optional(),
              })
              .strict(),
          )
          .max(200),
        recordingNotice: z.boolean().optional(),
        addToTeam: z.array(z.uuid()).max(50).optional(),
      })
      .strict(),
    handler: async ({ actor, params, body, reply }) => {
      const ids = await tx((trx) => rounds.planMany(trx, actor, params.roundId, body));
      reply.status(201);
      return { ids };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/interviews/:id',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: INTERVIEW,
    handler: ({ actor, params }) => rounds.loadInterview(ctx.db, actor, params.id),
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/interviews/:id',
    access: { round: 'round.plan', roundOf: roundOfInterview },
    params: INTERVIEW,
    body: z.object({ date: DAY.nullable().optional(), time: TIME.nullable().optional(), panel: PANEL.optional(), note: z.string().max(5000).optional(), recordingNotice: z.boolean().optional() }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.changeInterview(trx, actor, params.id, body));
      return rounds.loadInterview(ctx.db, actor, params.id);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/cancel',
    access: { round: 'round.plan', roundOf: roundOfInterview },
    params: INTERVIEW,
    body: z.object({ reason: z.string().max(2000).optional() }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => rounds.cancelInterview(trx, actor, params.id, body.reason ?? null));
      return undefined;
    },
  });

  // FLOW-1, FLOW-34, TEAM-16: the Dashboard: every interview in the rounds I am on.
  route(app, ctx, { method: 'GET', url: '/api/my/interviews', access: { action: 'rounds.list' }, handler: ({ actor }) => rounds.myInterviews(ctx.db, actor) });

  // Starting, the live state, records, answers, notes and scorecards: server/interviews/routes.ts.
  // Panel decisions, hand-entered judgements and the summary come with the debrief (next step).
}
