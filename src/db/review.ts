// Question review over the API (REVIEW-1 to REVIEW-7). Query keys start with 'reviews' (live topic).
import { useQuery } from '@tanstack/react-query';
import { api, qs } from './http';
import { orNull, queryClient } from './queryClient';
import { useLiveTopics } from './live';
import type { QuestionDraft } from '../domain/bankEdit';
import type {
  MyReview,
  MyReviewDetail,
  ProposalDetail,
  ProposalSummary,
  QuestionFeedback,
  ReviewCounts,
  ReviewerOption,
  ReviewRequestDetail,
  ReviewRequestSummary,
} from '../shared/api';

const refresh = async (bank = false) => {
  await queryClient.invalidateQueries({ queryKey: ['reviews'] });
  if (bank) await queryClient.invalidateQueries({ queryKey: ['bank'] });
};

function useApi<T>(key: unknown[], path: string | null, opts: { orNull?: boolean } = {}) {
  useLiveTopics('reviews');
  const q = useQuery({
    queryKey: ['reviews', ...key],
    queryFn: () => (path ? (opts.orNull ? orNull(api.get<T>(path)) : api.get<T>(path)) : Promise.resolve(null)),
    enabled: path !== null,
  });
  if (q.isError) throw q.error;
  return q.data as T | null | undefined;
}

/** Counts for the navigation; only fetched for people who can review or decide. */
export function useReviewCounts(enabled: boolean): ReviewCounts | undefined {
  useLiveTopics(...(enabled ? ['reviews'] : []));
  return useQuery({ queryKey: ['reviews', 'counts'], queryFn: () => api.get<ReviewCounts>('/api/review-counts'), enabled }).data;
}

export const useProposals = (status: 'open' | 'decided' | 'all', mine = false) =>
  useApi<ProposalSummary[]>(['proposals', status, mine], `/api/proposals${qs({ status, mine: mine ? 'true' : undefined })}`) as ProposalSummary[] | undefined;
export const useProposal = (id: string | undefined) => useApi<ProposalDetail>(['proposal', id], id ? `/api/proposals/${encodeURIComponent(id)}` : null, { orNull: true });

export async function proposeChange(input: { questionId: string; baseVersion: number; draft: QuestionDraft; reason: string; requestId?: string }): Promise<string> {
  const r = await api.post<{ id: string }>('/api/proposals', { kind: 'change', ...input });
  await refresh();
  return r.id;
}

export async function proposeNew(input: { trackId: string; draft: QuestionDraft; newCategory?: { name: string }; reason: string; requestId?: string }): Promise<string> {
  const r = await api.post<{ id: string }>('/api/proposals', { kind: 'new', ...input });
  await refresh();
  return r.id;
}

export async function proposeMany(trackId: string, drafts: readonly QuestionDraft[], newCategories: ReadonlyArray<{ id: string; name: string }>, reason: string): Promise<string[]> {
  const r = await api.post<{ ids: string[] }>('/api/proposals/bulk', { trackId, drafts, newCategories, reason });
  await refresh();
  return r.ids;
}

export async function withdrawProposal(id: string): Promise<void> {
  await api.post(`/api/proposals/${id}/withdraw`);
  await refresh();
}

export async function acceptProposal(id: string, opts: { draft?: QuestionDraft; newCategory?: { name: string }; note?: string; confirmOutOfDate?: boolean } = {}) {
  const r = await api.post<{ status: string; questionId: string; version: number; bumped: boolean }>(`/api/proposals/${id}/accept`, opts);
  await refresh(true);
  return r;
}

export async function declineProposal(id: string, reason: string): Promise<void> {
  await api.post(`/api/proposals/${id}/decline`, { reason });
  await refresh();
}

export const useFeedback = (questionId: string | null | undefined, enabled = true) =>
  useApi<QuestionFeedback>(['feedback', questionId], questionId && enabled ? `/api/bank/questions/${questionId}/feedback` : null);

export async function addComment(questionId: string, text: string, requestId?: string): Promise<void> {
  await api.post(`/api/bank/questions/${questionId}/comments`, { text, ...(requestId ? { requestId } : {}) });
  await refresh();
}

export async function setLooksGood(questionId: string, value: boolean, requestId?: string): Promise<void> {
  await api.put(`/api/bank/questions/${questionId}/looks-good`, { value, ...(requestId ? { requestId } : {}) });
  await refresh();
}

export const useReviewers = () => useApi<ReviewerOption[]>(['reviewers'], '/api/reviews/reviewers') as ReviewerOption[] | undefined;
export const useReviewRequests = () => useApi<ReviewRequestSummary[]>(['requests'], '/api/reviews') as ReviewRequestSummary[] | undefined;
export const useReviewRequest = (id: string | undefined) => useApi<ReviewRequestDetail>(['request', id], id ? `/api/reviews/${encodeURIComponent(id)}` : null, { orNull: true });

export async function createReviewRequest(input: { trackId: string; scope: 'track' | 'category' | 'questions'; categoryId?: string; questionIds?: string[]; reviewerIds: string[]; note: string; dueDate?: string }): Promise<string> {
  const r = await api.post<{ id: string }>('/api/reviews', input);
  await refresh();
  return r.id;
}

export async function closeReviewRequest(id: string): Promise<void> {
  await api.post(`/api/reviews/${id}/close`);
  await refresh();
}

export const useMyReviews = () => useApi<MyReview[]>(['mine'], '/api/my-reviews') as MyReview[] | undefined;
export const useMyReview = (id: string | undefined) => useApi<MyReviewDetail>(['mine', id], id ? `/api/my-reviews/${encodeURIComponent(id)}` : null, { orNull: true });

export async function setItemDone(requestId: string, questionId: string, done: boolean): Promise<void> {
  await api.put(`/api/my-reviews/${requestId}/items/${questionId}`, { done });
  await refresh();
}
