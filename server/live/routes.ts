// HOST-5: GET /api/live — Server-Sent Events carrying live updates to the browser.
//
//   GET /api/live?topic=bank&topic=users
//
// Each topic is checked against the actor's permissions when the stream opens (topicAllowed), and
// the session is checked again every heartbeat: a person who is deactivated or signed out stops
// receiving events within one heartbeat, and at once when their `user:<id>` topic says "revoked".
// Streams end after LIVE_STREAM_MAX_MINUTES; EventSource reconnects by itself (retry: 3s), and each
// new stream starts with `event: ready`, on which the browser refetches what it shows. That covers
// anything missed while disconnected and the Cloud Run request timeout.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { route } from '../http/route';
import { invalid } from '../http/errors';
import { can, type Actor } from '../authz/policy';
import { lookupSession, sessionTokenOf } from '../auth/sessions';
import type { LiveEvent } from '../../src/shared/api';

const HEARTBEAT_MS = 20_000;

/** Which topics a person may follow. Step 2 adds `round:<id>` (round.read on that round). */
export async function topicAllowed(ctx: AppContext, actor: Actor, topic: string): Promise<boolean> {
  if (topic === 'bank') return can(actor, 'bank.read');
  if (topic === 'users') return can(actor, 'users.read');
  if (topic === 'audit') return can(actor, 'audit.read');
  if (topic === `user:${actor.id}`) return true;
  void ctx;
  return false;
}

export function registerLiveRoutes(app: FastifyInstance, ctx: AppContext, opts: { heartbeatMs?: number } = {}): void {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  route(app, ctx, {
    method: 'GET',
    url: '/api/live',
    access: { signedIn: true },
    query: z.object({ topic: z.union([z.string().max(80), z.array(z.string().max(80)).max(20)]) }).strict(),
    handler: async ({ req, reply, actor, query }) => {
      const requested = [...new Set(Array.isArray(query.topic) ? query.topic : [query.topic])];
      for (const t of requested) if (!(await topicAllowed(ctx, actor, t))) throw invalid(`You cannot follow "${t}".`);
      const topics = [...requested, `user:${actor.id}`];
      const token = sessionTokenOf(req, ctx.config);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(beat);
        clearTimeout(maxTimer);
        res.end();
      };
      const unsubscribe = ctx.live.subscribe(topics, (e) => {
        if (e.topic === `user:${actor.id}` && (e as LiveEvent).kind === 'revoked') {
          send('revoked', {});
          return close();
        }
        if (e.topic === '*' && e.kind === 'shutdown') return close();
        if (e.topic === '*') send('ready', { resync: true });
        else send('change', e);
      });
      const beat = setInterval(async () => {
        try {
          const still = await lookupSession(ctx.db, ctx.config, token);
          if (!still || still.actor.id !== actor.id) {
            send('revoked', {});
            return close();
          }
          if (!closed) res.write(': ping\n\n');
        } catch {
          /* a database hiccup: try again next beat */
        }
      }, heartbeatMs);
      const maxTimer = setTimeout(close, ctx.config.liveStreamMaxMs);
      req.raw.on('close', close);
      res.write('retry: 3000\n\n');
      send('ready', { topics: requested });
    },
  });
}
