// LIVE-1…LIVE-8, FLOW-10…FLOW-25, FLOW-31, FLOW-32, HOST-6, AUD-4: the API of a running interview.
// Every route is round-scoped (server/http/route.ts): the round is found from the interview or record
// in the URL, in the database; people not on the round get 404; server/authz/policy.ts decides the
// rest (reviewers get nothing, ROUND-5 closes a closed round). The service then checks the finer
// rules: being on the panel, owning the record (LIVE-1), and what the round lets each reader see (LIVE-3).
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import type { Tx } from '../db/pool';
import * as live from './service';

const INTERVIEW = z.object({ id: z.uuid() }).strict();
const SCORE = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const RECOMMENDATION = z.enum(['strong_hire', 'hire', 'lean_no_hire', 'no_hire']);
const QID = z.string().min(1).max(40);
const TEXT = z.string().max(20_000);
const BY = z.string().max(200).nullable();
const INDEX = z.number().int().min(0).max(99);
const SCORING_WITH = z.array(z.uuid()).max(11).optional();

/** RES-1: one change to my record; strict shapes (unknown fields are refused). */
const OP = z.discriminatedUnion('t', [
  z.object({ t: z.literal('score'), q: QID, v: SCORE.nullable() }).strict(),
  z.object({ t: z.literal('kp'), q: QID, i: INDEX, on: z.boolean() }).strict(),
  z.object({ t: z.literal('rf'), q: QID, i: INDEX, on: z.boolean() }).strict(),
  z.object({ t: z.literal('probe'), q: QID, on: z.boolean() }).strict(),
  z.object({ t: z.literal('flag'), q: QID, on: z.boolean() }).strict(),
  z.object({ t: z.literal('skip'), q: QID, reason: z.string().max(2000) }).strict(),
  z.object({ t: z.literal('unskip'), q: QID }).strict(),
  z.object({ t: z.literal('note.add'), id: z.uuid(), q: QID, atSec: z.number().int().min(0).max(7 * 86_400), text: TEXT, by: BY }).strict(),
  z.object({ t: z.literal('note.edit'), id: z.uuid(), text: TEXT, by: BY.optional() }).strict(),
  z.object({ t: z.literal('note.del'), id: z.uuid() }).strict(),
  z.object({ t: z.literal('overall'), rating: SCORE.nullable().optional(), recommendation: RECOMMENDATION.nullable().optional(), rationale: TEXT.optional() }).strict(),
]);

const COMMAND = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), from: QID, to: QID }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('lead') }).strict(),
]);

const uuid = (v: string | undefined) => !!v && z.uuid().safeParse(v).success;

/** The round of the interview in the URL, from the database (cancelled interviews do not exist). */
const roundOfInterview = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!uuid(id)) return null;
  return (await ctx.db.selectFrom('interviews').select('round_id').where('id', '=', id!).where('state', '!=', 'cancelled').executeTakeFirst())?.round_id ?? null;
};
/** The round of the record in the URL, through its interview. */
const roundOfRecord = async (req: FastifyRequest, ctx: AppContext) => {
  const id = (req.params as { id?: string }).id;
  if (!uuid(id)) return null;
  return (
    (await ctx.db
      .selectFrom('records as r')
      .innerJoin('interviews as i', 'i.id', 'r.interview_id')
      .select('i.round_id')
      .where('r.id', '=', id!)
      .where('i.state', '!=', 'cancelled')
      .executeTakeFirst())?.round_id ?? null
  );
};

export function registerInterviewRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tx = <T>(fn: (trx: Tx) => Promise<T>) => ctx.db.transaction().execute(fn);

  // ---- Reading (round members; LIVE-3 filters others' marks per reader)
  route(app, ctx, {
    method: 'GET',
    url: '/api/interviews/:id/live',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: INTERVIEW,
    handler: ({ actor, params, round }) => live.loadLiveState(ctx.db, actor, params.id, round!),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/interviews/:id/records',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: INTERVIEW,
    handler: ({ actor, params }) => live.loadLiveRecords(ctx.db, actor, params.id),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/interviews/:id/present',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: INTERVIEW,
    handler: ({ params }) => live.presentView(ctx.db, params.id),
  });

  // ---- Starting, joining, presence (FLOW-10, LIVE-6, LIVE-8, LIVE-3)
  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/start',
    access: { round: 'interview.take_part', roundOf: roundOfInterview },
    params: INTERVIEW,
    // FLOW-7, PRIV-4: the person starting confirms the candidate has been told.
    body: z.object({ consent: z.literal(true), scoringWith: SCORING_WITH }).strict(),
    handler: async ({ actor, params, body, round }) => {
      const r = await tx((trx) => live.startInterview(trx, actor, params.id, round!, body));
      return { ...r, state: await live.loadLiveState(ctx.db, actor, params.id, round!) };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/join',
    access: { round: 'interview.take_part', roundOf: roundOfInterview },
    params: INTERVIEW,
    body: z.object({ scoringWith: SCORING_WITH }).strict(),
    handler: async ({ actor, params, body, round }) => {
      const recordId = await tx((trx) => live.joinInterview(trx, actor, params.id, body));
      return { recordId, state: await live.loadLiveState(ctx.db, actor, params.id, round!) };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/command',
    access: { round: 'interview.take_part', roundOf: roundOfInterview },
    params: INTERVIEW,
    body: COMMAND,
    rateLimitPerMinute: 300,
    rateLimitBy: 'person',
    handler: async ({ actor, params, body, round }) => {
      await tx((trx) => live.command(trx, actor, params.id, body));
      return live.loadLiveState(ctx.db, actor, params.id, round!);
    },
  });

  // LIVE-3: a heartbeat every 15 seconds while the screen is open (and when it closes); limited per person.
  route(app, ctx, {
    method: 'POST',
    url: '/api/interviews/:id/presence',
    access: { round: 'round.read', roundOf: roundOfInterview },
    params: INTERVIEW,
    body: z.object({ here: z.boolean() }).strict(),
    rateLimitPerMinute: 30,
    rateLimitBy: 'person',
    handler: async ({ actor, params, body }) => {
      await tx((trx) => live.heartbeat(trx, actor, params.id, body.here));
      return undefined;
    },
  });

  // LIVE-4: an organiser marks a panel member who never joined as "did not take part" (or takes it back).
  route(app, ctx, {
    method: 'PUT',
    url: '/api/interviews/:id/panel/:userId',
    access: { round: 'round.plan', roundOf: roundOfInterview },
    params: z.object({ id: z.uuid(), userId: z.uuid() }).strict(),
    body: z.object({ didNotTakePart: z.boolean() }).strict(),
    handler: async ({ actor, params, body, round }) => {
      await tx((trx) => live.markPanel(trx, actor, params.id, params.userId, body.didNotTakePart));
      return live.loadLiveState(ctx.db, actor, params.id, round!);
    },
  });

  // ---- My record (LIVE-1: the service refuses anyone but its owner)
  route(app, ctx, {
    method: 'POST',
    url: '/api/records/:id/ops',
    access: { round: 'interview.take_part', roundOf: roundOfRecord },
    params: INTERVIEW,
    body: z.object({ ops: z.array(OP).min(1).max(200) }).strict(),
    bodyLimit: 1_000_000,
    // RES-1: autosave sends a batch per change (typing is batched in the browser), limited per person.
    rateLimitPerMinute: 600,
    rateLimitBy: 'person',
    handler: ({ actor, params, body }) => tx((trx) => live.applyOps(trx, actor, params.id, body.ops)),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/records/:id/submit',
    access: { round: 'interview.take_part', roundOf: roundOfRecord },
    params: INTERVIEW,
    handler: async ({ actor, params }) => {
      await tx((trx) => live.submitRecord(trx, actor, params.id));
      return live.loadScorecard(ctx.db, actor, params.id);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/records/:id/amend',
    access: { round: 'record.amend', roundOf: roundOfRecord },
    params: INTERVIEW,
    body: z
      .object({
        reason: z.string().max(2000),
        question: z
          .object({
            id: QID,
            score: SCORE.nullable().optional(),
            notes: z.array(z.object({ id: z.uuid().optional(), atSec: z.number().int().min(0).max(7 * 86_400), text: TEXT, by: BY.optional() }).strict()).max(200).optional(),
          })
          .strict()
          .optional(),
        overall: z.object({ rating: SCORE.nullable().optional(), recommendation: RECOMMENDATION.nullable().optional(), rationale: TEXT.optional() }).strict().optional(),
      })
      .strict(),
    handler: ({ actor, params, body }) => tx((trx) => live.amendRecord(trx, actor, params.id, body)),
  });

  // ---- Scorecards (FLOW-24, FLOW-31, FLOW-32)
  route(app, ctx, {
    method: 'GET',
    url: '/api/records/:id',
    access: { round: 'round.read', roundOf: roundOfRecord },
    params: INTERVIEW,
    handler: ({ actor, params }) => live.loadScorecard(ctx.db, actor, params.id),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/records/:id/exported',
    access: { round: 'round.read', roundOf: roundOfRecord },
    params: INTERVIEW,
    body: z.object({ format: z.enum(['markdown', 'csv', 'print']) }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx((trx) => live.recordExported(trx, actor, params.id, body.format));
      return undefined;
    },
  });
}
