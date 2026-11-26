#!/usr/bin/env node
// `npm run dev`: the API server (tsx watch, restarts on change) and the Vite dev server (hot reload)
// together. Open http://localhost:5173 — Vite forwards /api to the API server on port 8080, so the
// browser sees one origin, as in production. Settings come from .env (copy .env.example).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const env = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} else {
  console.warn('No .env file: copy .env.example to .env first (see README).');
}
env.PORT ??= '8080';
env.PUBLIC_URL ??= 'http://localhost:5173';

const run = (name, args) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', ...args], { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`${name} stopped (${code ?? 'signal'})`);
    process.exit(code ?? 0);
  });
  return child;
};
const children = [run('API server', ['dev:server']), run('Vite', ['dev:client'])];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
