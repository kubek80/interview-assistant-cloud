// HOST-4: the schema is created and changed only by the numbered SQL files in server/db/migrations,
// applied in order by `npm run db:migrate`. Safe to run repeatedly and from several places at once:
//   - a session advisory lock makes concurrent runs (two release jobs, two developers) wait in turn;
//   - each file runs in its own transaction together with its row in schema_migrations, so a file is
//     either applied completely and recorded, or not at all;
//   - files already applied are skipped; a file that changed after it was applied is refused
//     (its checksum no longer matches), because the database would no longer match the repository.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Arbitrary constant for pg_advisory_lock: "IAMI" (Interview Assistant migrations). */
const LOCK_KEY = 0x49414d49;

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Migration file name "${file}" must look like 0001_short_name.sql`);
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({ version: Number(m[1]), name: m[2], file, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  out.forEach((f, i) => {
    if (f.version !== i + 1) throw new Error(`Migrations must be numbered 0001, 0002, … without gaps; found ${f.file} at position ${i + 1}`);
  });
  return out;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: pg.Pool, dir: string, log: (line: string) => void = () => {}): Promise<MigrateResult> {
  const files = readMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: number; checksum: string; name: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const r of rows) {
      const f = files.find((x) => x.version === r.version);
      if (!f) throw new Error(`The database has migration ${r.version} (${r.name}) that is not in ${dir}. Is this an older copy of the app?`);
      if (f.checksum !== r.checksum) throw new Error(`Migration ${f.file} was changed after it was applied. Never edit an applied migration: add a new one.`);
    }
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.version)) continue;
      log(`Applying ${f.file}`);
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [f.version, f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${f.file} failed and was rolled back: ${(err as Error).message}`);
      }
      applied.push(f.file);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
