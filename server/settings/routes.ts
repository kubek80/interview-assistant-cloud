// Organisation settings (replaces the local app's "This device" settings): defaults that apply to
// everyone, read by all signed-in people and changed by administrators. Audited.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { appendAudit } from '../audit/audit';
import type { OrgSettings } from '../../src/shared/api';
import type { Executor } from '../db/pool';

async function read(db: Executor): Promise<OrgSettings> {
  const r = await db.selectFrom('org_settings').select(['default_retention_days', 'ai_enabled']).executeTakeFirstOrThrow();
  return { defaultRetentionDays: r.default_retention_days, aiEnabled: r.ai_enabled };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  route(app, ctx, { method: 'GET', url: '/api/settings', access: { action: 'settings.read' }, handler: () => read(ctx.db) });

  route(app, ctx, {
    method: 'PATCH',
    url: '/api/settings',
    access: { action: 'settings.manage' },
    body: z.object({ defaultRetentionDays: z.number().int().min(1).max(3650).optional() }).strict(),
    handler: async ({ actor, body }) =>
      ctx.db.transaction().execute(async (trx) => {
        const before = await read(trx);
        if (body.defaultRetentionDays === undefined || body.defaultRetentionDays === before.defaultRetentionDays) return before;
        await trx.updateTable('org_settings').set({ default_retention_days: body.defaultRetentionDays, updated_at: new Date(), updated_by: actor.id }).execute();
        await appendAudit(trx, actor, { action: 'settings.changed', entity: 'settings', before: { defaultRetentionDays: before.defaultRetentionDays }, after: { defaultRetentionDays: body.defaultRetentionDays } });
        return read(trx);
      }),
  });
}
