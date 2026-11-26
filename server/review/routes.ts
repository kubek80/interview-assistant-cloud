// REVIEW-1 to REVIEW-7: proposals, comments, "looks good" marks and review requests.
//
// Who may do what is in server/authz/policy.ts ('bank.propose', 'bank.comment', 'bank.review',
// 'reviews.respond'). On top of the permission, each route checks the resource itself:
//   - a reviewer reads only their own proposals; anything else answers 404;
//   - a reviewer reads and works on only the review requests they are on (404 otherwise);
//   - a proposal changes nothing in the bank until an organiser or administrator accepts it, and then
//     it goes through the bank's own edit path (saveQuestion: validation, version rules, audit).
import { sql } from 'kysely';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { ApiError, conflict, invalid, notFound } from '../http/errors';
import { appendAudit, actorLabel } from '../audit/audit';
import { publish } from '../live/bus';
import { can, type Actor } from '../authz/policy';
import { json, type Executor } from '../db/pool';
import { categoryFromRow, questionFromRow, saveQuestion } from '../bank/service';
import { DRAFT } from '../bank/routes';
import { changedVersionedFields, normaliseDraft, validateQuestionDraft, type QuestionDraft } from '../../src/domain/bankEdit';
import type { Question } from '../../src/domain/types';
import type {
  MyReview,
  MyReviewDetail,
  ProposalDetail,
  ProposalStatus,
  ProposalSummary,
  QuestionFeedback,
  ReviewCounts,
  ReviewerOption,
  ReviewOutcome,
  ReviewRequestDetail,
  ReviewRequestSummary,
} from '../../src/shared/api';

const UUID = z.uuid();
const QUESTION_ID = z.string().regex(/^[a-z][a-z0-9]{0,29}-\d{1,6}$/);
const TRACK_ID = z.string().regex(/^[a-z][a-z0-9]{0,29}$/);
const REASON = z.string().trim().min(1, 'Say briefly why.').max(2000);
const NEW_CATEGORY = z.object({ name: z.string().trim().min(1).max(120) }).strict();

const personName = (u: { name: string | null; email: string } | undefined | null) => (u ? (u.name ?? u.email) : 'Someone no longer here');
const reviewEvent = (db: Executor, kind: string, id?: string) => publish(db, { topic: 'reviews', kind, id });

/** The fields the editor edits, from a stored proposal. */
function draftOf(p: Record<string, unknown>): QuestionDraft {
  return normaliseDraft(p as unknown as QuestionDraft);
}

function problems(draft: QuestionDraft, categoryIds: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(validateQuestionDraft(draft, categoryIds)).filter(([, m]) => !!m)) as Record<string, string>;
}

// ---------- reading proposals ----------

function proposalQuery(db: Executor) {
  return db
    .selectFrom('question_proposals as p')
    .innerJoin('tracks as t', 't.id', 'p.track_id')
    .leftJoin('questions as q', 'q.id', 'p.question_id')
    .leftJoin('users as pu', 'pu.id', 'p.proposed_by')
    .leftJoin('users as du', 'du.id', 'p.decided_by')
    .select([
      'p.id',
      'p.kind',
      'p.track_id',
      't.name as track_name',
      'p.question_id',
      'q.number as question_number',
      'q.version as current_version',
      'p.base_version',
      'p.proposed',
      'p.new_category_name',
      'p.reason',
      'p.status',
      'p.proposed_by',
      'pu.name as proposer_name',
      'pu.email as proposer_email',
      'p.created_at',
      'p.decided_by',
      'du.name as decider_name',
      'du.email as decider_email',
      'p.decided_at',
      'p.decision_reason',
      'p.result_question_id',
      'p.result_version',
      'p.review_request_id',
    ]);
}

type ProposalRow = Awaited<ReturnType<ReturnType<typeof proposalQuery>['executeTakeFirstOrThrow']>>;

function toSummary(r: ProposalRow): ProposalSummary {
  const proposed = r.proposed as { text?: string };
  return {
    id: r.id,
    kind: r.kind,
    trackId: r.track_id,
    trackName: r.track_name,
    questionId: r.question_id,
    questionNumber: r.question_number ?? null,
    baseVersion: r.base_version,
    currentVersion: r.current_version ?? null,
    outOfDate: r.kind === 'change' && r.status === 'open' && r.current_version !== null && r.current_version !== r.base_version,
    text: String(proposed.text ?? ''),
    reason: r.reason,
    status: r.status,
    proposedBy: { id: r.proposed_by, name: personName(r.proposer_email ? { name: r.proposer_name, email: r.proposer_email } : null) },
    createdAt: r.created_at.toISOString(),
    decidedBy: r.decided_by ? { id: r.decided_by, name: personName(r.decider_email ? { name: r.decider_name, email: r.decider_email } : null) } : null,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decisionReason: r.decision_reason,
    resultQuestionId: r.result_question_id,
    resultVersion: r.result_version,
    reviewRequestId: r.review_request_id,
  };
}

/** A proposal the actor may see: all for organisers and administrators, own ones for reviewers. */
async function visibleProposal(db: Executor, actor: Actor, id: string): Promise<ProposalRow> {
  if (!UUID.safeParse(id).success) throw notFound('That proposal');
  const r = await proposalQuery(db).where('p.id', '=', id).executeTakeFirst();
  if (!r || (!can(actor, 'bank.review') && r.proposed_by !== actor.id)) throw notFound('That proposal');
  return r;
}

async function proposalDetail(db: Executor, r: ProposalRow): Promise<ProposalDetail> {
  const [current, base, categories] = await Promise.all([
    r.question_id ? db.selectFrom('questions').selectAll().where('id', '=', r.question_id).executeTakeFirst() : Promise.resolve(undefined),
    r.question_id && r.base_version
      ? db.selectFrom('question_versions').select('snapshot').where('question_id', '=', r.question_id).where('version', '=', r.base_version).executeTakeFirst()
      : Promise.resolve(undefined),
    db.selectFrom('categories').selectAll().where('track_id', '=', r.track_id).orderBy('position').execute(),
  ]);
  return {
    ...toSummary(r),
    proposed: draftOf(r.proposed),
    newCategoryName: r.new_category_name,
    current: current ? questionFromRow(current) : null,
    base: (base?.snapshot as Question | undefined) ?? null,
    categories: categories.map(categoryFromRow),
  };
}

// ---------- review requests: progress ----------

/** Checks the actor is a reviewer on an open request that includes the question; then records progress. */
async function recordProgress(db: Executor, actor: Actor, requestId: string | undefined, questionId: string, outcome: ReviewOutcome): Promise<void> {
  if (!requestId) return;
  const ok = await db
    .selectFrom('review_request_items as i')
    .innerJoin('review_request_reviewers as r', 'r.request_id', 'i.request_id')
    .innerJoin('review_requests as q', 'q.id', 'i.request_id')
    .select('i.request_id')
    .where('i.request_id', '=', requestId)
    .where('i.question_id', '=', questionId)
    .where('r.user_id', '=', actor.id)
    .where('q.state', '=', 'open')
    .executeTakeFirst();
  if (!ok) throw notFound('That review request');
  await db
    .insertInto('review_progress')
    .values({ request_id: requestId, user_id: actor.id, question_id: questionId, outcome })
    .onConflict((oc) => oc.columns(['request_id', 'user_id', 'question_id']).doUpdateSet({ outcome, updated_at: sql`now()` }))
    .execute();
  await reviewEvent(db, 'progress', requestId);
}

function scopeLabel(scope: string, categoryName: string | null, total: number): string {
  if (scope === 'track') return 'Whole track';
  if (scope === 'category') return categoryName ?? 'A category';
  return `${total} chosen question${total === 1 ? '' : 's'}`;
}

async function requestSummaries(db: Executor, where: { id?: string; reviewerId?: string; state?: 'open' | 'closed' }): Promise<ReviewRequestSummary[]> {
  let q = db
    .selectFrom('review_requests as r')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .leftJoin('categories as c', 'c.id', 'r.category_id')
    .leftJoin('users as u', 'u.id', 'r.created_by')
    .select(['r.id', 'r.track_id', 't.name as track_name', 'r.scope', 'c.name as category_name', 'r.note', 'r.due_date', 'r.state', 'u.name as by_name', 'u.email as by_email', 'r.created_at'])
    .select((eb) => eb.selectFrom('review_request_items as i').select(eb.fn.countAll<number>().as('n')).whereRef('i.request_id', '=', 'r.id').as('total'))
    .orderBy('r.created_at', 'desc')
    .limit(200);
  if (where.id) q = q.where('r.id', '=', where.id);
  if (where.state) q = q.where('r.state', '=', where.state);
  if (where.reviewerId) q = q.where((eb) => eb.exists(eb.selectFrom('review_request_reviewers as rr').select('rr.user_id').whereRef('rr.request_id', '=', 'r.id').where('rr.user_id', '=', where.reviewerId!)));
  const rows = await q.execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const reviewers = await db
    .selectFrom('review_request_reviewers as rr')
    .innerJoin('users as u', 'u.id', 'rr.user_id')
    .select(['rr.request_id', 'u.id', 'u.name', 'u.email'])
    .select((eb) => [
      eb.selectFrom('review_progress as p').select(eb.fn.countAll<number>().as('n')).whereRef('p.request_id', '=', 'rr.request_id').whereRef('p.user_id', '=', 'rr.user_id').as('done'),
      eb.selectFrom('question_proposals as qp').select(eb.fn.countAll<number>().as('n')).whereRef('qp.review_request_id', '=', 'rr.request_id').whereRef('qp.proposed_by', '=', 'rr.user_id').as('proposals'),
      eb.selectFrom('question_comments as qc').select(eb.fn.countAll<number>().as('n')).whereRef('qc.review_request_id', '=', 'rr.request_id').whereRef('qc.author_id', '=', 'rr.user_id').as('comments'),
    ])
    .where('rr.request_id', 'in', ids)
    .orderBy('u.email')
    .execute();
  return rows.map((r) => {
    const total = Number(r.total ?? 0);
    return {
      id: r.id,
      trackId: r.track_id,
      trackName: r.track_name,
      scope: r.scope,
      scopeLabel: scopeLabel(r.scope, r.category_name ?? null, total),
      note: r.note,
      dueDate: r.due_date,
      state: r.state,
      requestedBy: personName(r.by_email ? { name: r.by_name, email: r.by_email } : null),
      createdAt: r.created_at.toISOString(),
      total,
      reviewers: reviewers
        .filter((x) => x.request_id === r.id)
        .map((x) => ({ id: x.id, name: personName(x), done: Number(x.done ?? 0), proposals: Number(x.proposals ?? 0), comments: Number(x.comments ?? 0) })),
    };
  });
}

function myView(s: ReviewRequestSummary, actorId: string): MyReview {
  const me = s.reviewers.find((r) => r.id === actorId);
  return { id: s.id, trackId: s.trackId, trackName: s.trackName, scopeLabel: s.scopeLabel, note: s.note, dueDate: s.dueDate, state: s.state, requestedBy: s.requestedBy, total: s.total, done: me?.done ?? 0 };
}

export function registerReviewRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tx = <T>(fn: (trx: import('../db/pool').Tx) => Promise<T>) => ctx.db.transaction().execute(fn);

  // ----- counts for the navigation (REVIEW-7) -----
  route(app, ctx, {
    method: 'GET',
    url: '/api/review-counts',
    access: { action: ['bank.review', 'reviews.respond'] },
    handler: async ({ actor }): Promise<ReviewCounts> => {
      const out: ReviewCounts = { openProposals: 0, openReviewItems: 0 };
      if (can(actor, 'bank.review')) {
        out.openProposals = Number((await ctx.db.selectFrom('question_proposals').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'open').executeTakeFirstOrThrow()).n);
      }
      if (can(actor, 'reviews.respond')) {
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM review_request_items i
          JOIN review_request_reviewers rr ON rr.request_id = i.request_id AND rr.user_id = ${actor.id}
          JOIN review_requests r ON r.id = i.request_id AND r.state = 'open'
          WHERE NOT EXISTS (SELECT 1 FROM review_progress p WHERE p.request_id = i.request_id AND p.user_id = rr.user_id AND p.question_id = i.question_id)`.execute(ctx.db);
        out.openReviewItems = r.rows[0]?.n ?? 0;
      }
      return out;
    },
  });

  // ----- proposals (REVIEW-2, REVIEW-3, REVIEW-5, REVIEW-6) -----
  route(app, ctx, {
    method: 'GET',
    url: '/api/proposals',
    access: { action: ['bank.propose', 'bank.review'] },
    query: z.object({ status: z.enum(['open', 'decided', 'all']).default('open'), trackId: TRACK_ID.optional(), mine: z.enum(['true', 'false']).optional() }).strict(),
    handler: async ({ actor, query }): Promise<ProposalSummary[]> => {
      let q = proposalQuery(ctx.db).orderBy('p.created_at', 'desc').limit(500);
      // REVIEW-1: reviewers only ever see their own proposals.
      if (!can(actor, 'bank.review') || query.mine === 'true') q = q.where('p.proposed_by', '=', actor.id);
      if (query.status === 'open') q = q.where('p.status', '=', 'open');
      if (query.status === 'decided') q = q.where('p.status', '<>', 'open');
      if (query.trackId) q = q.where('p.track_id', '=', query.trackId);
      return (await q.execute()).map(toSummary);
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/proposals/:id',
    access: { action: ['bank.propose', 'bank.review'] },
    params: z.object({ id: z.string().max(100) }).strict(),
    handler: async ({ actor, params }) => proposalDetail(ctx.db, await visibleProposal(ctx.db, actor, params.id)),
  });

  const createSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('change'), questionId: QUESTION_ID, baseVersion: z.number().int().min(1), draft: DRAFT, reason: REASON, requestId: UUID.optional() }).strict(),
    z.object({ kind: z.literal('new'), trackId: TRACK_ID, draft: DRAFT, newCategory: NEW_CATEGORY.optional(), reason: REASON, requestId: UUID.optional() }).strict(),
  ]);

  route(app, ctx, {
    method: 'POST',
    url: '/api/proposals',
    access: { action: 'bank.propose' },
    body: createSchema,
    handler: async ({ actor, body, reply }) => {
      const id = await tx(async (trx) => {
        if (body.kind === 'change') {
          const qrow = await trx.selectFrom('questions').selectAll().where('id', '=', body.questionId).executeTakeFirst();
          if (!qrow) throw notFound('That question');
          const current = questionFromRow(qrow);
          if (body.baseVersion > current.version) throw invalid('That version of the question does not exist.');
          const catIds = (await trx.selectFrom('categories').select('id').where('track_id', '=', current.trackId).execute()).map((c) => c.id);
          const errs = problems(body.draft, catIds);
          if (Object.keys(errs).length) throw new ApiError(400, 'invalid', 'The proposal has problems.', errs);
          const draft = normaliseDraft(body.draft);
          const same = changedVersionedFields(current, draft).length === 0 && draft.categoryId === current.categoryId && draft.timeMin === current.timeMin;
          if (same) throw invalid('The proposal changes nothing: change the wording first.');
          const p = await trx
            .insertInto('question_proposals')
            .values({ kind: 'change', track_id: current.trackId, question_id: current.id, base_version: body.baseVersion, proposed: json(draft), reason: body.reason, proposed_by: actor.id, review_request_id: body.requestId ?? null })
            .returning('id')
            .executeTakeFirstOrThrow();
          await recordProgress(trx, actor, body.requestId, current.id, 'proposed');
          await appendAudit(trx, actor, { action: 'proposal.created', entity: 'question', entityId: current.id, after: { proposal: p.id, kind: 'change', baseVersion: body.baseVersion }, reason: body.reason });
          return p.id;
        }
        const track = await trx.selectFrom('tracks').select('id').where('id', '=', body.trackId).executeTakeFirst();
        if (!track) throw notFound('That track');
        const catIds = (await trx.selectFrom('categories').select('id').where('track_id', '=', body.trackId).execute()).map((c) => c.id);
        const newCat = body.newCategory?.name ?? null;
        const errs = problems(newCat ? { ...body.draft, categoryId: '__new__' } : body.draft, newCat ? [...catIds, '__new__'] : catIds);
        if (Object.keys(errs).length) throw new ApiError(400, 'invalid', 'The proposal has problems.', errs);
        const draft = normaliseDraft({ ...body.draft, categoryId: newCat ? '' : body.draft.categoryId });
        const p = await trx
          .insertInto('question_proposals')
          .values({ kind: 'new', track_id: body.trackId, proposed: json(draft), new_category_name: newCat, reason: body.reason, proposed_by: actor.id, review_request_id: body.requestId ?? null })
          .returning('id')
          .executeTakeFirstOrThrow();
        await appendAudit(trx, actor, { action: 'proposal.created', entity: 'track', entityId: body.trackId, after: { proposal: p.id, kind: 'new' }, reason: body.reason });
        return p.id;
      });
      await reviewEvent(ctx.db, 'proposal', id);
      reply.status(201);
      return { id };
    },
  });

  // REVIEW-3: several new questions at once, from the bulk-add preview.
  route(app, ctx, {
    method: 'POST',
    url: '/api/proposals/bulk',
    access: { action: 'bank.propose' },
    bodyLimit: 5_000_000,
    body: z
      .object({
        trackId: TRACK_ID,
        drafts: z.array(DRAFT).min(1).max(200),
        newCategories: z.array(z.object({ id: z.string().max(200), name: z.string().trim().min(1).max(120) }).strict()).max(50).default([]),
        reason: REASON,
      })
      .strict(),
    handler: async ({ actor, body, reply }) => {
      const ids = await tx(async (trx) => {
        if (!(await trx.selectFrom('tracks').select('id').where('id', '=', body.trackId).executeTakeFirst())) throw notFound('That track');
        const catIds = (await trx.selectFrom('categories').select('id').where('track_id', '=', body.trackId).execute()).map((c) => c.id);
        const provisional = new Map(body.newCategories.map((c) => [c.id, c.name]));
        const out: string[] = [];
        for (const [i, d] of body.drafts.entries()) {
          const newCat = provisional.get(d.categoryId) ?? null;
          const errs = problems(d, newCat ? [...catIds, d.categoryId] : catIds);
          if (Object.keys(errs).length) throw new ApiError(400, 'invalid', `Question ${i + 1} has problems: ${Object.values(errs)[0]}`, Object.values(errs));
          const draft = normaliseDraft({ ...d, categoryId: newCat ? '' : d.categoryId });
          const p = await trx
            .insertInto('question_proposals')
            .values({ kind: 'new', track_id: body.trackId, proposed: json(draft), new_category_name: newCat, reason: body.reason, proposed_by: actor.id })
            .returning('id')
            .executeTakeFirstOrThrow();
          out.push(p.id);
        }
        await appendAudit(trx, actor, { action: 'proposal.created', entity: 'track', entityId: body.trackId, after: { proposals: out.length, kind: 'new' }, reason: body.reason });
        return out;
      });
      await reviewEvent(ctx.db, 'proposal');
      reply.status(201);
      return { ids };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/proposals/:id/withdraw',
    access: { action: 'bank.propose' },
    params: z.object({ id: z.string().max(100) }).strict(),
    handler: async ({ actor, params }) => {
      await tx(async (trx) => {
        const p = await visibleProposal(trx, actor, params.id);
        if (p.proposed_by !== actor.id) throw notFound('That proposal');
        if (p.status !== 'open') throw conflict('Only a proposal that is still waiting can be withdrawn.');
        await trx.updateTable('question_proposals').set({ status: 'withdrawn', decided_by: actor.id, decided_at: new Date() }).where('id', '=', p.id).execute();
        await appendAudit(trx, actor, { action: 'proposal.withdrawn', entity: 'proposal', entityId: p.id });
        await reviewEvent(trx, 'proposal', p.id);
      });
      return undefined;
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/proposals/:id/accept',
    access: { action: 'bank.review' },
    params: z.object({ id: z.string().max(100) }).strict(),
    body: z.object({ draft: DRAFT.optional(), newCategory: NEW_CATEGORY.optional(), note: z.string().trim().max(2000).optional(), confirmOutOfDate: z.boolean().optional() }).strict(),
    handler: async ({ actor, params, body }) =>
      tx(async (trx) => {
        const p = await visibleProposal(trx, actor, params.id);
        await trx.selectFrom('question_proposals').select('id').where('id', '=', p.id).forUpdate().execute();
        const fresh = await trx.selectFrom('question_proposals').select('status').where('id', '=', p.id).executeTakeFirstOrThrow();
        if (fresh.status !== 'open') throw conflict('This proposal has already been decided.');
        const proposed = draftOf(p.proposed);
        // REVIEW-6: a change written against an older version is shown against the current wording first.
        if (p.kind === 'change' && p.current_version !== p.base_version && !body.confirmOutOfDate) {
          throw conflict('This question has changed since the proposal was written. Compare it with the current wording, then accept again.', ['out-of-date']);
        }
        const draft = body.draft ? normaliseDraft(body.draft) : proposed;
        const edited = !!body.draft && JSON.stringify(draft) !== JSON.stringify(proposed);
        const proposer = await trx.selectFrom('users').select(['id', 'email', 'name', 'role']).where('id', '=', p.proposed_by).executeTakeFirst();
        const proposerLabel = proposer ? actorLabel(proposer) : 'a former user';
        const auditReason = `Proposal by ${proposerLabel}, accepted${edited ? ' with edits' : ''} by ${actorLabel(actor)}${body.note ? `: ${body.note}` : ''}`;
        let newCategory = body.newCategory ?? (p.kind === 'new' && !draft.categoryId && p.new_category_name ? { name: p.new_category_name } : undefined);
        if (newCategory) {
          // The suggested category may exist by now (created by hand, or by an earlier acceptance).
          const existing = await trx.selectFrom('categories').select('id').where('track_id', '=', p.track_id).where(sql`lower(btrim(name))`, '=', newCategory.name.trim().toLowerCase()).executeTakeFirst();
          if (existing) {
            draft.categoryId = existing.id;
            newCategory = undefined;
          }
        }
        const result = await saveQuestion(trx, actor, {
          trackId: p.track_id,
          id: p.kind === 'change' ? p.question_id! : undefined,
          draft,
          newCategory,
          auditReason,
        });
        const status: ProposalStatus = edited ? 'accepted_with_edits' : 'accepted';
        await trx
          .updateTable('question_proposals')
          .set({ status, decided_by: actor.id, decided_at: new Date(), decision_reason: body.note || null, result_question_id: result.id, result_version: result.version })
          .where('id', '=', p.id)
          .execute();
        await appendAudit(trx, actor, {
          action: 'proposal.accepted',
          entity: 'proposal',
          entityId: p.id,
          after: { question: result.id, version: result.version, withEdits: edited, proposedBy: proposerLabel },
          reason: body.note || null,
        });
        await reviewEvent(trx, 'proposal', p.id);
        return { status, questionId: result.id, version: result.version, bumped: result.bumped };
      }),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/proposals/:id/decline',
    access: { action: 'bank.review' },
    params: z.object({ id: z.string().max(100) }).strict(),
    body: z.object({ reason: REASON }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx(async (trx) => {
        const p = await visibleProposal(trx, actor, params.id);
        const r = await trx
          .updateTable('question_proposals')
          .set({ status: 'declined', decided_by: actor.id, decided_at: new Date(), decision_reason: body.reason })
          .where('id', '=', p.id)
          .where('status', '=', 'open')
          .executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw conflict('This proposal has already been decided.');
        await appendAudit(trx, actor, { action: 'proposal.declined', entity: 'proposal', entityId: p.id, reason: body.reason });
        await reviewEvent(trx, 'proposal', p.id);
      });
      return undefined;
    },
  });

  // ----- comments and "looks good" (REVIEW-4) -----
  route(app, ctx, {
    method: 'GET',
    url: '/api/bank/questions/:questionId/feedback',
    access: { action: 'bank.comment' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    handler: async ({ actor, params }): Promise<QuestionFeedback> => {
      const [comments, marks] = await Promise.all([
        ctx.db
          .selectFrom('question_comments as c')
          .leftJoin('users as u', 'u.id', 'c.author_id')
          .select(['c.id', 'c.text', 'c.created_at', 'c.question_version', 'c.author_id', 'u.name', 'u.email'])
          .where('c.question_id', '=', params.questionId)
          .orderBy('c.created_at')
          .limit(500)
          .execute(),
        ctx.db
          .selectFrom('question_looks_good as g')
          .innerJoin('users as u', 'u.id', 'g.user_id')
          .select(['g.user_id', 'g.question_version', 'g.created_at', 'u.name', 'u.email'])
          .where('g.question_id', '=', params.questionId)
          .orderBy('g.created_at')
          .execute(),
      ]);
      return {
        comments: comments.map((c) => ({ id: c.id, author: personName(c.email ? { name: c.name, email: c.email } : null), text: c.text, createdAt: c.created_at.toISOString(), questionVersion: c.question_version, mine: c.author_id === actor.id })),
        looksGood: marks.map((g) => ({ name: personName(g), version: g.question_version, at: g.created_at.toISOString(), mine: g.user_id === actor.id })),
      };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/bank/questions/:questionId/comments',
    access: { action: 'bank.comment' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    body: z.object({ text: z.string().trim().min(1, 'Write a comment first.').max(4000), requestId: UUID.optional() }).strict(),
    handler: async ({ actor, params, body, reply }) => {
      const id = await tx(async (trx) => {
        const q = await trx.selectFrom('questions').select(['id', 'version']).where('id', '=', params.questionId).executeTakeFirst();
        if (!q) throw notFound('That question');
        const c = await trx
          .insertInto('question_comments')
          .values({ question_id: q.id, author_id: actor.id, text: body.text, question_version: q.version, review_request_id: body.requestId ?? null })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (body.requestId) await recordProgress(trx, actor, body.requestId, q.id, 'commented');
        await reviewEvent(trx, 'comment', q.id);
        return c.id;
      });
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/bank/questions/:questionId/looks-good',
    access: { action: 'bank.propose' },
    params: z.object({ questionId: QUESTION_ID }).strict(),
    body: z.object({ value: z.boolean(), requestId: UUID.optional() }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx(async (trx) => {
        const q = await trx.selectFrom('questions').select(['id', 'version']).where('id', '=', params.questionId).executeTakeFirst();
        if (!q) throw notFound('That question');
        if (body.value) {
          await trx
            .insertInto('question_looks_good')
            .values({ question_id: q.id, user_id: actor.id, question_version: q.version })
            .onConflict((oc) => oc.columns(['question_id', 'user_id']).doUpdateSet({ question_version: q.version, created_at: sql`now()` }))
            .execute();
          if (body.requestId) await recordProgress(trx, actor, body.requestId, q.id, 'looks_good');
        } else {
          await trx.deleteFrom('question_looks_good').where('question_id', '=', q.id).where('user_id', '=', actor.id).execute();
        }
        await reviewEvent(trx, 'looks-good', q.id);
      });
      return undefined;
    },
  });

  // ----- review requests: asking (REVIEW-7) -----
  route(app, ctx, {
    method: 'GET',
    url: '/api/reviews/reviewers',
    access: { action: 'bank.review' },
    handler: async (): Promise<ReviewerOption[]> =>
      (await ctx.db.selectFrom('users').select(['id', 'name', 'email']).where('role', '=', 'reviewer').where('active', '=', true).orderBy('email').execute()).map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email })),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/reviews',
    access: { action: 'bank.review' },
    body: z
      .object({
        trackId: TRACK_ID,
        scope: z.enum(['track', 'category', 'questions']),
        categoryId: z.string().max(200).optional(),
        questionIds: z.array(QUESTION_ID).max(1000).optional(),
        reviewerIds: z.array(UUID).min(1, 'Choose at least one reviewer.').max(100),
        note: z.string().trim().max(2000).default(''),
        dueDate: z.iso.date().optional(),
      })
      .strict(),
    handler: async ({ actor, body, reply }) => {
      const id = await tx(async (trx) => {
        if (!(await trx.selectFrom('tracks').select('id').where('id', '=', body.trackId).executeTakeFirst())) throw notFound('That track');
        let q = trx.selectFrom('questions').select('id').where('track_id', '=', body.trackId).where('status', '=', 'active').orderBy('number');
        if (body.scope === 'category') {
          if (!body.categoryId) throw invalid('Choose a category.', { categoryId: 'Choose a category.' });
          q = q.where('category_id', '=', body.categoryId);
        }
        if (body.scope === 'questions') {
          if (!body.questionIds?.length) throw invalid('Choose at least one question.', { questionIds: 'Choose at least one question.' });
          q = q.where('id', 'in', body.questionIds);
        }
        const questions = await q.execute();
        if (!questions.length) throw invalid('There are no active questions to review there.');
        const reviewers = await trx.selectFrom('users').select('id').where('id', 'in', body.reviewerIds).where('role', '=', 'reviewer').where('active', '=', true).execute();
        if (reviewers.length !== new Set(body.reviewerIds).size) throw invalid('Choose reviewers from the list: everyone must be an active question reviewer.', { reviewerIds: 'Not everyone chosen is an active question reviewer.' });
        const r = await trx
          .insertInto('review_requests')
          .values({ track_id: body.trackId, scope: body.scope, category_id: body.scope === 'category' ? body.categoryId! : null, note: body.note, due_date: body.dueDate ?? null, created_by: actor.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('review_request_items').values(questions.map((x, i) => ({ request_id: r.id, question_id: x.id, position: i }))).execute();
        await trx.insertInto('review_request_reviewers').values(reviewers.map((x) => ({ request_id: r.id, user_id: x.id }))).execute();
        await appendAudit(trx, actor, { action: 'review.requested', entity: 'review', entityId: r.id, after: { trackId: body.trackId, scope: body.scope, questions: questions.length, reviewers: reviewers.length, dueDate: body.dueDate ?? null } });
        await reviewEvent(trx, 'request', r.id);
        return r.id;
      });
      reply.status(201);
      return { id };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/reviews',
    access: { action: 'bank.review' },
    query: z.object({ state: z.enum(['open', 'closed']).optional() }).strict(),
    handler: ({ query }) => requestSummaries(ctx.db, { state: query.state }),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/reviews/:id',
    access: { action: 'bank.review' },
    params: z.object({ id: z.uuid() }).strict(),
    handler: async ({ params }): Promise<ReviewRequestDetail> => {
      const [s] = await requestSummaries(ctx.db, { id: params.id });
      if (!s) throw notFound('That review request');
      const proposals = (await proposalQuery(ctx.db).where('p.review_request_id', '=', params.id).orderBy('p.created_at', 'desc').execute()).map(toSummary);
      return { ...s, proposals };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/reviews/:id/close',
    access: { action: 'bank.review' },
    params: z.object({ id: z.uuid() }).strict(),
    handler: async ({ actor, params }) => {
      await tx(async (trx) => {
        const r = await trx.updateTable('review_requests').set({ state: 'closed', closed_at: new Date() }).where('id', '=', params.id).where('state', '=', 'open').executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw notFound('That open review request');
        await appendAudit(trx, actor, { action: 'review.closed', entity: 'review', entityId: params.id });
        await reviewEvent(trx, 'request', params.id);
      });
      return undefined;
    },
  });

  // ----- review requests: answering (REVIEW-7) -----
  route(app, ctx, {
    method: 'GET',
    url: '/api/my-reviews',
    access: { action: 'reviews.respond' },
    handler: async ({ actor }): Promise<MyReview[]> => (await requestSummaries(ctx.db, { reviewerId: actor.id })).map((s) => myView(s, actor.id)),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/my-reviews/:id',
    access: { action: 'reviews.respond' },
    params: z.object({ id: z.string().max(100) }).strict(),
    handler: async ({ actor, params }): Promise<MyReviewDetail> => {
      if (!UUID.safeParse(params.id).success) throw notFound('That review request');
      const [s] = await requestSummaries(ctx.db, { id: params.id, reviewerId: actor.id });
      if (!s) throw notFound('That review request');
      const items = await ctx.db
        .selectFrom('review_request_items as i')
        .innerJoin('questions as q', 'q.id', 'i.question_id')
        .leftJoin('review_progress as p', (j) => j.onRef('p.request_id', '=', 'i.request_id').onRef('p.question_id', '=', 'i.question_id').on('p.user_id', '=', actor.id))
        .select(['i.question_id', 'q.number', 'q.text', 'p.outcome'])
        .where('i.request_id', '=', params.id)
        .orderBy('i.position')
        .execute();
      return { ...myView(s, actor.id), items: items.map((i) => ({ questionId: i.question_id, number: i.number, text: i.text, outcome: i.outcome ?? null })) };
    },
  });

  route(app, ctx, {
    method: 'PUT',
    url: '/api/my-reviews/:id/items/:questionId',
    access: { action: 'reviews.respond' },
    params: z.object({ id: z.uuid(), questionId: QUESTION_ID }).strict(),
    body: z.object({ done: z.boolean() }).strict(),
    handler: async ({ actor, params, body }) => {
      await tx(async (trx) => {
        if (body.done) await recordProgress(trx, actor, params.id, params.questionId, 'nothing_to_add');
        else {
          // Undo: only this reviewer's own mark, and only on a request they are on.
          await recordProgress(trx, actor, params.id, params.questionId, 'nothing_to_add');
          await trx.deleteFrom('review_progress').where('request_id', '=', params.id).where('user_id', '=', actor.id).where('question_id', '=', params.questionId).execute();
        }
      });
      return undefined;
    },
  });
}
