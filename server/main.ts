// Starts the server: `npm start` (built) or `npm run dev:server` (from source with tsx).
// Configuration: environment variables (.env.example). Listens on $PORT (Cloud Run sets it).
import { ConfigError, describeConfig, loadConfig } from './config';
import { createDb, createPool } from './db/pool';
import { LiveBus } from './live/bus';
import { createOidcProvider, GOOGLE_ISSUER } from './auth/oidc';
import { RateLimiter } from './http/route';
import { buildApp, defaultLogger } from './app';
import type { AppContext } from './context';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const pool = createPool({ databaseUrl: config.databaseUrl, databasePassword: config.databasePassword, max: config.databasePoolMax });
  const db = createDb(pool);
  const logger = defaultLogger(config.logLevel);
  const live = new LiveBus({ connectionString: config.databaseUrl, ...(config.databasePassword ? { password: config.databasePassword } : {}) }, { warn: (m: string) => console.warn(m), info: (m: string) => console.info(m) });
  const ctx: AppContext = {
    config,
    pool,
    db,
    live,
    oidc: config.google ? createOidcProvider({ issuer: GOOGLE_ISSUER, ...config.google }) : null,
    rateLimiter: new RateLimiter(),
  };
  const { app } = await buildApp(ctx, { logger });
  try {
    await live.start();
  } catch {
    app.log.warn('live updates: could not listen on the database yet; retrying in the background');
  }
  app.log.info({ config: describeConfig(config) }, 'starting');
  if (config.devSignIn) app.log.warn('Development sign-in is ON. Never enable DEV_SIGN_IN on a real deployment.');
  await app.listen({ port: config.port, host: config.host });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'stopping');
    // Cloud Run sends SIGTERM and allows ~10 s: stop accepting, let requests finish, close the pool.
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    live.closeAll();
    await app.close().catch(() => {});
    await live.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

void main();
