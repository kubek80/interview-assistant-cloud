// The question bank over the API (DB-1…DB-4, BANK-*). Function names and shapes follow the local
// app's data layer, so its bank screens work unchanged: hooks return undefined while loading and
// null when not found; changes are async functions that throw ApiError (alias RepoError).
import { useQuery } from '@tanstack/react-query';
import { api } from './http';
import { orNull, queryClient } from './queryClient';
import { useLiveTopics } from './live';
import type { QuestionDraft } from '../domain/bankEdit';
import type { QuestionStatus } from '../domain/types';
import type { ExportedTrack, ImportFileInput, ImportReport, SaveQuestionResult, TrackBank, TrackSummary } from '../shared/api';

export type { SaveQuestionResult, TrackBank, TrackSummary, ExportedTrack };

/** FLOW-6 uses the same range for plan weights. */
export const WEIGHT_RANGE = [0.1, 10] as const;

// A bank change can make proposals out of date (REVIEW-6), so the review lists refresh too.
const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['bank'] }), queryClient.invalidateQueries({ queryKey: ['reviews'] })]);

export function useTracks(): TrackSummary[] | undefined {
  useLiveTopics('bank');
  const q = useQuery({ queryKey: ['bank', 'tracks'], queryFn: () => api.get<TrackSummary[]>('/api/bank/tracks') });
  if (q.isError) throw q.error;
  return q.data;
}

export function useTrackBank(trackId: string | undefined): TrackBank | null | undefined {
  useLiveTopics('bank');
  const q = useQuery({
    queryKey: ['bank', 'track', trackId],
    queryFn: () => (trackId ? orNull(api.get<TrackBank>(`/api/bank/tracks/${encodeURIComponent(trackId)}`)) : Promise.resolve(null)),
  });
  if (q.isError) throw q.error;
  return q.data;
}

/** BANK-14: per-track "changes not yet exported" marker. */
export function useBankStatus(): { changedAt: Record<string, string | null> } | undefined {
  const tracks = useTracks();
  return tracks ? { changedAt: Object.fromEntries(tracks.map((t) => [t.id, t.changedAt])) } : undefined;
}

export interface SaveQuestionInput {
  trackId: string;
  id?: string;
  draft: QuestionDraft;
  newCategory?: CategoryInput;
}

export async function saveQuestion(input: SaveQuestionInput): Promise<SaveQuestionResult> {
  const body = { draft: input.draft, ...(input.newCategory ? { newCategory: input.newCategory } : {}) };
  const r = input.id ? await api.put<SaveQuestionResult>(`/api/bank/questions/${input.id}`, body) : await api.post<SaveQuestionResult>(`/api/bank/tracks/${input.trackId}/questions`, body);
  await refresh();
  return r;
}

export async function bulkAddQuestions(trackId: string, drafts: readonly QuestionDraft[], newCategories: ReadonlyArray<{ id: string; name: string }> = []): Promise<{ ids: string[]; categories: string[] }> {
  const r = await api.post<{ ids: string[]; categories: string[] }>(`/api/bank/tracks/${trackId}/questions/bulk`, { drafts, newCategories });
  await refresh();
  return r;
}

export async function setQuestionStatus(questionId: string, status: QuestionStatus): Promise<void> {
  await api.patch(`/api/bank/questions/${questionId}/status`, { status });
  await refresh();
}

export interface CategoryInput {
  name: string;
  weight?: number;
  mustHave?: boolean;
}

export async function addCategory(trackId: string, input: CategoryInput): Promise<string> {
  const r = await api.post<{ id: string }>(`/api/bank/tracks/${trackId}/categories`, input);
  await refresh();
  return r.id;
}

export async function updateCategory(categoryId: string, patch: Partial<CategoryInput>): Promise<void> {
  await api.patch(`/api/bank/categories/${categoryId}`, patch);
  await refresh();
}

export async function removeCategory(categoryId: string): Promise<void> {
  await api.del(`/api/bank/categories/${categoryId}`);
  await refresh();
}

export interface NewTrackInput {
  id: string;
  name: string;
  version?: string;
  firstCategory: CategoryInput;
}

export function newTrackProblems(input: Pick<NewTrackInput, 'id' | 'name' | 'version'>): Promise<Partial<Record<'id' | 'name' | 'version', string>>> {
  return api.post('/api/bank/tracks/check', input);
}

export async function createTrack(input: NewTrackInput): Promise<string> {
  const r = await api.post<{ id: string }>('/api/bank/tracks', input);
  await refresh();
  return r.id;
}

/** DB-4, BANK-7: download a track file; with `version` the track takes that version. */
export async function exportTrackFile(trackId: string, opts: { version?: string } = {}): Promise<ExportedTrack> {
  const r = await api.post<ExportedTrack>(`/api/bank/tracks/${trackId}/export`, opts.version ? { version: opts.version } : {});
  await refresh();
  return r;
}

/** DB-4, BANK-13: the active questions as CSV. */
export function exportTrackCsv(trackId: string): Promise<ExportedTrack> {
  return api.post<ExportedTrack>(`/api/bank/tracks/${trackId}/export-csv`);
}

/** DB-3: check files (dryRun) or import them, with the report either way. */
export async function importQuestionFiles(files: ImportFileInput[], dryRun: boolean): Promise<ImportReport> {
  const r = await api.post<ImportReport>('/api/bank/import', { files, dryRun });
  if (!dryRun) await refresh();
  return r;
}
