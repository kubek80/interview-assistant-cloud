import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addCategory,
  bulkAddQuestions,
  checkTrackFile,
  createPlan,
  createTrack,
  db,
  exportTrackCsv,
  exportTrackFile,
  importTrackFile,
  loadSeeds,
  lockPlan,
  pendingSeedUpdates,
  queryAudit,
  removeCategory,
  replaceWithBundledSeed,
  saveQuestion,
  setQuestionStatus,
  updateCategory,
  updatePlanDraft,
  bundledSeeds,
  confirmConsent,
  exportScorecard,
  startSession,
  toggleKeyPoint,
  toggleRedFlag,
} from './index';
import { InterviewDb } from './db';
import { clock } from './util';
import { trackMetaOf } from './bank';
import { draftFromQuestion, emptyDraft, type QuestionDraft } from '../domain/bankEdit';
import { parseBulkQuestions } from '../domain/bankCsv';
import { makeTrackFile } from '../test/fixtures';
import type { Question, TrackFile } from '../domain/types';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => (now += 1000);
  await db.delete();
  await db.open();
  await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
});

afterEach(() => {
  clock.now = realNow;
});

const draft = (p: Partial<QuestionDraft> = {}): QuestionDraft => ({
  ...emptyDraft('tt-alpha'),
  text: 'How would you test a queue?',
  description: 'We want to hear how you would check a message queue works.',
  lookFor: ['ordering', 'retries'],
  redFlags: ['only happy path'],
  probes: ['What about poison messages?'],
  ...p,
});

const q = async (id: string) => (await db.questions.get(id))! as Question;
const changedAt = async (trackId = 'tt') => (await trackMetaOf(trackId)).changedAt;
const details = { initials: 'AB', requisitionId: null, interviewerName: 'Pat', retentionUntil: '2027-02-22' };

describe('managing the question bank in the app', () => {
  it('BANK-9 BANK-10 BANK-14: a new question gets the next number, version 1, is audited and marks the track as unexported', async () => {
    expect(await changedAt()).toBeNull();
    const r = await saveQuestion({ trackId: 'tt', draft: draft() });
    expect(r).toMatchObject({ id: 'tt-5', number: 5, version: 1 });
    expect(await q('tt-5')).toMatchObject({ trackId: 'tt', status: 'active', description: draft().description, timeMin: 3 });
    expect(await changedAt()).not.toBeNull();
    const ev = (await queryAudit({ actions: ['bank.question_added'] }))[0];
    expect(ev).toMatchObject({ entity: 'question', entityId: 'tt-5', before: null });
    expect((ev.after as Question).text).toBe('How would you test a queue?');
  });

  it('BANK-9: an invalid question is not saved', async () => {
    await expect(saveQuestion({ trackId: 'tt', draft: draft({ description: ' ', probes: [] }) })).rejects.toMatchObject({ code: 'invalid' });
    expect(await db.questions.count()).toBe(4);
  });

  it('BANK-11 BANK-14: an edit to the wording raises the version and is audited with before and after; category and time do not', async () => {
    const before = await q('tt-1');
    const r = await saveQuestion({ trackId: 'tt', id: 'tt-1', draft: { ...draftFromQuestion(before), text: 'Reworded' } });
    expect(r).toMatchObject({ version: 2, bumped: true, changed: true });
    const ev = (await queryAudit({ actions: ['bank.question_edited'] }))[0];
    expect(ev.before).toEqual({ text: before.text, version: 1 });
    expect(ev.after).toEqual({ text: 'Reworded', version: 2 });
    const r2 = await saveQuestion({ trackId: 'tt', id: 'tt-1', draft: { ...draftFromQuestion(await q('tt-1')), categoryId: 'tt-beta', timeMin: 7 } });
    expect(r2).toMatchObject({ version: 2, bumped: false, changed: true });
    const r3 = await saveQuestion({ trackId: 'tt', id: 'tt-1', draft: draftFromQuestion(await q('tt-1')) });
    expect(r3.changed).toBe(false);
    expect(await queryAudit({ actions: ['bank.question_edited'] })).toHaveLength(2);
  });

  it('BANK-11 FLOW-8 FLOW-9: a locked plan keeps its snapshot; a plan built after the edit has a different fingerprint', async () => {
    const p1 = await createPlan('tt');
    await updatePlanDraft(p1, { questionIds: ['tt-1', 'tt-2'] });
    await lockPlan(p1, details);
    const locked = (await db.plans.get(p1))!;
    await saveQuestion({ trackId: 'tt', id: 'tt-1', draft: { ...draftFromQuestion(await q('tt-1')), description: 'A better steer' } });
    const p2 = await createPlan('tt');
    await updatePlanDraft(p2, { questionIds: ['tt-1', 'tt-2'] });
    await lockPlan(p2, { ...details, initials: 'CD' });
    const after = (await db.plans.get(p2))!;
    expect((await db.plans.get(p1))!.questions[0]).toEqual(locked.questions[0]);
    expect(locked.questions[0].description).toBe('Steer for question 1 of tt');
    expect(after.questions[0].description).toBe('A better steer');
    expect(after.questions[0].version).toBe(2);
    expect(after.fingerprint).not.toBe(locked.fingerprint);
  });

  it('BANK-10: retire and restore are audited, keep the version, and numbers are never reused', async () => {
    await setQuestionStatus('tt-4', 'retired');
    expect((await q('tt-4')).status).toBe('retired');
    expect((await q('tt-4')).version).toBe(1);
    await setQuestionStatus('tt-4', 'active');
    expect((await queryAudit()).slice(0, 2).map((e) => e.action)).toEqual(['bank.question_restored', 'bank.question_retired']);
    // Re-importing a smaller track does not free numbers 5 and 6 used on this device.
    await saveQuestion({ trackId: 'tt', draft: draft() });
    await saveQuestion({ trackId: 'tt', draft: draft({ text: 'Another' }) });
    await importTrackFile(makeTrackFile('tt', '2026.11', 3));
    expect((await saveQuestion({ trackId: 'tt', draft: draft() })).id).toBe('tt-7');
  });

  it('BANK-12: categories can be added, renamed and reweighted, and removed only when empty', async () => {
    const id = await addCategory('tt', { name: 'Gamma & Delta', weight: 1.5, mustHave: true });
    expect(id).toBe('tt-gamma-delta');
    await expect(addCategory('tt', { name: 'gamma & delta' })).rejects.toMatchObject({ code: 'invalid' });
    await updateCategory(id, { name: 'Gamma', weight: 2, mustHave: false });
    expect(await db.categories.get(id)).toMatchObject({ id, name: 'Gamma', weight: 2, mustHave: false });
    await expect(updateCategory(id, { weight: 0 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(removeCategory('tt-alpha')).rejects.toMatchObject({ code: 'in-use' });
    await setQuestionStatus('tt-1', 'retired');
    await expect(removeCategory('tt-alpha')).rejects.toMatchObject({ code: 'in-use' }); // retired questions count
    await removeCategory(id);
    expect(await db.categories.get(id)).toBeUndefined();
    const evs = await queryAudit({ actions: ['bank.category_added', 'bank.category_edited', 'bank.category_removed'] });
    expect(evs.map((e) => e.action)).toEqual(['bank.category_removed', 'bank.category_edited', 'bank.category_added']);
    expect(evs[1].before).toEqual({ name: 'Gamma & Delta', weight: 1.5, mustHave: true });
    expect(evs[1].after).toEqual({ name: 'Gamma', weight: 2, mustHave: false });
  });

  it('BANK-9 BANK-12: a question can be saved into a new category created with it', async () => {
    const r = await saveQuestion({ trackId: 'tt', draft: draft({ categoryId: '' }), newCategory: { name: 'Messaging' } });
    expect((await q(r.id)).categoryId).toBe('tt-messaging');
  });

  it('BANK-12: a new track is created with a valid, unique id and its first category', async () => {
    await expect(createTrack({ id: 'Bad Id', name: 'X', firstCategory: { name: 'A' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createTrack({ id: 'tt', name: 'X', firstCategory: { name: 'A' } })).rejects.toMatchObject({ code: 'invalid' });
    const id = await createTrack({ id: 'data', name: 'Senior Data Engineer', firstCategory: { name: 'Pipelines' } });
    expect(await db.tracks.get(id)).toEqual({ id: 'data', name: 'Senior Data Engineer', version: '2026.11' });
    expect((await db.categories.where('trackId').equals('data').toArray()).map((c) => c.id)).toEqual(['data-pipelines']);
    expect((await saveQuestion({ trackId: 'data', draft: draft({ categoryId: 'data-pipelines' }) })).id).toBe('data-1');
    expect(await changedAt('data')).not.toBeNull();
    expect((await queryAudit({ actions: ['bank.track_created'] }))[0].entityId).toBe('data');
  });

  it('BANK-13: pasted rows preview first, then the accepted rows are added with new categories, all audited', async () => {
    const text = 'Q one\tSteer one\tAlpha\tcore\tknowledge\ta;b\tc\td\t\nQ two\tSteer two\tBrand new\texpert\tdesign\ta\tb\tc\t\n\tno text\tAlpha\tcore\tknowledge\ta\tb\tc\t';
    const before = await db.questions.count();
    const parsed = parseBulkQuestions(text, 'tt', await db.categories.where('trackId').equals('tt').toArray());
    expect(await db.questions.count()).toBe(before); // nothing imported by the preview
    const good = parsed.rows.filter((r) => !r.problems.length);
    expect(good).toHaveLength(2);
    const created = parsed.newCategories.map((name) => ({ name, id: parsed.rows.find((r) => r.newCategory === name)!.draft.categoryId }));
    const r = await bulkAddQuestions('tt', good.map((g) => g.draft), created);
    expect(r).toEqual({ ids: ['tt-5', 'tt-6'], categories: ['Brand new'] });
    expect((await q('tt-6')).categoryId).toBe('tt-brand-new');
    expect(await queryAudit({ actions: ['bank.question_added'] })).toHaveLength(2);
    // All or nothing: an invalid draft adds nothing.
    await expect(bulkAddQuestions('tt', [draft(), draft({ text: '' })])).rejects.toMatchObject({ code: 'invalid' });
    expect(await db.questions.count()).toBe(before + 2);
  });

  it('BANK-4 BANK-14: exporting the track file takes the new version, validates, and clears the unexported marker', async () => {
    await saveQuestion({ trackId: 'tt', draft: draft() });
    expect(await changedAt()).not.toBeNull();
    await expect(exportTrackFile('tt', { version: '2026.10' })).rejects.toMatchObject({ code: 'invalid-version' });
    const out = await exportTrackFile('tt', { version: '2026.11.1' });
    expect(out.fileName).toBe('tt.json');
    const file = JSON.parse(out.text);
    expect(file.track.version).toBe('2026.11.1');
    expect(file.questions).toHaveLength(5);
    expect(Object.keys(file.questions[4])).toEqual(['id', 'number', 'categoryId', 'text', 'description', 'difficulty', 'type', 'timeMin', 'lookFor', 'redFlags', 'probes', 'version', 'status', 'rubricOverride']);
    expect((await db.tracks.get('tt'))!.version).toBe('2026.11.1');
    expect(await changedAt()).toBeNull();
    const ev = (await queryAudit({ actions: ['export'] }))[0];
    expect(ev.before).toMatchObject({ version: '2026.11' });
    expect(ev.after).toEqual({ format: 'track-json', version: '2026.11.1' });
    // A track that would not pass validation is not exported (here: an unused category).
    await addCategory('tt', { name: 'Unused' });
    await expect(exportTrackFile('tt', { version: '2026.11.2' })).rejects.toMatchObject({ code: 'invalid-track' });
  });

  it('BANK-13 FLOW-32: a track exported as CSV is audited', async () => {
    const out = await exportTrackCsv('tt');
    expect(out.text.split('\r\n')[0]).toMatch(/^Question,Description,Category/);
    expect((await queryAudit({ actions: ['export'] }))[0].after).toMatchObject({ format: 'track-csv', questions: 4 });
  });

  it('BANK-6: a newer seed is not loaded over local changes; it is offered, and replacing is audited', async () => {
    await saveQuestion({ trackId: 'tt', id: 'tt-1', draft: { ...draftFromQuestion(await q('tt-1')), text: 'Local wording' } });
    const newer = makeTrackFile('tt', '2026.12', 6);
    const r = await loadSeeds([newer]);
    expect(r.loaded).toEqual([]);
    expect(r.held).toEqual([{ trackId: 'tt', stored: '2026.11', bundled: '2026.12' }]);
    expect((await q('tt-1')).text).toBe('Local wording');
    expect(await pendingSeedUpdates([newer])).toEqual([expect.objectContaining({ trackId: 'tt', storedVersion: '2026.11', bundledVersion: '2026.12' })]);
    await replaceWithBundledSeed('tt', [newer]);
    expect((await q('tt-1')).text).toBe('Question 1 of tt');
    expect(await db.questions.where('trackId').equals('tt').count()).toBe(6);
    expect(await changedAt()).toBeNull();
    expect(await pendingSeedUpdates([newer])).toEqual([]);
    expect((await queryAudit({ actions: ['bank.loaded'] }))[0].after).toMatchObject({ version: '2026.12', replacedLocalChanges: true });
  });

  it('BANK-6: without local changes a newer seed still loads automatically', async () => {
    expect((await loadSeeds([makeTrackFile('tt', '2026.11.1', 5)])).loaded).toEqual([{ trackId: 'tt', from: '2026.11', to: '2026.11.1' }]);
  });

  it('BANK-7 BANK-1 SEC-2: a track file is checked before import and says what it would replace', async () => {
    await saveQuestion({ trackId: 'tt', draft: draft() });
    const check = await checkTrackFile(makeTrackFile('tt', '2026.12', 2));
    expect(check).toMatchObject({ trackId: 'tt', version: '2026.12', questions: 2, existing: { version: '2026.11', questions: 5 } });
    expect(check.existing!.changedAt).not.toBeNull();
    const bad = makeTrackFile('tt', '2026.12', 2) as unknown as { questions: Array<Record<string, unknown>> };
    delete bad.questions[0].description;
    await expect(checkTrackFile(bad)).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(importTrackFile(bad)).rejects.toMatchObject({ code: 'invalid-file' });
  });

  it('BANK-4 BANK-3: an unchanged bundled seed exports identical to its file in seed/ (apart from the version given)', async () => {
    const seeds = bundledSeeds();
    if (!seeds.length) return;
    await loadSeeds(seeds);
    for (const seed of seeds) {
      const id = seed.track.id;
      const out = await exportTrackFile(id);
      const onDisk = readFileSync(fileURLToPath(new URL(`../../seed/${id}.json`, import.meta.url)), 'utf8');
      expect(out.text, id).toBe(onDisk);
    }
  });
});

describe('BANK-6 BANK-15: a device moving to the full-sentence bank', () => {
  /** The bundled web track as it was before the rewrite: short lists, no questions 51-54, track 2026.11. */
  const shortWording = (): TrackFile => {
    const now = bundledSeeds().find((f) => f.track.id === 'web')!;
    const old = structuredClone(now);
    old.track.version = '2026.11';
    old.questions = old.questions.filter((x) => x.number <= 50).map((x) => ({ ...x, version: x.version - 1, lookFor: ['short a', 'short b', 'short c', 'short d'], redFlags: ['short flag'] }));
    return old;
  };

  async function startedOn(questionIds: string[], initials: string) {
    const planId = await createPlan('web');
    await updatePlanDraft(planId, { questionIds });
    const { sessionId } = await lockPlan(planId, { ...details, initials });
    await confirmConsent(sessionId);
    await startSession(sessionId);
    return { planId, sessionId };
  }

  it('BANK-6 BANK-15 BANK-11 FLOW-8 DATA-1: reloading the newer bundled bank leaves locked plans and their answers on the old wording; new plans get the sentences and the new versions', async () => {
    const bundled = bundledSeeds().find((f) => f.track.id === 'web')!;
    expect(bundled.track.version).toBe('2026.11.1');
    await loadSeeds([shortWording()]);
    // An interview set up and partly marked on the old wording: key point 4 and red flag 1 ticked.
    const { planId, sessionId } = await startedOn(['web-1', 'web-2'], 'OLD');
    await toggleKeyPoint(sessionId, 'web-1', 3);
    await toggleRedFlag(sessionId, 'web-1', 0);
    const lockedBefore = structuredClone((await db.plans.get(planId))!);

    // The app is updated: the newer bundled track loads (nothing was changed on this device).
    expect((await loadSeeds([bundled])).loaded).toEqual([{ trackId: 'web', from: '2026.11', to: '2026.11.1' }]);
    expect((await q('web-1')).lookFor).toEqual(bundled.questions[0].lookFor);
    expect((await q('web-1')).version).toBe(bundled.questions[0].version);
    expect(await db.questions.where('trackId').equals('web').count()).toBe(54);

    // The locked plan is byte-for-byte what it was, so the old interview keeps the short wording…
    const plan = (await db.plans.get(planId))!;
    expect(plan).toEqual(lockedBefore);
    expect(plan.questions[0].lookFor).toEqual(['short a', 'short b', 'short c', 'short d']);
    // …and its ticks (indexes) still resolve against its own snapshot, not the new bank.
    const answer = (await db.answers.get([sessionId, 'web-1']))!;
    expect(answer.coveredKeyPoints.map((i) => plan.questions[0].lookFor[i])).toEqual(['short d']);
    expect(answer.redFlagsSeen.map((i) => plan.questions[0].redFlags[i])).toEqual(['short flag']);
    const csv = (await exportScorecard(sessionId, 'csv')).text;
    expect(csv).toContain('short flag');
    expect(csv).toContain('1/4'); // one of the plan's four key points, not of the bank's five
    expect(csv).not.toContain(bundled.questions[0].redFlags[0]);

    // A plan set up now uses the sentences and the raised versions, so it is not comparable with the old one.
    const fresh = await startedOn(['web-1', 'web-2'], 'NEW');
    const freshPlan = (await db.plans.get(fresh.planId))!;
    expect(freshPlan.questions[0].lookFor).toEqual(bundled.questions[0].lookFor);
    expect(freshPlan.questions[0].version).toBe(plan.questions[0].version + 1);
    expect(freshPlan.fingerprint).not.toBe(plan.fingerprint);
  });

  it('BANK-6 BANK-14: a track changed on this device is not overwritten by the newer bundled bank; it is offered, and the old interviews are unaffected either way', async () => {
    const bundled = bundledSeeds().find((f) => f.track.id === 'web')!;
    await loadSeeds([shortWording()]);
    const { planId } = await startedOn(['web-1'], 'OLD');
    await saveQuestion({ trackId: 'web', id: 'web-1', draft: { ...draftFromQuestion(await q('web-1')), lookFor: ['short a', 'short b', 'local point'] } });
    const r = await loadSeeds([bundled]);
    expect(r.loaded).toEqual([]);
    expect(r.held).toEqual([{ trackId: 'web', stored: '2026.11', bundled: '2026.11.1' }]);
    expect((await q('web-1')).lookFor).toEqual(['short a', 'short b', 'local point']);
    expect(await pendingSeedUpdates([bundled])).toEqual([expect.objectContaining({ trackId: 'web', bundledVersion: '2026.11.1' })]);
    await replaceWithBundledSeed('web', [bundled]);
    expect((await q('web-1')).lookFor).toEqual(bundled.questions[0].lookFor);
    expect((await db.plans.get(planId))!.questions[0].lookFor).toEqual(['short a', 'short b', 'short c', 'short d']);
  });
});

describe('database upgrade', () => {
  it('BANK-8 DATA-1: stored questions get a description from the bundled seed when the id matches, else empty; locked plans are untouched', async () => {
    const seeds = bundledSeeds();
    const seeded = seeds[0]?.questions[0];
    const name = 'upgrade-test';
    await Dexie.delete(name);
    const old = new Dexie(name);
    old.version(2).stores({
      tracks: 'id',
      categories: 'id, trackId',
      questions: 'id, trackId, categoryId',
      plans: 'id, trackId, fingerprint, createdAt',
      sessions: 'id, planId, state, createdAt, candidate.retentionUntil',
      answers: '[sessionId+questionId], sessionId',
      audit: '++id, ts, action, entity, entityId',
      settings: 'key',
      candidateDrafts: 'planId',
    });
    const legacy = (id: string) => {
      const { description: _d, ...rest } = { ...makeTrackFile('zz').questions[0], id, trackId: 'zz' };
      return rest;
    };
    await old.table('questions').bulkAdd([legacy('zz-1'), ...(seeded ? [legacy(seeded.id)] : [])]);
    await old.table('plans').add({ id: 'p1', questions: [legacy('zz-1')] });
    old.close();
    const upgraded = new InterviewDb(name);
    await upgraded.open();
    expect((await upgraded.questions.get('zz-1'))!.description).toBe('');
    if (seeded) expect((await upgraded.questions.get(seeded.id))!.description).toBe(seeded.description);
    expect('description' in (await upgraded.plans.get('p1'))!.questions[0]).toBe(false);
    expect(await upgraded.trackMeta.count()).toBe(0);
    upgraded.close();
    await Dexie.delete(name);
  });
});
