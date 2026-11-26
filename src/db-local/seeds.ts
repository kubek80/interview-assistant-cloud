import type { TrackFile } from '../domain/types';

/** Seed files bundled at build time (BANK-3), sorted by file name. */
export function bundledSeeds(): TrackFile[] {
  const modules = import.meta.glob<{ default: TrackFile }>('/seed/*.json', { eager: true });
  return Object.keys(modules)
    .sort()
    .map((k) => modules[k].default);
}

/** BANK-8 migration: description of each bundled question by id. */
export function bundledDescriptions(): Map<string, string> {
  return new Map(bundledSeeds().flatMap((f) => f.questions.map((q) => [q.id, typeof q.description === 'string' ? q.description : ''] as const)));
}
