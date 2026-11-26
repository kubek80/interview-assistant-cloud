import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { migrate, readMigrations } from './migrate';
import { createTestDb, type TestDb } from '../test/harness';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ empty: true });
});
afterAll(async () => t.drop());

describe('migrations', () => {
  it('HOST-4: applies every numbered migration once, records it, and a second run applies nothing', async () => {
    const first = await migrate(t.pool, 'server/db/migrations');
    expect(first.applied).toEqual(readMigrations('server/db/migrations').map((m) => m.file));
    const second = await migrate(t.pool, 'server/db/migrations');
    expect(second).toEqual({ applied: [], alreadyApplied: first.applied.length });
    const { rows } = await sql<{ version: number }>`SELECT version FROM schema_migrations ORDER BY version`.execute(t.db);
    expect(rows.map((r) => r.version)).toEqual(first.applied.map((_, i) => i + 1));
  });

  it('HOST-4: concurrent runs wait for each other and apply nothing twice', async () => {
    const results = await Promise.all([migrate(t.pool, 'server/db/migrations'), migrate(t.pool, 'server/db/migrations')]);
    expect(results.every((r) => r.applied.length === 0)).toBe(true);
  });

  it('HOST-4: a failing migration is rolled back completely and not recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync('server/db/migrations', dir, { recursive: true });
    const n = readMigrations(dir).length + 1;
    writeFileSync(join(dir, `${String(n).padStart(4, '0')}_broken.sql`), 'CREATE TABLE half_done (id int); SELECT no_such_function();');
    await expect(migrate(t.pool, dir)).rejects.toThrow(/broken.sql failed and was rolled back/);
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'half_done'`.execute(t.db);
    expect(rows[0].n).toBe(0);
  });

  it('HOST-4: refuses to run when an applied migration file was edited afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync('server/db/migrations', dir, { recursive: true });
    writeFileSync(join(dir, '0001_foundation.sql'), '-- edited\n');
    await expect(migrate(t.pool, dir)).rejects.toThrow(/was changed after it was applied/);
  });

  it('HPRIV-4 AUD-1: the audit table refuses updates and deletes', async () => {
    await sql`INSERT INTO audit_events (actor_label, action, entity) VALUES ('system', 'test.entry', 'audit')`.execute(t.db);
    await expect(sql`UPDATE audit_events SET reason = 'x'`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_events`.execute(t.db)).rejects.toThrow(/append-only/);
  });

  it('DB-1: constraints keep bad bank data out even past the API', async () => {
    await sql`INSERT INTO tracks (id, name, version) VALUES ('zz', 'Z track', '2026.11')`.execute(t.db);
    await sql`INSERT INTO categories (id, track_id, name) VALUES ('zz-a', 'zz', 'A')`.execute(t.db);
    const q = (id: string, number: number, extra = '') =>
      sql.raw(`INSERT INTO questions (id, track_id, number, category_id, text, description, difficulty, type, time_min, look_for, red_flags, probes) VALUES ('${id}', 'zz', ${number}, 'zz-a', 't', 'd', 'core', 'knowledge', 3, '[]', '[]', '[]')${extra}`).execute(t.db);
    await q('zz-1', 1);
    await expect(q('zz-9', 2)).rejects.toThrow(); // id must be <track>-<number>
    await expect(q('zz-1', 1)).rejects.toThrow(); // unique
    await expect(sql`UPDATE questions SET difficulty = 'impossible'`.execute(t.db)).rejects.toThrow();
    await expect(sql`INSERT INTO users (email, role) VALUES ('Upper@Example.com', 'admin')`.execute(t.db)).rejects.toThrow();
    await expect(sql`INSERT INTO users (email, role) VALUES ('a@example.com', 'owner')`.execute(t.db)).rejects.toThrow();
  });
});
