// What every route handler can reach. Built once per process in main.ts (and per test in the harness).
import type pg from 'pg';
import type { Config } from './config';
import type { Db } from './db/pool';
import type { LiveBus } from './live/bus';
import type { OidcProvider } from './auth/oidc';
import type { RateLimiter } from './http/route';

export interface AppContext {
  config: Config;
  pool: pg.Pool;
  db: Db;
  live: LiveBus;
  /** Google sign-in; null when only development sign-in is configured. */
  oidc: OidcProvider | null;
  rateLimiter: RateLimiter;
}
