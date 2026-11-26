// DB-2, DB-3: importing track files and CSV files, from the command line and from the app.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { csvTrackFromName, formatReport, importQuestions } from './import';
import type { ImportFileInput } from '../../src/shared/api';

const run = promisify(execFile);
const SYSTEM = { system: 'test' };
const seedText = (id: string) => readFileSync(`seed/${id}.json`, 'utf8');
const seedFiles = (): ImportFileInput[] => ['aks', 'edge', 'qa', 'web'].map((id) => ({ name: `${id}.json`, text: seedText(id) }));
const count = async (db: TestDb['db'], table: 'questions' | 'question_versions' | 'audit_events') => Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t.drop());

describe('importing questions', () => {
  it('DB-2: a dry run validates and reports everything but writes nothing', async () => {
    const r = await importQuestions(t.db, SYSTEM, seedFiles(), { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.tracks.map((x) => [x.trackId, x.trackAction, x.added.length])).toEqual([
      ['aks', 'create', 50],
      ['edge', 'create', 53],
      ['qa', 'create', 50],
      ['web', 'create', 54],
    ]);
    expect(await count(t.db, 'questions')).toBe(0);
    expect(await count(t.db, 'audit_events')).toBe(0);
    expect(formatReport(r)).toMatch(/Total: 207 added, 0 changed, 0 unchanged\.\nDry run: nothing was written\./);
  });

  it('DB-2 DB-3 BANK-1 OV-2 MVP-4: the bundled files import all 207 questions with their versions; a second run changes nothing', async () => {
    const first = await importQuestions(t.db, SYSTEM, seedFiles(), { dryRun: false });
    expect(first.applied).toBe(true);
    expect(await count(t.db, 'questions')).toBe(207);
    expect(await count(t.db, 'question_versions')).toBe(207);
    const audits = await count(t.db, 'audit_events');
    const again = await importQuestions(t.db, SYSTEM, seedFiles(), { dryRun: false });
    expect(again.tracks.every((x) => x.trackAction === 'unchanged' && x.added.length === 0 && x.changed.length === 0)).toBe(true);
    expect(again.tracks.reduce((n, x) => n + x.unchanged, 0)).toBe(207);
    expect(await count(t.db, 'audit_events')).toBe(audits);
    expect(formatReport(again)).toMatch(/Nothing to change\.$/);
  });

  it('DB-2 BANK-11 BANK-4: a changed question gets a new version; its earlier version stays in the history', async () => {
    const file = JSON.parse(seedText('qa'));
    const q = file.questions[0];
    q.text = `${q.text} Changed.`;
    const r = await importQuestions(t.db, SYSTEM, [{ name: 'qa.json', text: JSON.stringify(file) }], { dryRun: false });
    expect(r.tracks[0].changed).toEqual([{ id: q.id, number: q.number, text: expect.any(String), fromVersion: q.version, toVersion: q.version + 1, fields: ['text'] }]);
    const versions = await t.db.selectFrom('question_versions').select('version').where('question_id', '=', q.id).orderBy('version').execute();
    expect(versions.map((v) => v.version)).toEqual([q.version, q.version + 1]);
    const audit = await t.db.selectFrom('audit_events').selectAll().where('entity_id', '=', q.id).where('action', '=', 'bank.question_edited').executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Imported from qa.json');
    // Same file again: nothing changes.
    const again = await importQuestions(t.db, SYSTEM, [{ name: 'qa.json', text: JSON.stringify(file) }], { dryRun: false });
    expect(again.tracks[0].changed).toEqual([]);
  });

  it('DB-2: a question edited in the app since (newer in the database) is kept, not overwritten by an older file', async () => {
    const r = await importQuestions(t.db, SYSTEM, [{ name: 'qa.json', text: seedText('qa') }], { dryRun: true });
    const q = JSON.parse(seedText('qa')).questions[0];
    expect(r.tracks[0].keptNewer).toEqual([{ id: q.id, number: q.number, databaseVersion: q.version + 1, fileVersion: q.version }]);
    expect(formatReport(r)).toMatch(/kept as they are \(newer in the database than in the file\): 1/);
  });

  it('DB-2 SEC-2 BANK-7: any problem in any file means nothing is imported, and every problem is listed by file', async () => {
    const before = await count(t.db, 'questions');
    const broken = JSON.parse(seedText('web'));
    broken.questions[1].categoryId = 'web-nowhere';
    const brokenAks = JSON.parse(seedText('aks'));
    brokenAks.questions[0].difficulty = 'impossible';
    const newTrack = JSON.parse(seedText('web'));
    newTrack.track.id = 'web2';
    newTrack.categories.forEach((c: { id: string }) => (c.id = c.id.replace(/^web-/, 'web2-')));
    newTrack.questions.forEach((q: { id: string; number: number; categoryId: string }) => {
      q.id = `web2-${q.number}`;
      q.categoryId = q.categoryId.replace(/^web-/, 'web2-');
    });
    const r = await importQuestions(t.db, SYSTEM, [{ name: 'web2.json', text: JSON.stringify(newTrack) }, { name: 'web.json', text: JSON.stringify(broken) }, { name: 'aks.json', text: JSON.stringify(brokenAks) }, { name: 'notes.txt', text: 'hello' }], { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.source)).toEqual(['web.json', 'aks.json', 'notes.txt']);
    expect(r.problems[0].messages.join('\n')).toMatch(/unknown category web-nowhere/);
    expect(r.problems[1].messages.join('\n')).toMatch(/difficulty/);
    expect(await count(t.db, 'questions')).toBe(before);
    expect(await t.db.selectFrom('tracks').select('id').where('id', '=', 'web2').executeTakeFirst()).toBeUndefined();
    expect(formatReport(r)).toMatch(/^Problems found — nothing was imported:/);
  });

  it('DB-2 BANK-13: a CSV file adds new rows and updates rows whose question text matches, for the track it names', async () => {
    const csv = [
      'Question,Description,Category,Difficulty,Type,Key points,Red flags,Probes,Time (min)',
      '"How would you test a payments retry?","About retries.","Strategy & risk",advanced,scenario,"A;B","C","D?",',
    ].join('\n');
    expect(csvTrackFromName('qa-questions-2026-11-26.csv', ['qa'])).toBe('qa');
    expect(csvTrackFromName('other.csv', ['qa'])).toBeNull();
    const add = await importQuestions(t.db, SYSTEM, [{ name: 'qa-questions.csv', text: csv }], { dryRun: false });
    expect(add.tracks[0].added).toEqual([{ id: 'qa-51', number: 51, text: 'How would you test a payments retry?' }]);
    const again = await importQuestions(t.db, SYSTEM, [{ name: 'extra.csv', text: csv, trackId: 'qa' }], { dryRun: false });
    expect(again.tracks[0]).toMatchObject({ added: [], changed: [], unchanged: 1 });
    const changed = await importQuestions(t.db, SYSTEM, [{ name: 'extra.csv', text: csv.replace('"A;B"', '"A;B;E"'), trackId: 'qa' }], { dryRun: false });
    expect(changed.tracks[0].changed).toEqual([expect.objectContaining({ id: 'qa-51', fromVersion: 1, toVersion: 2, fields: ['lookFor'] })]);
    const unknown = await importQuestions(t.db, SYSTEM, [{ name: 'x.csv', text: csv }], { dryRun: true });
    expect(unknown.problems[0].messages[0]).toMatch(/Say which track/);
  });
});

describe('the command line', () => {
  const env = () => ({ ...process.env, DATABASE_URL: t.url });
  const tsx = (args: string[]): Promise<{ stdout: string; stderr: string; code?: number }> =>
    run(process.execPath, ["--import", "tsx", "server/cli.ts", ...args], { env: env() }).catch((e) => e as { stdout: string; stderr: string; code: number });

  it('DB-2: `db:import-questions --dry-run` prints the report and changes nothing; a broken file exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imp-'));
    const file = JSON.parse(seedText('aks'));
    file.questions[2].probes.push('One more probe?');
    writeFileSync(join(dir, 'aks.json'), JSON.stringify(file));
    const out = await tsx(['import-questions', join(dir, 'aks.json'), '--dry-run']);
    expect(out.stdout).toMatch(/aks — Senior Platform Engineer \(AKS with Azure\) \(aks\.json\): changes/);
    const was = file.questions[2].version;
    expect(out.stdout).toContain(`aks-3: version ${was} → ${was + 1} (probes)`);
    expect(out.stdout).toMatch(/Dry run: nothing was written\./);
    const v = await t.db.selectFrom('questions').select('version').where('id', '=', 'aks-3').executeTakeFirstOrThrow();
    expect(v.version).toBe(was);
    writeFileSync(join(dir, 'bad.json'), '{"track":{}}');
    const bad = await tsx(['import-questions', join(dir, 'bad.json')]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/Problems found — nothing was imported/);
  });

  it('DB-3 HOST-4: `db:migrate` and `db:seed` report that there is nothing to do on an up-to-date database', async () => {
    const m = await tsx(['migrate']);
    expect(m.stdout).toMatch(/Nothing to apply: all \d+ migrations are already applied\./);
    const s = await tsx(['seed']);
    expect(s.stdout).toMatch(/Total: 0 added, 0 changed, \d+ unchanged\./);
  });
});

describe('uploading in the app', () => {
  let a: TestApp;
  beforeAll(async () => {
    a = await startApp(t);
    await addUser(t.db, 'admin@example.test', 'admin');
    await addUser(t.db, 'org@example.test', 'organiser');
  });
  afterAll(async () => a.close());

  it('DB-3: administrators upload a file, see the same report, then confirm; organisers cannot upload', async () => {
    const admin = client(a.app, await signIn(a.app, 'admin@example.test'));
    const file = JSON.parse(seedText('edge'));
    file.categories[0].weight = 1.5;
    const files = [{ name: 'edge.json', text: JSON.stringify(file) }];
    const preview = await admin.post('/api/bank/import', { files, dryRun: true });
    expect(preview.body).toMatchObject({ ok: true, applied: false, tracks: [{ trackId: 'edge', categoriesChanged: [file.categories[0].name] }] });
    expect((await t.db.selectFrom('categories').select('weight').where('id', '=', file.categories[0].id).executeTakeFirstOrThrow()).weight).toBe(1);
    const done = await admin.post('/api/bank/import', { files, dryRun: false });
    expect(done.body.applied).toBe(true);
    expect((await t.db.selectFrom('categories').select('weight').where('id', '=', file.categories[0].id).executeTakeFirstOrThrow()).weight).toBe(1.5);
    const org = client(a.app, await signIn(a.app, 'org@example.test'));
    expect((await org.post('/api/bank/import', { files, dryRun: true })).status).toBe(403);
    expect((await admin.post('/api/bank/import', { files: [], dryRun: true })).status).toBe(400);
  });
});
