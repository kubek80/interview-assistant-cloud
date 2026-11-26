// HOST-5: live updates across every server instance, through PostgreSQL LISTEN/NOTIFY.
//
//   publish  — inside the transaction that made the change: `pg_notify('ia_live', …)`. PostgreSQL
//              delivers it only if and when that transaction commits, to every listening connection,
//              in commit order. A rolled-back change sends nothing.
//   listen   — each instance keeps one dedicated connection that LISTENs and hands each event to the
//              browsers connected to that instance (server/live/routes.ts, Server-Sent Events).
//
// Events are small invalidation hints ({ topic, kind, id? }), never data: the browser refetches
// through the normal, permission-checked API. That keeps NOTIFY's 8000-byte payload limit far away
// and means an event can never leak something its receiver may not read.
//
// Limits (also in docs/deploy/README.md): no history is kept, so a browser that was disconnected
// may have missed events; on every (re)connection the stream starts with a `ready` event and the
// browser refetches what it shows. If the LISTEN connection drops, this instance reconnects with
// back-off and then tells its subscribers to resync the same way.
import pg from 'pg';
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Executor } from '../db/pool';
import type { LiveEvent } from '../../src/shared/api';

export const LIVE_CHANNEL = 'ia_live';
const MAX_PAYLOAD = 7000;
const TOPIC_RE = /^[a-z]+(:[a-z0-9-]{1,64})?$/;

export type LiveListener = (event: LiveEvent | { topic: '*'; kind: 'resync' | 'shutdown' }) => void;

/** Publishes an event when `db`'s transaction commits (or at once, outside a transaction). */
export async function publish(db: Executor, event: LiveEvent): Promise<void> {
  if (!TOPIC_RE.test(event.topic)) throw new Error(`Bad live topic: ${event.topic}`);
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) throw new Error('Live event payload too large: send an id, not data');
  await sql`SELECT pg_notify(${LIVE_CHANNEL}, ${payload})`.execute(db);
}

export class LiveBus {
  private client: pg.Client | null = null;
  private listeners = new Map<string, Set<LiveListener>>();
  private stopped = false;
  private retryMs = 500;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clientConfig: pg.ClientConfig,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ ...this.clientConfig, application_name: 'interview-assistant-live' });
    client.on('notification', (msg) => {
      if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
      try {
        this.deliver(JSON.parse(msg.payload) as LiveEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    client.on('error', () => this.reconnectSoon(client));
    client.on('end', () => this.reconnectSoon(client));
    await client.connect();
    await client.query(`LISTEN ${LIVE_CHANNEL}`);
    this.client = client;
    this.retryMs = 500;
  }

  private reconnectSoon(failed: pg.Client) {
    if (this.stopped || this.client !== failed || this.timer) return;
    this.client = null;
    this.log.warn('live updates: database listener lost; reconnecting');
    const attempt = () => {
      this.timer = null;
      if (this.stopped) return;
      this.connect().then(
        () => {
          this.log.info('live updates: database listener reconnected');
          // Events may have been missed while disconnected: every subscriber refetches.
          for (const set of this.listeners.values()) for (const l of set) l({ topic: '*', kind: 'resync' });
        },
        () => {
          this.retryMs = Math.min(this.retryMs * 2, 30_000);
          this.timer = setTimeout(attempt, this.retryMs);
        },
      );
    };
    this.timer = setTimeout(attempt, this.retryMs);
  }

  private deliver(event: LiveEvent) {
    const set = this.listeners.get(event.topic);
    if (set) for (const l of set) l(event);
  }

  /** Calls `listener` for events on any of `topics` until the returned function is called. */
  subscribe(topics: readonly string[], listener: LiveListener): () => void {
    for (const t of topics) {
      let set = this.listeners.get(t);
      if (!set) this.listeners.set(t, (set = new Set()));
      set.add(listener);
    }
    return () => {
      for (const t of topics) {
        const set = this.listeners.get(t);
        set?.delete(listener);
        if (set && !set.size) this.listeners.delete(t);
      }
    };
  }

  /** Number of subscriptions on this instance (for tests and the health check). */
  get subscriptions(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  get listening(): boolean {
    return !!this.client;
  }

  /** Ends every open stream on this instance (shutdown); browsers reconnect to another instance. */
  closeAll(): void {
    for (const set of [...this.listeners.values()]) for (const l of [...set]) l({ topic: '*', kind: 'shutdown' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closeAll();
    if (this.timer) clearTimeout(this.timer);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => {});
  }
}
