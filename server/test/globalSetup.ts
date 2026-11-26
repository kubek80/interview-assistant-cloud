// Creates and migrates the template database every server test file clones (see harness.ts).
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createPool } from '../db/pool';
import { migrate } from '../db/migrate';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://ia@127.0.0.1:54329/ia_test';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string;
    adminUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const template = `ia_tpl_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Server tests need PostgreSQL at ${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')} — start one with \`npm run db:start\` or set TEST_DATABASE_URL. (${(err as Error).message})`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${template}`);
  await admin.query(`CREATE DATABASE ${template}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${template}`;
  const pool = createPool({ databaseUrl: url.href, max: 1 });
  await migrate(pool, 'server/db/migrations');
  await pool.end();
  project.provide('templateDb', template);
  project.provide('adminUrl', ADMIN_URL);
  return async () => {
    // Leftover per-file databases (from a crashed run) and the template.
    const { rows } = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE $2 OR datname = $1`, [template, `ia_t_${process.pid}_%`]);
    for (const r of rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`).catch(() => {});
    await admin.end();
  };
}
