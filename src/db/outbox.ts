// HOST-6, RES-1, RES-3: the queue of my own record changes that the server has not confirmed yet.
//
// Every change to my record (a tick, a score, a note, the overall assessment) is added here first and
// shown at once (the screens apply the queued ops on top of the server's copy with the same function
// the server uses, src/domain/live.ts applyRecordOp). The queue is sent in order, in batches, as soon
// as it can be; while the server cannot be reached it waits and tries again, and it is kept in
// localStorage so a reload (or closing the tab) loses nothing. Ops set values and notes carry their
// own ids, so a batch the server applied but whose reply was lost is harmless to send again.
//
// Scope: only unsent changes of the signed-in person's own records, under one key per person, and
// nothing once they are sent. Shared commands (Next, Pause, the lead) are never queued: they only
// make sense at the moment they are given (LIVE-2).
import type { RecordOp } from '../shared/api';

export interface PendingOp {
  /** Increasing per queue; the order the changes were made in. */
  seq: number;
  recordId: string;
  op: RecordOp;
  /** When it was made (browser time), to drop very old leftovers. */
  at: number;
}

export type OutboxState =
  /** Nothing waiting. */
  | 'saved'
  /** Sending now. */
  | 'saving'
  /** The server cannot be reached; changes are kept here and sent when it can. */
  | 'offline';

export interface OutboxSnapshot {
  state: OutboxState;
  pending: readonly PendingOp[];
}

/** Sends one batch of a record's ops; resolves with the server's copy of the record. */
export type Sender = (recordId: string, ops: RecordOp[]) => Promise<unknown>;

/** How a failed send should be treated: try again later, or drop the batch (it can never succeed). */
export type FailureKind = 'retry' | 'drop';

export interface OutboxOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  key: string;
  send: Sender;
  classify: (err: unknown) => FailureKind;
  onSent?: (recordId: string, result: unknown) => void;
  onDropped?: (recordId: string, err: unknown) => void;
  /** Back-off between retries (ms). */
  retryDelays?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

const MAX_BATCH = 200;
/** Leftovers older than this are dropped when the queue is loaded. */
const MAX_AGE_MS = 7 * 24 * 3600_000;

/**
 * Consecutive edits of the same note collapse into the last one, so typing while offline queues a
 * few ops rather than hundreds. Nothing else is merged: the order of everything else is kept.
 */
export function compact(ops: readonly PendingOp[]): PendingOp[] {
  const out: PendingOp[] = [];
  for (const p of ops) {
    const last = out[out.length - 1];
    if (last && last.recordId === p.recordId && last.op.t === 'note.edit' && p.op.t === 'note.edit' && last.op.id === p.op.id) {
      out[out.length - 1] = { ...p, op: { ...p.op, by: p.op.by !== undefined ? p.op.by : last.op.by } };
    } else out.push(p);
  }
  return out;
}

/** The next batch to send: the oldest ops of one record, in order, up to MAX_BATCH. */
export function nextBatch(ops: readonly PendingOp[]): PendingOp[] {
  if (!ops.length) return [];
  const recordId = ops[0].recordId;
  const batch: PendingOp[] = [];
  for (const p of ops) {
    if (p.recordId !== recordId || batch.length >= MAX_BATCH) break;
    batch.push(p);
  }
  return batch;
}

export class Outbox {
  private ops: PendingOp[] = [];
  private seq = 0;
  private sending = false;
  private offline = false;
  private attempt = 0;
  private timer: unknown = null;
  private listeners = new Set<() => void>();
  private snapshot: OutboxSnapshot = { state: 'saved', pending: [] };
  private waiters: Array<() => void> = [];

  constructor(private readonly o: OutboxOptions) {
    this.load();
  }

  private load() {
    try {
      const raw = this.o.storage?.getItem(this.o.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PendingOp[];
      const now = (this.o.now ?? Date.now)();
      if (Array.isArray(parsed)) this.ops = parsed.filter((p) => p && typeof p.recordId === 'string' && p.op && now - (p.at ?? 0) < MAX_AGE_MS);
      this.seq = this.ops.reduce((m, p) => Math.max(m, p.seq), 0);
    } catch {
      this.ops = [];
    }
    this.publish();
  }

  private persist() {
    try {
      if (!this.o.storage) return;
      if (this.ops.length) this.o.storage.setItem(this.o.key, JSON.stringify(this.ops));
      else this.o.storage.removeItem(this.o.key);
    } catch {
      // Storage full or unavailable: the queue still holds the changes for this page view.
    }
  }

  private publish() {
    const state: OutboxState = this.offline && this.ops.length ? 'offline' : this.ops.length || this.sending ? 'saving' : 'saved';
    this.snapshot = { state, pending: this.ops };
    for (const l of this.listeners) l();
    if (!this.ops.length) {
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): OutboxSnapshot => this.snapshot;

  /** Queued ops of one record, oldest first (to show on top of the server's copy). */
  pendingFor(recordId: string): RecordOp[] {
    return this.ops.filter((p) => p.recordId === recordId).map((p) => p.op);
  }

  add(recordId: string, ops: readonly RecordOp[]): void {
    if (!ops.length) return;
    const at = (this.o.now ?? Date.now)();
    this.ops = compact([...this.ops, ...ops.map((op) => ({ seq: ++this.seq, recordId, op, at }))]);
    this.persist();
    this.publish();
    this.flush();
  }

  /** Sends what is waiting (now, unless a send is already running). Called after changes, on reconnect and on a timer. */
  flush = (): void => {
    if (this.sending || !this.ops.length) return;
    if (this.timer) {
      (this.o.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
    const batch = nextBatch(this.ops);
    const recordId = batch[0].recordId;
    this.sending = true;
    this.publish();
    this.o
      .send(
        recordId,
        batch.map((p) => p.op),
      )
      .then(
        (result) => {
          const sent = new Set(batch.map((p) => p.seq));
          this.ops = this.ops.filter((p) => !sent.has(p.seq));
          this.offline = false;
          this.attempt = 0;
          this.o.onSent?.(recordId, result);
        },
        (err) => {
          if (this.o.classify(err) === 'drop') {
            // The server refused it for good (e.g. the record was submitted meanwhile): drop it, say so.
            const sent = new Set(batch.map((p) => p.seq));
            this.ops = this.ops.filter((p) => !sent.has(p.seq));
            this.o.onDropped?.(recordId, err);
          } else {
            this.offline = true;
            const delays = this.o.retryDelays ?? [1000, 2000, 4000, 8000, 10000];
            const delay = delays[Math.min(this.attempt, delays.length - 1)];
            this.attempt++;
            this.timer = (this.o.setTimer ?? setTimeout)(() => {
              this.timer = null;
              this.flush();
            }, delay);
          }
        },
      )
      .finally(() => {
        this.sending = false;
        this.persist();
        this.publish();
        if (!this.offline && this.ops.length) this.flush();
      });
  };

  /** Resolves when nothing is waiting any more (used before submitting). */
  drained(): Promise<void> {
    if (!this.ops.length && !this.sending) return Promise.resolve();
    this.flush();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get isOffline(): boolean {
    return this.offline;
  }
}
