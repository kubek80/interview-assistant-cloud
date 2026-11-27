// Builds the HTTP server: the API under /api, the health check, and the built browser app, all on
// one origin (HOST-2). Used by main.ts in production and by the server tests (with `inject`).
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { sql } from 'kysely';
import type { AppContext } from './context';
import { handleError, errorBody } from './http/errors';
import { applyHeaders, checkCsrf, securityHeaders } from './http/security';
import { registerStatic } from './http/static';
import { registerAuthRoutes } from './auth/routes';
import { registerUserRoutes } from './users/routes';
import { registerAuditRoutes } from './audit/routes';
import { registerSettingsRoutes } from './settings/routes';
import { registerBankRoutes } from './bank/routes';
import { registerLiveRoutes } from './live/routes';
import { registerReviewRoutes } from './review/routes';
import { registerRoundRoutes } from './rounds/routes';
import { registerInterviewRoutes } from './interviews/routes';
import { registerPanelRoutes } from './panel/routes';
import { describeAccess } from './http/route';

export interface BuildOptions {
  logger?: FastifyServerOptions['logger'];
  /** Serve dist/client (off in most server tests). */
  serveStatic?: boolean;
  liveHeartbeatMs?: number;
  /** Extra routes (tests use this to register a round-scoped route before step 2 exists). */
  extraRoutes?: (app: FastifyInstance, ctx: AppContext) => void;
}

/** Every registered route and who may call it (for the permission tests and the docs). */
export interface RouteInfo {
  method: string;
  url: string;
  access: string;
}

/**
 * HOST-7: what a log line may say about a request. Only the method, the path without the query
 * string (which could carry search text), the status and timing; never headers, cookies or bodies.
 */
export const logSerializers = {
  req: (req: { method: string; url: string; id: string }) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }),
  res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
};

export function defaultLogger(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: logSerializers,
    // Structured JSON on stdout; Cloud Logging reads `severity` and `message`.
    messageKey: 'message',
    formatters: { level: (label: string) => ({ severity: label.toUpperCase() }) },
    redact: { paths: ['req.headers', 'headers', 'cookie', 'cookies', 'body', 'email', 'token', '*.token', '*.email'], remove: true },
  };
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; routes: RouteInfo[] }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 100_000,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
    routerOptions: { maxParamLength: 200 },
  });
  const headers = securityHeaders(ctx.config);
  const routes: RouteInfo[] = [];

  app.decorateRequest('actor', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('round', null);
  await app.register(cookie);

  // Deny by default: an API route registered without an access rule stops the server starting.
  app.addHook('onRoute', (r) => {
    const access = r.config?.access;
    const url = r.url;
    if (!access && (url.startsWith('/api') || url === '/healthz')) throw new Error(`Route ${String(r.method)} ${url} has no access rule`);
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url, access: access ? describeAccess(access) : 'public' });
  });

  app.addHook('onRequest', async (req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url === '/healthz';
    applyHeaders(reply, headers, isApi);
    reply.header('x-request-id', req.id);
    if (req.url.startsWith('/api/')) checkCsrf(req, ctx.config);
  });

  // No CORS: preflights are refused, so no other site can send custom headers or JSON here.
  app.options('/*', { config: { access: { public: true } } }, async (_req, reply) => reply.status(405).send(errorBody('forbidden', 'Not allowed.')));

  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_req, reply) => {
    applyHeaders(reply, headers, true);
    return reply.status(404).send(errorBody('not_found', 'That was not found.'));
  });

  // HOST-7: the health check reports whether the database answers. No details beyond that.
  app.get('/healthz', { config: { access: { public: true } } }, async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(ctx.db);
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'unreachable' });
    }
  });

  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerBankRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerRoundRoutes(app, ctx);
  registerInterviewRoutes(app, ctx);
  registerPanelRoutes(app, ctx);
  registerLiveRoutes(app, ctx, { heartbeatMs: opts.liveHeartbeatMs });
  opts.extraRoutes?.(app, ctx);
  if (opts.serveStatic !== false) registerStatic(app, ctx.config.staticDir);
  else app.get('/', { config: { access: { public: true } } }, async () => ({ app: 'interview-assistant' }));

  await app.ready();
  return { app, routes };
}
