import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Emits sw.js at build time with a precache list of every emitted file (OV-1).
 * The app uses hash routing, so index.html is the only navigation entry point.
 *
 * The cache version is a hash of the CONTENT of every precached file (and of index.html), so any
 * change in a deploy, including one to index.html or a public file whose name does not change,
 * produces a new sw.js. The browser then installs it, it takes over at once (skipWaiting +
 * clients.claim) and deletes the old cache, so a user is at most one page load behind a deploy.
 */
export function serviceWorker(root: string): Plugin {
  return {
    name: 'precache-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const publicDir = resolve(root, 'public');
      const publicFiles = listFiles(publicDir).map((f) => relative(publicDir, f).split('\\').join('/'));
      const emitted = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const files = ['./', ...emitted.filter((f) => f !== 'index.html'), ...publicFiles].map((f) => (f === './' ? f : './' + f));
      const hash = createHash('sha256');
      for (const name of emitted.sort()) {
        const item = bundle[name];
        hash.update(name).update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      for (const f of publicFiles.sort()) hash.update(f).update(readFileSync(join(publicDir, f)));
      const indexHtml = resolve(root, 'index.html');
      if (existsSync(indexHtml)) hash.update(readFileSync(indexHtml));
      const version = hash.digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, files) });
    },
  };
}

function swSource(version: string, files: string[]): string {
  return `// Generated at build time. Precaches the app shell so it works offline (OV-1).
const CACHE = 'interview-assistant-${version}';
const PRECACHE = ${JSON.stringify(files, null, 2)};

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a new version never precaches a stale index.html.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('interview-assistant-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The local AI helper's API (AI-1) is never cached or answered from the cache.
  if (url.pathname.includes('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./', { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(request)));
    return;
  }
  event.respondWith(caches.match(request, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(request)));
});
`;
}
