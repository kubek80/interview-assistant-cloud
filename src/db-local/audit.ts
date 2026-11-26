import { db } from './db';
import type { AuditAction, AuditEntity, AuditEvent } from '../domain/types';

export { appendAudit } from './util';

export interface AuditFilter {
  actions?: AuditAction[];
  entity?: AuditEntity;
  entityId?: string;
  /** Inclusive ISO timestamps or dates. */
  from?: string;
  to?: string;
  /** Case-insensitive match on actor, action, entity id and reason. */
  text?: string;
  limit?: number;
}

/** AUD-3: read the audit log, newest first. (AUD-1: there is no update or delete API.) */
export async function queryAudit(filter: AuditFilter = {}): Promise<AuditEvent[]> {
  const needle = filter.text?.trim().toLowerCase();
  const to = filter.to && filter.to.length === 10 ? `${filter.to}T23:59:59.999Z` : filter.to;
  let rows = await db.audit.orderBy('id').reverse().toArray();
  rows = rows.filter(
    (e) =>
      (!filter.actions?.length || filter.actions.includes(e.action)) &&
      (!filter.entity || e.entity === filter.entity) &&
      (!filter.entityId || e.entityId === filter.entityId) &&
      (!filter.from || e.ts >= filter.from) &&
      (!to || e.ts <= to) &&
      (!needle || [e.actor, e.action, e.entityId ?? '', e.reason ?? ''].some((s) => s.toLowerCase().includes(needle))),
  );
  return filter.limit ? rows.slice(0, filter.limit) : rows;
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'plan.locked': 'Plan locked',
  'session.started': 'Interview started',
  'session.submitted': 'Interview submitted',
  'session.amended': 'Edited after submission',
  export: 'Export',
  import: 'Import',
  'bank.loaded': 'Question bank loaded',
  'retention.purged': 'Retention purge',
  'privacy.access_request': 'Access request',
  'privacy.deletion_request': 'Deletion request',
  'data.erased': 'All data erased',
  'session.interviewer_added': 'Interviewer added',
  'session.interviewer_removed': 'Interviewer removed',
  'bank.question_added': 'Question added',
  'bank.question_edited': 'Question edited',
  'bank.question_retired': 'Question retired',
  'bank.question_restored': 'Question restored',
  'bank.category_added': 'Category added',
  'bank.category_edited': 'Category changed',
  'bank.category_removed': 'Category removed',
  'bank.track_created': 'Track created',
  'session.recording_notice_confirmed': 'Candidate told of recording (confirmed later)',
  'session.consent_confirmed': 'Consent confirmed',
  'session.discarded': 'Interview discarded before it started',
  'transcript.attached': 'Transcript attached',
  'transcript.replaced': 'Transcript replaced',
  'transcript.removed': 'Transcript removed',
  'recording.attached': 'Recording attached',
  'recording.replaced': 'Recording replaced',
  'recording.removed': 'Recording removed',
  'ai.enabled': 'AI second opinion turned on',
  'ai.disabled': 'AI second opinion turned off',
  'ai.run': 'AI second opinion run',
  'ai.run_failed': 'AI second opinion run failed',
  'invitation.saved': 'Interview saved for later',
  'invitation.changed': 'Planned interview changed',
  'invitation.cancelled': 'Planned interview cancelled',
  'device.independent_scoring': 'Independent scoring turned on or off',
  'judgement.entered': 'Judgement entered on someone’s behalf',
  'decision.recorded': 'Panel decision recorded',
  'decision.changed': 'Panel decision changed',
  'summary.saved': 'Written summary saved',
};
