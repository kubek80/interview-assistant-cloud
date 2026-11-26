// Serves the production build (dist/) for the local helper (AI-1). Hash routing means index.html is
// the only page; everything else is a real file. No directory listings, no traversal, no dotfiles.
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export const FALLBACK_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

/** The CSP from the built index.html's meta tag (so header and meta never drift), plus frame-ancestors. */
export async function cspFromIndex(distDir) {
  let csp = FALLBACK_CSP;
  try {
    const html = await readFile(join(distDir, 'index.html'), 'utf8');
    const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
    if (m) csp = m[1].replace(/\s+/g, ' ').trim();
  } catch {
    /* not built yet */
  }
  return /frame-ancestors/.test(csp) ? csp : `${csp.replace(/;?\s*$/, '')}; frame-ancestors 'none'`;
}

/**
 * AI-1: marks pages served by the local helper, so the app can tell (with a HEAD request for its
 * own page) whether the AI endpoints exist before calling them. A static copy of the app has no
 * such header, and the app then makes no API request at all (no 404 in the console).
 */
export const HELPER_MARKER_HEADER = 'X-Interview-Assistant-Helper';
export const HELPER_MARKER_VALUE = 'interview-assistant-ai';

export function baseHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function cacheControl(rel) {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'; // content-hashed names
  return 'no-cache'; // index.html, sw.js, favicon: always revalidate so a new build is picked up
}

function sendText(res, status, body, method) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * Creates a request handler for GET/HEAD of files under distDir. Resolves to the HTTP status sent.
 */
export function createStaticHandler(distDir) {
  const root = resolve(distDir);
  let realRoot = null;
  let csp = null;
  return async function serveStatic(req, res, pathname) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'Method not allowed', method);
      return 405;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, 'Bad request', method);
      return 400;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
      sendText(res, 400, 'Bad request', method);
      return 400;
    }
    const segments = decoded.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) {
      sendText(res, 404, 'Not found', method);
      return 404;
    }
    const rel = segments.length === 0 ? 'index.html' : segments.join('/');
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) {
      sendText(res, 404, 'Not found', method);
      return 404;
    }
    let info;
    try {
      realRoot ??= await realpath(root);
      const real = await realpath(file);
      if (!real.startsWith(realRoot + sep)) throw new Error('outside');
      info = await stat(real);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      if (rel === 'index.html') {
        sendText(res, 503, 'The app has not been built yet. Run "npm run build" (or "npm start", which builds it), then reload.', method);
        return 503;
      }
      sendText(res, 404, 'Not found', method);
      return 404;
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      ...baseHeaders(),
      [HELPER_MARKER_HEADER]: HELPER_MARKER_VALUE,
      'Content-Type': type,
      'Cache-Control': cacheControl(rel),
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = csp ??= await cspFromIndex(root);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return 304;
    }
    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (method === 'HEAD') {
      res.end();
      return 200;
    }
    await new Promise((done) => {
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy();
        done();
      });
      stream.on('end', done);
      stream.pipe(res);
    });
    return 200;
  };
}
