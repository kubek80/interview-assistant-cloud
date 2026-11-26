#!/usr/bin/env node
// `npm start`: build the app if dist/ is missing or older than its sources, then start the helper.
// Set SKIP_BUILD=1 to serve dist/ as it is.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = ['src', 'docs', 'seed', 'public', 'content', 'schema', 'vite-plugins', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'];

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return /\.test\.tsx?$/.test(path) ? 0 : info.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

export function needsBuild(dir = root) {
  const built = join(dir, 'dist', 'index.html');
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  return SOURCES.some((s) => newestMtime(join(dir, s)) > builtAt);
}

if (process.env.SKIP_BUILD !== '1' && needsBuild()) {
  console.log('Building the app (dist/ is missing or out of date)...');
  // Windows needs a shell to run npm.cmd; the command is fixed (no user input).
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('The build failed; not starting.');
    process.exit(r.status ?? 1);
  }
}

await import('./index.mjs').then(({ startHelper }) =>
  startHelper().catch((e) => {
    console.error(e && e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use. Stop the other server or set PORT.` : `Could not start: ${e?.message ?? e}`);
    process.exit(1);
  }),
);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
