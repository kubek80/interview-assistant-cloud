// HPRIV-4, AUD-1, USER-4, BANK-14: the audit log in the database. Entries are written in the same
// transaction as the change they record, so a change is never saved without its entry (or the other
// way round). The actor is always the signed-in user, or "system" for the command-line scripts.
// The table refuses updates and deletes (migration 0001), so the app cannot change history.
import type { Actor } from '../authz/policy';
import { json, type Executor } from '../db/pool';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  roundId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export type AuditActor = Actor | { system: string };

export function actorLabel(actor: AuditActor): string {
  if ('system' in actor) return actor.system;
  return actor.name ? `${actor.name} <${actor.email}>` : actor.email;
}

export async function appendAudit(db: Executor, actor: AuditActor, e: AuditInput): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      actor_id: 'system' in actor ? null : actor.id,
      actor_label: actorLabel(actor).slice(0, 400),
      action: e.action,
      entity: e.entity,
      entity_id: e.entityId ?? null,
      round_id: e.roundId ?? null,
      before: e.before === undefined || e.before === null ? null : json(e.before),
      after: e.after === undefined || e.after === null ? null : json(e.after),
      reason: e.reason ?? null,
    })
    .execute();
}
