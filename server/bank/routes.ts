// DB-1…DB-4, BANK-1, BANK-2, BANK-7…BANK-15: the question bank API. Everyone signed in reads it;
// organisers and administrators edit it (USER-2); administrators upload track and CSV files (DB-3).
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { notFound } from '../http/errors';
import * as bank from './service';
import { importQuestions, MAX_IMPORT_FILES } from './import';
import { DIFFICULTIES, QUESTION_TYPES } from '../../src/domain/types';

const TRACK_ID = z.string().regex(/^[a-z][a-z0-9]{0,29}$/, 'Not a track id.');
const QUESTION_ID = z.string().regex(/^[a-z][a-z0-9]{0,29}-\d{1,6}$/, 'Not a question id.');
const CATEGORY_ID = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(200);
const TEXT_LIST = z.array(z.string().max(5000)).max(60);
const RUBRIC = z.object({ '1': z.string().max(5000).optional(), '2': z.string().max(5000).optional(), '3': z.string().max(5000).optional(), '4': z.string().max(5000).optional() }).strict().nullable();

export const DRAFT = z
  .object({
    text: z.string().max(5000),
    description: z.string().max(10000),
    categoryId: z.string().max(200),
    difficulty: z.enum(DIFFICULTIES as ['core', 'advanced', 'expert']),
    type: z.enum(QUESTION_TYPES as ['knowledge', 'scenario', 'design', 'behavioural']),
    timeMin: z.number().int().min(0).max(1000),
    lookFor: TEXT_LIST,
    redFlags: TEXT_LIST,
    probes: TEXT_LIST,
    rubricOverride: RUBRIC,
  })
  .strict();

const CATEGORY_INPUT = z.object({ name: z.string().max(500), weight: z.number().min(0).max(100).optional(), mustHave: z.boolean().optional() }).strict();

export function registerBankRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tx = <T>(fn: (trx: import('../db/pool').Tx) => Promise<T>) => ctx.db.transaction().execute(fn);

  route(app, ctx, { method: 'GET', url: '/api/bank/tracks', access: { action: 'bank.read' }, handler: () => bank.listTracks(ctx.db) });

  route(app, ctx, {
    method: 'GET',
    url: '/api/bank/tracks/:trackId',
    access: { action: 'bank.read' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    handler: async ({ params }) => (await bank.loadTrackBank(ctx.db, params.trackId)) ?? Promise.reject(notFound('That track')),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/check',
    access: { action: 'bank.edit' },
    body: z.object({ id: z.string().max(100), name: z.string().max(500), version: z.string().max(40).optional() }).strict(),
    handler: ({ body }) => bank.newTrackProblems(ctx.db, body),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks',
    access: { action: 'bank.edit' },
    body: z.object({ id: z.string().max(100), name: z.string().max(500), version: z.string().max(40).optional(), firstCategory: CATEGORY_INPUT }).strict(),
    handler: async ({ actor, body, reply }) => {
      const id = await tx((trx) => bank.createTrack(trx, actor, body));
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/:trackId/questions',
    access: { action: 'bank.edit' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    body: z.object({ draft: DRAFT, newCategory: CATEGORY_INPUT.optional() }).strict(),
    handler: async ({ actor, params, body, reply }) => {
      const r = await tx((trx) => bank.saveQuestion(trx, actor, { trackId: params.trackId, draft: body.draft, newCategory: body.newCategory }));
      reply.status(201);
      return r;
    },
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/bank/questions/:questionId',
    access: { action: 'bank.edit' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    body: z.object({ draft: DRAFT, newCategory: CATEGORY_INPUT.optional() }).strict(),
    handler: async ({ actor, params, body }) => {
      const q = await ctx.db.selectFrom('questions').select('track_id').where('id', '=', params.questionId).executeTakeFirst();
      if (!q) throw notFound('That question');
      return tx((trx) => bank.saveQuestion(trx, actor, { trackId: q.track_id, id: params.questionId, draft: body.draft, newCategory: body.newCategory }));
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/:trackId/questions/bulk',
    access: { action: 'bank.edit' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    bodyLimit: 5_000_000,
    body: z.object({ drafts: z.array(DRAFT).min(1).max(500), newCategories: z.array(z.object({ id: z.string().max(200), name: z.string().max(500) }).strict()).max(200).default([]) }).strict(),
    handler: async ({ actor, params, body, reply }) => {
      const r = await tx((trx) => bank.bulkAdd(trx, actor, params.trackId, body.drafts, body.newCategories));
      reply.status(201);
      return r;
    },
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/bank/questions/:questionId/status',
    access: { action: 'bank.edit' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    body: z.object({ status: z.enum(['active', 'retired']) }).strict(),
    handler: async ({ actor, params, body }) => tx((trx) => bank.setQuestionStatus(trx, actor, params.questionId, body.status)),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/bank/questions/:questionId/versions',
    access: { action: 'bank.read' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    handler: async ({ params }) => {
      const rows = await ctx.db.selectFrom('question_versions').select(['version', 'snapshot', 'created_at', 'source']).where('question_id', '=', params.questionId).orderBy('version', 'desc').execute();
      if (!rows.length) throw notFound('That question');
      return rows.map((r) => ({ version: r.version, question: r.snapshot, createdAt: r.created_at.toISOString(), source: r.source }));
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/:trackId/categories',
    access: { action: 'bank.edit' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    body: CATEGORY_INPUT,
    handler: async ({ actor, params, body, reply }) => {
      const id = await tx((trx) => bank.addCategory(trx, actor, params.trackId, body));
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/bank/categories/:categoryId',
    access: { action: 'bank.edit' },
    params: z.object({ categoryId: CATEGORY_ID }).strict(),
    body: CATEGORY_INPUT.partial(),
    handler: async ({ actor, params, body }) => tx((trx) => bank.updateCategory(trx, actor, params.categoryId, body)),
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/api/bank/categories/:categoryId',
    access: { action: 'bank.edit' },
    params: z.object({ categoryId: CATEGORY_ID }).strict(),
    handler: async ({ actor, params }) => tx((trx) => bank.removeCategory(trx, actor, params.categoryId)),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/:trackId/export',
    access: { action: 'bank.edit' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    body: z.object({ version: z.string().max(40).optional() }).strict(),
    handler: async ({ actor, params, body }) => tx((trx) => bank.exportTrackFile(trx, actor, params.trackId, body)),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/tracks/:trackId/export-csv',
    access: { action: 'bank.read' },
    params: z.object({ trackId: TRACK_ID }).strict(),
    handler: async ({ actor, params }) => tx((trx) => bank.exportTrackCsv(trx, actor, params.trackId)),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/import',
    access: { action: 'bank.import' },
    bodyLimit: 12_000_000,
    body: z
      .object({
        files: z.array(z.object({ name: z.string().min(1).max(200), text: z.string().max(5_000_000), trackId: TRACK_ID.optional() }).strict()).min(1).max(MAX_IMPORT_FILES),
        dryRun: z.boolean(),
      })
      .strict(),
    handler: async ({ actor, body }) => importQuestions(ctx.db, actor, body.files, { dryRun: body.dryRun }),
  });
}
