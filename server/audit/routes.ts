// HPRIV-4, AUD-3: reading and exporting the audit log. Administrators see everything; round-scoped
// views for organisers come with rounds in step 2 (permission `round.audit`). There is no route that
// changes or deletes an entry, and the table refuses it anyway.
import { sql } from 'kysely';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { appendAudit } from './audit';
import { auditCsv } from '../../src/domain/export';
import type { AuditEntry, Page } from '../../src/shared/api';
import type { AuditEvent } from '../../src/domain/types';

const FILTER = z
  .object({
    action: z.string().regex(/^[a-z_.]+$/).max(60).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    q: z.string().max(200).optional(),
  })
  .strict();

type Filter = z.infer<typeof FILTER>;

function query(ctx: AppContext, f: Filter) {
  let q = ctx.db.selectFrom('audit_events').select(['id', 'at', 'actor_label', 'action', 'entity', 'entity_id', 'before', 'after', 'reason']);
  if (f.action) q = q.where('action', '=', f.action);
  if (f.from) q = q.where('at', '>=', new Date(f.from));
  if (f.to) q = q.where('at', '<=', new Date(f.to));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q = q.where((eb) =>
      eb.or([
        eb(sql`lower(actor_label)`, 'like', like),
        eb('action', 'like', like),
        eb(sql`lower(coalesce(entity_id, ''))`, 'like', like),
        eb(sql`lower(coalesce(reason, ''))`, 'like', like),
        eb(sql`lower(coalesce(before::text, '') || ' ' || coalesce(after::text, ''))`, 'like', like),
      ]),
    );
  }
  return q.orderBy('id', 'desc');
}

const toEntry = (r: { id: string | number; at: Date; actor_label: string; action: string; entity: string; entity_id: string | null; before: unknown; after: unknown; reason: string | null }): AuditEntry => ({
  id: Number(r.id),
  at: r.at.toISOString(),
  actor: r.actor_label,
  action: r.action,
  entity: r.entity,
  entityId: r.entity_id,
  before: r.before,
  after: r.after,
  reason: r.reason,
});

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  route(app, ctx, {
    method: 'GET',
    url: '/api/audit',
    access: { action: 'audit.read' },
    query: FILTER.extend({ cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(),
    handler: async ({ query: qp }): Promise<Page<AuditEntry>> => {
      let q = query(ctx, qp).limit(qp.limit + 1);
      if (qp.cursor) q = q.where('id', '<', String(qp.cursor));
      const rows = (await q.execute()).map(toEntry);
      const more = rows.length > qp.limit;
      const items = more ? rows.slice(0, qp.limit) : rows;
      return { items, nextCursor: more ? String(items[items.length - 1].id) : null };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/api/audit/export',
    access: { action: 'audit.export' },
    query: FILTER,
    handler: async ({ actor, query: qp, reply }) => {
      const rows = (await query(ctx, qp).limit(100_000).execute()).map(toEntry);
      const events: AuditEvent[] = rows.map((r) => ({
        id: r.id,
        ts: r.at,
        actor: r.actor,
        action: r.action as AuditEvent['action'],
        entity: r.entity as AuditEvent['entity'],
        entityId: r.entityId,
        before: r.before ?? null,
        after: r.after ?? null,
        reason: r.reason,
      }));
      await appendAudit(ctx.db, actor, { action: 'audit.exported', entity: 'audit', after: { format: 'csv', entries: rows.length, filter: qp } });
      reply.header('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      reply.type('text/csv; charset=utf-8');
      return auditCsv(events);
    },
  });
}
