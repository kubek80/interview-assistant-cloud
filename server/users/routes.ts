// USER-1…USER-4: the Users page's API, for administrators. Every change is audited (who did what to
// whom) in the same transaction, and pushed to other open Users pages as a live update (HOST-5).
// Deactivating or removing someone ends their sessions at once (AUTH-4, USER-3). The last active
// administrator cannot be demoted, deactivated or removed; the check runs under row locks, so two
// administrators demoting each other at the same moment cannot both succeed.
import { sql } from 'kysely';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { conflict, invalid, notFound } from '../http/errors';
import { appendAudit } from '../audit/audit';
import { revokeUserSessions } from '../auth/sessions';
import { publish } from '../live/bus';
import type { Executor } from '../db/pool';
import type { InvitePreviewLine, InviteResult, Page, UserSummary } from '../../src/shared/api';

const ROLE = z.enum(['admin', 'organiser', 'interviewer', 'reviewer']);
const ID = z.object({ id: z.uuid() }).strict();
export const MAX_INVITES = 500;

const EMAIL = z.email();

export async function previewInvites(db: Executor, text: string): Promise<InvitePreviewLine[]> {
  const parts = text
    .split(/[\n,;]+/)
    .flatMap((line) => {
      const angle = /<([^>]+)>/.exec(line);
      if (angle) return [angle[1]];
      return line.split(/\s+/);
    })
    .map((s) => s.trim().replace(/^mailto:/i, ''))
    .filter(Boolean);
  if (parts.length > MAX_INVITES) throw invalid(`Add at most ${MAX_INVITES} people at a time.`);
  const emails = parts.map((p) => (EMAIL.safeParse(p.toLowerCase()).success && p.length <= 254 ? p.toLowerCase() : null));
  const valid = [...new Set(emails.filter((e): e is string => !!e))];
  const existing = valid.length ? await db.selectFrom('users').select(['email', 'role', 'active']).where('email', 'in', valid).execute() : [];
  const byEmail = new Map(existing.map((u) => [u.email, u]));
  const seen = new Set<string>();
  return parts.map((input, i): InvitePreviewLine => {
    const email = emails[i];
    if (!email) return { input, email: null, outcome: 'invalid' };
    if (seen.has(email)) return { input, email, outcome: 'duplicate' };
    seen.add(email);
    const ex = byEmail.get(email);
    if (ex) return { input, email, outcome: 'exists', existing: { role: ex.role, active: ex.active } };
    return { input, email, outcome: 'add' };
  });
}

async function summaries(db: Executor, where: { ids?: string[]; afterEmail?: string; q?: string; limit: number }): Promise<UserSummary[]> {
  let q = db
    .selectFrom('users as u')
    .select(['u.id', 'u.email', 'u.name', 'u.role', 'u.active', 'u.created_at', 'u.last_sign_in_at'])
    .select((eb) =>
      eb
        .selectFrom('round_members as m')
        .innerJoin('rounds as r', 'r.id', 'm.round_id')
        .select(sql<Array<{ id: string; name: string; role: 'organiser' | 'interviewer' }>>`coalesce(json_agg(json_build_object('id', r.id, 'name', r.name, 'role', m.role) ORDER BY r.name), '[]'::json)`.as('x'))
        .whereRef('m.user_id', '=', 'u.id')
        .as('rounds'),
    )
    .orderBy('u.email')
    .limit(where.limit);
  if (where.ids) q = q.where('u.id', 'in', where.ids);
  if (where.afterEmail) q = q.where('u.email', '>', where.afterEmail);
  if (where.q) {
    const like = `%${where.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q = q.where((eb) => eb.or([eb('u.email', 'like', like), eb(sql`lower(coalesce(u.name, ''))`, 'like', like)]));
  }
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active,
    createdAt: r.created_at.toISOString(),
    lastSignInAt: r.last_sign_in_at?.toISOString() ?? null,
    rounds: r.rounds ?? [],
  }));
}

/** USER-3: refuses a change that would leave no active administrator. Locks the admin rows. */
async function assertKeepsAnAdmin(db: Executor, userId: string): Promise<void> {
  const admins = await db.selectFrom('users').select('id').where('role', '=', 'admin').where('active', '=', true).forUpdate().execute();
  if (admins.length === 1 && admins[0].id === userId) {
    throw conflict('This is the last active administrator. Make someone else an administrator first.');
  }
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  route(app, ctx, {
    method: 'GET',
    url: '/api/users',
    access: { action: 'users.read' },
    query: z.object({ cursor: z.string().max(254).optional(), limit: z.coerce.number().int().min(1).max(500).default(200), q: z.string().max(200).optional() }).strict(),
    handler: async ({ query }): Promise<Page<UserSummary>> => {
      const items = await summaries(ctx.db, { afterEmail: query.cursor, q: query.q?.trim() || undefined, limit: query.limit + 1 });
      const more = items.length > query.limit;
      const page = more ? items.slice(0, query.limit) : items;
      return { items: page, nextCursor: more ? page[page.length - 1].email : null };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/users/preview',
    access: { action: 'users.manage' },
    body: z.object({ text: z.string().max(100_000) }).strict(),
    handler: async ({ body }) => previewInvites(ctx.db, body.text),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/api/users',
    access: { action: 'users.manage' },
    body: z.object({ text: z.string().max(100_000), role: ROLE }).strict(),
    handler: async ({ actor, body, reply }): Promise<InviteResult> => {
      const result = await ctx.db.transaction().execute(async (trx) => {
        const lines = await previewInvites(trx, body.text);
        const toAdd = lines.filter((l) => l.outcome === 'add').map((l) => l.email!);
        if (!toAdd.length) throw invalid(lines.length ? 'Everyone in the list already has access, or the addresses are not valid.' : 'Enter at least one email address.');
        const inserted = await trx
          .insertInto('users')
          .values(toAdd.map((email) => ({ email, role: body.role, created_by: actor.id })))
          .onConflict((oc) => oc.column('email').doNothing())
          .returning(['id', 'email'])
          .execute();
        for (const u of inserted) {
          await appendAudit(trx, actor, { action: 'user.added', entity: 'user', entityId: u.id, after: { email: u.email, role: body.role } });
        }
        await publish(trx, { topic: 'users', kind: 'added' });
        return { added: await summaries(trx, { ids: inserted.map((u) => u.id), limit: MAX_INVITES }), skipped: lines.filter((l) => l.outcome !== 'add') };
      });
      reply.status(201);
      return result;
    },
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/users/:id',
    access: { action: 'users.manage' },
    params: ID,
    body: z
      .object({ role: ROLE.optional(), active: z.boolean().optional(), name: z.string().trim().min(1).max(200).nullable().optional() })
      .strict()
      .refine((b) => b.role !== undefined || b.active !== undefined || b.name !== undefined, 'Nothing to change.'),
    handler: async ({ actor, params, body }): Promise<UserSummary> =>
      ctx.db.transaction().execute(async (trx) => {
        const user = await trx.selectFrom('users').selectAll().where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!user) throw notFound('That person');
        const demoting = body.role !== undefined && body.role !== 'admin' && user.role === 'admin';
        const deactivating = body.active === false && user.active;
        if (deactivating && user.id === actor.id) throw conflict('You cannot deactivate yourself. Ask another administrator.');
        if ((demoting || deactivating) && user.role === 'admin' && user.active) await assertKeepsAnAdmin(trx, user.id);
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const set: Record<string, unknown> = {};
        if (body.role !== undefined && body.role !== user.role) {
          before.role = user.role;
          after.role = set.role = body.role;
        }
        if (body.active !== undefined && body.active !== user.active) {
          before.active = user.active;
          after.active = set.active = body.active;
          set.deactivated_at = body.active ? null : new Date();
        }
        if (body.name !== undefined && body.name !== user.name) {
          before.name = user.name;
          after.name = set.name = body.name;
        }
        if (Object.keys(set).length) {
          await trx.updateTable('users').set({ ...set, updated_at: new Date() }).where('id', '=', user.id).execute();
          const action = after.active === false ? 'user.deactivated' : after.active === true ? 'user.reactivated' : 'user.changed';
          await appendAudit(trx, actor, { action, entity: 'user', entityId: user.id, before: { email: user.email, ...before }, after: { email: user.email, ...after } });
          if (after.active === false) {
            // AUTH-4, USER-3: their sessions end now; any open live stream of theirs closes.
            await revokeUserSessions(trx, user.id);
            await publish(trx, { topic: `user:${user.id}`, kind: 'revoked' });
          } else if (after.role) {
            await publish(trx, { topic: `user:${user.id}`, kind: 'changed' });
          }
          await publish(trx, { topic: 'users', kind: 'changed', id: user.id });
        }
        return (await summaries(trx, { ids: [user.id], limit: 1 }))[0];
      }),
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/api/users/:id',
    access: { action: 'users.manage' },
    params: ID,
    handler: async ({ actor, params }) =>
      ctx.db.transaction().execute(async (trx) => {
        const user = await trx.selectFrom('users').selectAll().where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!user) throw notFound('That person');
        if (user.id === actor.id) throw conflict('You cannot remove yourself.');
        // USER-1, USER-3: only people who never signed in can be removed; others keep their name on
        // their judgements, so they are deactivated instead.
        if (user.last_sign_in_at) throw conflict('This person has signed in before, so they cannot be removed. Deactivate them instead.');
        if (user.role === 'admin' && user.active) await assertKeepsAnAdmin(trx, user.id);
        await revokeUserSessions(trx, user.id);
        await trx.deleteFrom('users').where('id', '=', user.id).execute();
        await appendAudit(trx, actor, { action: 'user.removed', entity: 'user', entityId: user.id, before: { email: user.email, role: user.role, active: user.active } });
        await publish(trx, { topic: `user:${user.id}`, kind: 'revoked' });
        await publish(trx, { topic: 'users', kind: 'removed', id: user.id });
        return undefined;
      }),
  });
}
