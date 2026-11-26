// The PostgreSQL connection pool and the typed query builder (Kysely over node-postgres). Every
// query is parameterised by Kysely; raw SQL is written only with its `sql` tag, which also binds
// values as parameters. Nothing builds SQL by string concatenation.
import pg from 'pg';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { Database } from './schema';

// numeric → number (category weights), int8 → number (audit ids and counts stay far below 2^53),
// date → the plain 'YYYY-MM-DD' string (retention dates are calendar days).
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v);

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Either the database or an open transaction. */
export type Executor = Db | Tx;

export interface PoolOptions {
  databaseUrl: string;
  databasePassword?: string;
  max?: number;
  applicationName?: string;
}

export function createPool(o: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: o.databaseUrl,
    ...(o.databasePassword ? { password: o.databasePassword } : {}),
    max: o.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: o.applicationName ?? 'interview-assistant',
    // A runaway query never holds a request (or a connection) for long.
    statement_timeout: 30_000,
  });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on('error', () => {});
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** JSON text for a jsonb column. */
export const json = (value: unknown): string => JSON.stringify(value ?? null);
