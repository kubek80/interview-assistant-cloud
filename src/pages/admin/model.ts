// Pure helpers for the Admin screen (PRIV-5, PRIV-6, AUD-1…3, BANK-7).
import type { AuditAction, AuditEntity, AuditEvent, Question } from '../../domain/types';
import type { AuditFilter } from '../../db/audit';

const DAY_MS = 86_400_000;

/** Whole days from `today` to `date` (both YYYY-MM-DD, local calendar days). */
export function daysBetween(today: string, date: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.round((b - a) / DAY_MS);
}

export interface RetentionStatus {
  /** PRIV-5: purged when the retention date is before today (purgeExpired uses "below today"). */
  expired: boolean;
  daysLeft: number;
  label: string;
}

/** PRIV-5: the retention date is the last day the session is kept. */
export function retentionStatus(retentionUntil: string, today: string): RetentionStatus {
  const daysLeft = daysBetween(today, retentionUntil);
  if (daysLeft < 0) return { expired: true, daysLeft, label: `Expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago` };
  if (daysLeft === 0) return { expired: false, daysLeft, label: 'Last day today' };
  return { expired: false, daysLeft, label: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` };
}

export const ENTITY_LABELS: Record<AuditEntity, string> = {
  plan: 'Plan',
  session: 'Interview',
  answer: 'Answer',
  track: 'Question bank track',
  category: 'Category',
  question: 'Question',
  audit: 'Audit log',
  device: 'This device',
  invitation: 'Planned interview',
  panel: 'Panel decision and summary',
  user: 'Person',
  settings: 'Settings',
};

/** AUD-1: entity column text, e.g. "Interview 3f9a1c2b" (ids are random, PRIV-3). */
export function auditEntityText(e: Pick<AuditEvent, 'entity' | 'entityId'>): string {
  const label = ENTITY_LABELS[e.entity] ?? e.entity;
  if (!e.entityId) return label;
  // Bank ids are short and meaningful ("aks", "aks-11", "aks-networking"); other ids are UUIDs, shortened for display.
  const bank = e.entity === 'track' || e.entity === 'question' || e.entity === 'category';
  return `${label} ${bank ? e.entityId : e.entityId.slice(0, 8)}`;
}

/** AUD-1 before/after values as readable JSON (rendered as text, never HTML: SEC-2). */
export function auditValueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export interface AuditFilterForm {
  action: AuditAction | string;
  from: string;
  to: string;
  text: string;
}

/**
 * AUD-3: builds the repository filter from the form (empty fields mean "any"). The date fields are
 * local calendar days; audit times are UTC ISO timestamps, so each day is converted to the UTC
 * instants of its local start and end (otherwise entries near midnight fall on the wrong day).
 */
export function toAuditFilter(f: AuditFilterForm): AuditFilter {
  const filter: AuditFilter = {};
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (f.action) filter.action = f.action;
  if (f.from) filter.from = day.test(f.from) ? new Date(`${f.from}T00:00:00`).toISOString() : f.from;
  if (f.to) filter.to = day.test(f.to) ? new Date(`${f.to}T23:59:59.999`).toISOString() : f.to;
  if (f.text.trim()) filter.q = f.text.trim();
  return filter;
}

/** BANK-7 counts for one track. */
export function bankCounts(questions: readonly Pick<Question, 'status'>[]): { total: number; active: number; retired: number } {
  const retired = questions.filter((q) => q.status === 'retired').length;
  return { total: questions.length, active: questions.length - retired, retired };
}
