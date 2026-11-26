import { db, type TrackMetaRecord } from './db';
import { RepoError, appendAudit, nowIso } from './util';
import { bundledSeeds } from './seeds';
import { toJson, trackFile } from '../domain/export';
import { trackQuestionsCsv } from '../domain/bankCsv';
import { compareVersions, trackVersionProblem } from '../domain/bankEdit';
import { trackFileRows, validateTrackFile } from '../domain/validation';
import type { TrackFile } from '../domain/types';

export { bundledSeeds } from './seeds';
export { compareVersions } from '../domain/bankEdit';

/** Tables touched by bank changes (always with the audit log, AUD-1, BANK-14). */
export const bankTables = () => [db.tracks, db.categories, db.questions, db.trackMeta, db.audit, db.settings];

/** The bookkeeping record for a track, created on first use from what is stored. */
export async function trackMetaOf(trackId: string): Promise<TrackMetaRecord> {
  const meta = await db.trackMeta.get(trackId);
  if (meta) return meta;
  const [questions, categories] = await Promise.all([db.questions.where('trackId').equals(trackId).toArray(), db.categories.where('trackId').equals(trackId).toArray()]);
  const seed = bundledSeeds().find((s) => s.track.id === trackId);
  const seedOrder = seed ? seed.categories.map((c) => c.id) : [];
  const ids = categories.map((c) => c.id);
  return {
    trackId,
    changedAt: null,
    exportedAt: null,
    maxNumber: Math.max(0, ...questions.map((q) => q.number)),
    categoryOrder: [...seedOrder.filter((id) => ids.includes(id)), ...ids.filter((id) => !seedOrder.includes(id)).sort()],
  };
}

/** BANK-14: records that the track has changes on this device that have not been exported. */
export async function markTrackChanged(trackId: string, patch: Partial<TrackMetaRecord> = {}): Promise<void> {
  const meta = await trackMetaOf(trackId);
  await db.trackMeta.put({ ...meta, ...patch, changedAt: meta.changedAt ?? nowIso() });
}

async function replaceTrack(file: TrackFile): Promise<void> {
  const { categories, questions } = trackFileRows(file);
  const trackId = file.track.id;
  const previous = await db.trackMeta.get(trackId);
  const storedMax = Math.max(0, ...(await db.questions.where('trackId').equals(trackId).toArray()).map((q) => q.number));
  await db.categories.where('trackId').equals(trackId).delete();
  await db.questions.where('trackId').equals(trackId).delete();
  await db.categories.bulkPut(categories);
  await db.questions.bulkPut(questions);
  await db.tracks.put({ ...file.track });
  await db.trackMeta.put({
    trackId,
    changedAt: null,
    exportedAt: previous?.exportedAt ?? null,
    // BANK-10: numbers used on this device before the replacement are never handed out again.
    maxNumber: Math.max(previous?.maxNumber ?? 0, storedMax, ...questions.map((q) => q.number)),
    categoryOrder: categories.map((c) => c.id),
  });
}

export interface SeedLoadResult {
  loaded: Array<{ trackId: string; from: string | null; to: string }>;
  invalid: Array<{ index: number; errors: string[] }>;
  /** BANK-6: newer bundled seeds not loaded because the track has unexported changes on this device. */
  held: Array<{ trackId: string; stored: string; bundled: string }>;
}

/**
 * BANK-6: loads each seed whose track is missing or older than the seed. A track changed on this
 * device is never overwritten automatically (see `pendingSeedUpdates` and `replaceWithBundledSeed`).
 * Locked plans keep their own snapshots, so this never changes an existing interview. Audited (AUD-2).
 */
export async function loadSeeds(seeds: TrackFile[] = bundledSeeds()): Promise<SeedLoadResult> {
  const result: SeedLoadResult = { loaded: [], invalid: [], held: [] };
  for (const [index, seed] of seeds.entries()) {
    const v = validateTrackFile(seed);
    if (!v.ok) {
      result.invalid.push({ index, errors: v.errors });
      continue;
    }
    await db.transaction('rw', bankTables(), async () => {
      const existing = await db.tracks.get(seed.track.id);
      if (existing && compareVersions(seed.track.version, existing.version) <= 0) return;
      if (existing && (await db.trackMeta.get(seed.track.id))?.changedAt) {
        result.held.push({ trackId: seed.track.id, stored: existing.version, bundled: seed.track.version });
        return;
      }
      await replaceTrack(v.value);
      await appendAudit({
        action: 'bank.loaded',
        entity: 'track',
        entityId: seed.track.id,
        before: existing ? { version: existing.version } : null,
        after: { version: seed.track.version, questions: seed.questions.length, source: 'seed' },
      });
      result.loaded.push({ trackId: seed.track.id, from: existing?.version ?? null, to: seed.track.version });
    });
  }
  return result;
}

export interface PendingSeedUpdate {
  trackId: string;
  name: string;
  storedVersion: string;
  bundledVersion: string;
  /** When the unexported changes on this device started (BANK-14). */
  changedAt: string | null;
}

/** BANK-6: bundled seeds newer than the stored track (held back because the track was changed here). */
export async function pendingSeedUpdates(seeds: TrackFile[] = bundledSeeds()): Promise<PendingSeedUpdate[]> {
  const out: PendingSeedUpdate[] = [];
  for (const seed of seeds) {
    const stored = await db.tracks.get(seed.track.id);
    if (!stored || compareVersions(seed.track.version, stored.version) <= 0) continue;
    const meta = await db.trackMeta.get(seed.track.id);
    out.push({ trackId: stored.id, name: stored.name, storedVersion: stored.version, bundledVersion: seed.track.version, changedAt: meta?.changedAt ?? null });
  }
  return out;
}

/**
 * BANK-6: replaces a track with the newer bundled seed, discarding the changes made on this device
 * (the screen offers to export them first). Audited as a bank load with the versions before and after.
 */
export async function replaceWithBundledSeed(trackId: string, seeds: TrackFile[] = bundledSeeds()): Promise<{ version: string }> {
  const seed = seeds.find((s) => s.track.id === trackId);
  if (!seed) throw new RepoError('not-found', 'There is no bundled version of this track.');
  const v = validateTrackFile(seed);
  if (!v.ok) throw new RepoError('invalid-file', 'The bundled track file is not valid.', v.errors);
  await db.transaction('rw', bankTables(), async () => {
    const existing = await db.tracks.get(trackId);
    const meta = existing ? await trackMetaOf(trackId) : null;
    await replaceTrack(v.value);
    await appendAudit({
      action: 'bank.loaded',
      entity: 'track',
      entityId: trackId,
      before: existing ? { version: existing.version, unexportedChangesSince: meta?.changedAt ?? null } : null,
      after: { version: seed.track.version, questions: seed.questions.length, source: 'seed', replacedLocalChanges: !!meta?.changedAt },
    });
  });
  return { version: seed.track.version };
}

export interface TrackFileCheck {
  trackId: string;
  name: string;
  version: string;
  questions: number;
  categories: number;
  /** The track this file would replace, if it is on this device. */
  existing: { name: string; version: string; questions: number; changedAt: string | null } | null;
}

/** BANK-7, SEC-2: validates a track file and says what importing it would replace. Changes nothing. */
export async function checkTrackFile(json: unknown): Promise<TrackFileCheck> {
  const v = validateTrackFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The track file is not valid.', v.errors);
  const file = v.value;
  const existing = await db.tracks.get(file.track.id);
  return {
    trackId: file.track.id,
    name: file.track.name,
    version: file.track.version,
    questions: file.questions.length,
    categories: file.categories.length,
    existing: existing
      ? {
          name: existing.name,
          version: existing.version,
          questions: await db.questions.where('trackId').equals(existing.id).count(),
          changedAt: (await db.trackMeta.get(existing.id))?.changedAt ?? null,
        }
      : null,
  };
}

/**
 * BANK-7: import a track file (Question bank and Admin screens). Validated against the schema first;
 * replaces that track's bank whatever its version. Audited with the versions before and after.
 */
export async function importTrackFile(json: unknown): Promise<{ trackId: string; version: string }> {
  const v = validateTrackFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The track file is not valid.', v.errors);
  const file = v.value;
  await db.transaction('rw', bankTables(), async () => {
    const existing = await db.tracks.get(file.track.id);
    const changedAt = existing ? ((await db.trackMeta.get(file.track.id))?.changedAt ?? null) : null;
    await replaceTrack(file);
    await appendAudit({
      action: 'import',
      entity: 'track',
      entityId: file.track.id,
      before: existing ? { version: existing.version, unexportedChangesSince: changedAt } : null,
      after: { format: 'track-json', version: file.track.version, questions: file.questions.length },
    });
  });
  return { trackId: file.track.id, version: file.track.version };
}

export interface ExportedTrack {
  fileName: string;
  mime: string;
  text: string;
  version: string;
}

/** The current bank of a track as a track file (seed shape, seed key and category order). */
async function currentTrackFile(trackId: string, version?: string): Promise<TrackFile> {
  const track = await db.tracks.get(trackId);
  if (!track) throw new RepoError('not-found', 'Track not found.');
  const [categories, questions, meta] = await Promise.all([
    db.categories.where('trackId').equals(trackId).toArray(),
    db.questions.where('trackId').equals(trackId).toArray(),
    trackMetaOf(trackId),
  ]);
  return trackFile({ ...track, version: version ?? track.version }, categories, questions, meta.categoryOrder);
}

/**
 * BANK-4, BANK-7: export a track as a track file, ready to replace seed/<trackId>.json. With
 * `version`, the export carries that version (it must be valid and not older than the current one)
 * and the track on this device takes it too. The file is validated first: an invalid track is not
 * exported and the problems are listed. Clears the "unexported changes" marker (BANK-14). Audited.
 */
export async function exportTrackFile(trackId: string, opts: { version?: string } = {}): Promise<ExportedTrack> {
  return db.transaction('rw', bankTables(), async () => {
    const track = await db.tracks.get(trackId);
    if (!track) throw new RepoError('not-found', 'Track not found.');
    const version = opts.version?.trim() || track.version;
    const problem = trackVersionProblem(version, track.version);
    if (problem && version !== track.version) throw new RepoError('invalid-version', problem);
    const file = await currentTrackFile(trackId, version);
    const v = validateTrackFile(file);
    // BANK-3: the seed check also requires every category to be used, so the file can go straight into seed/.
    const unused = file.categories.filter((c) => !file.questions.some((q) => q.categoryId === c.id)).map((c) => `Category “${c.name}” has no questions: add one or remove the category.`);
    const problems = [...(v.ok ? [] : v.errors), ...unused];
    if (problems.length) throw new RepoError('invalid-track', 'This track cannot be exported until these problems are fixed.', problems);
    if (version !== track.version) await db.tracks.put({ ...track, version });
    const meta = await trackMetaOf(trackId);
    await db.trackMeta.put({ ...meta, changedAt: null, exportedAt: nowIso() });
    await appendAudit({
      action: 'export',
      entity: 'track',
      entityId: trackId,
      before: { version: track.version, unexportedChangesSince: meta.changedAt },
      after: { format: 'track-json', version },
    });
    return { fileName: `${trackId}.json`, mime: 'application/json', text: toJson(file), version };
  });
}

/** BANK-13: a track's active questions as CSV in the bulk-add layout. Audited (FLOW-32). */
export async function exportTrackCsv(trackId: string): Promise<ExportedTrack> {
  return db.transaction('rw', bankTables(), async () => {
    const track = await db.tracks.get(trackId);
    if (!track) throw new RepoError('not-found', 'Track not found.');
    const [categories, questions] = await Promise.all([db.categories.where('trackId').equals(trackId).toArray(), db.questions.where('trackId').equals(trackId).toArray()]);
    const text = trackQuestionsCsv(questions, categories);
    await appendAudit({
      action: 'export',
      entity: 'track',
      entityId: trackId,
      after: { format: 'track-csv', version: track.version, questions: questions.filter((q) => q.status === 'active').length },
    });
    return { fileName: `${trackId}-questions-${nowIso().slice(0, 10)}.csv`, mime: 'text/csv', text, version: track.version };
  });
}
