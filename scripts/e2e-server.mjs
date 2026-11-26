#!/usr/bin/env node
// Starts the built app for the end-to-end tests (playwright.config.ts): a fresh database
// (E2E_DATABASE, default ia_e2e) migrated and seeded with the same commands a deployment uses, three
// test users, then the production server (dist/server/main.js) with development sign-in.
// Server output is also written to test-results/e2e-server.log so a test can check what it logs.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import pg from 'pg';

const admin = process.env.TEST_DATABASE_URL ?? 'postgres://ia@127.0.0.1:54329/ia_test';
const name = process.env.E2E_DATABASE ?? 'ia_e2e';
const port = process.env.PORT ?? '4173';
const url = new URL(admin);
url.pathname = `/${name}`;

const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${name}`);
await c.end();

const env = { ...process.env, DATABASE_URL: url.href };
const cli = (...args) => execFileSync(process.execPath, ['dist/server/cli.js', ...args], { env, stdio: 'inherit' });
cli('migrate');
cli('seed');
const db = new pg.Client({ connectionString: url.href });
await db.connect();
await db.query(`INSERT INTO users (email, role, name) VALUES
  ('admin@example.test', 'admin', 'Ada Admin'),
  ('organiser@example.test', 'organiser', 'Olive Organiser'),
  ('interviewer@example.test', 'interviewer', 'Ian Interviewer'),
  ('reviewer@example.test', 'reviewer', 'Rita Reviewer'),
  ('reviewer2@example.test', 'reviewer', 'Remy Reviewer')`);
await db.end();

mkdirSync('test-results', { recursive: true });
const log = createWriteStream('test-results/e2e-server.log', { flags: 'w' });
const server = spawn(process.execPath, ['dist/server/main.js'], {
  env: {
    ...env,
    NODE_ENV: 'test',
    PORT: port,
    PUBLIC_URL: `http://localhost:${port}`,
    SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    DEV_SIGN_IN: 'true',
    BOOTSTRAP_ADMINS: 'boot-admin@example.test',
    LOG_LEVEL: 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
server.stdout.pipe(log);
server.stderr.pipe(log);
const stop = () => server.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));
