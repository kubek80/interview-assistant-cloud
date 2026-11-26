import { db, SETTINGS } from './db';
import type { AuditAction, AuditEntity, AuditEvent } from '../domain/types';

/** Error with a message that is safe to show to the user (it never contains candidate data). */
export class RepoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

/**
 * Random UUID v4 from getRandomValues, which (unlike crypto.randomUUID) also works outside
 * secure contexts. Used for every record id, so URLs never carry candidate data (PRIV-3).
 */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Injectable clock so tests can control time. */
export const clock = { now: () => Date.now() };
export const nowIso = () => new Date(clock.now()).toISOString();

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export async function currentActor(fallback?: string): Promise<string> {
  const name = await getSetting<string>(SETTINGS.interviewerName);
  return name?.trim() || fallback?.trim() || 'Unknown';
}

export interface AuditInput {
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Used when no interviewer name is set on this device. */
  actorFallback?: string;
}

/**
 * AUD-1: the only way to add audit entries. There is deliberately no API to edit or delete an
 * individual entry; the only other writes are erase-all (PRIV-6) and the redaction of candidate
 * text in amendment entries when that candidate's session is deleted (privacy.ts).
 * Call inside a transaction that includes db.audit and db.settings.
 */
export async function appendAudit(input: AuditInput): Promise<number> {
  const event: AuditEvent = {
    ts: nowIso(),
    actor: await currentActor(input.actorFallback),
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
  };
  return (await db.audit.add(event)) as number;
}
