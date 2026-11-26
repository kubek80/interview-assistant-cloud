#!/usr/bin/env node
// Starts the local helper: the built app plus the AI second-opinion API on http://localhost:<PORT>/.
// Environment: PORT (default 4173; 0 = any free port), AI_MODEL (default: the CLI's own default),
// AI_TIMEOUT_MS (default 300000), CLAUDE_BIN (default: `claude` on PATH), DIST_DIR (default ./dist).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DEFAULT_TIMEOUT_MS, createHelperServer } from './app.mjs';

export const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1'; // AI-4: this computer only. Never 0.0.0.0.

export function configFromEnv(env = process.env) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, not "${env.PORT}".`);
  const timeout = env.AI_TIMEOUT_MS ? Number(env.AI_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('AI_TIMEOUT_MS must be at least 1000.');
  return {
    port,
    distDir: resolve(root, env.DIST_DIR || 'dist'),
    claudeBin: env.CLAUDE_BIN || 'claude',
    model: env.AI_MODEL?.trim() || null,
    timeoutMs: timeout,
  };
}

export function startHelper(config = configFromEnv()) {
  const server = createHelperServer(config);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, HOST, () => {
      const { port } = server.address();
      console.log(`Interview Assistant is running at http://localhost:${port}/`);
      console.log(`AI second opinion: ${config.model ? `model "${config.model}"` : "Claude Code's default model"}; CLI "${config.claudeBin}". Press Ctrl+C to stop.`);
      resolvePromise(server);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHelper().catch((e) => {
    console.error(e && e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use. Stop the other server or set PORT.` : `Could not start: ${e?.message ?? e}`);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
