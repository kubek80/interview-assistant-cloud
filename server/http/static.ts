// Serves the built browser app (vite build → dist/client) from the same origin as the API (HOST-2).
// Hashed files under /assets are cached for a year; index.html is never cached, so a release is
// picked up on the next load. Only files inside the directory are served (no path traversal).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function registerStatic(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  const indexPath = join(root, 'index.html');

  const sendIndex = (reply: import('fastify').FastifyReply) => {
    if (!existsSync(indexPath)) return reply.status(503).type('text/plain; charset=utf-8').send('The app has not been built yet. Run `npm run build`.');
    return reply.header('cache-control', 'no-cache').type(TYPES['.html']).send(readFileSync(indexPath));
  };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    config: { access: { public: true } },
    handler: async (req, reply) => {
      let path: string;
      try {
        path = decodeURIComponent(req.url.split('?')[0] ?? '/');
      } catch {
        return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      }
      if (path.startsWith('/api/') || path === '/api') {
        return reply.status(404).send({ error: { code: 'not_found', message: 'That was not found.' } });
      }
      if (path === '/' || path === '/index.html') return sendIndex(reply);
      const file = normalize(join(root, path));
      if (!file.startsWith(root + sep) || path.includes('\0')) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      if (existsSync(file) && statSync(file).isFile()) {
        const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        reply.header('cache-control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
        return reply.type(type).send(createReadStream(file));
      }
      // Hash routing: every screen is under "/#/…", so other paths are simply not found.
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    },
  });
}
