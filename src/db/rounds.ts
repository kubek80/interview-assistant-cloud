// Hiring rounds, their teams and question sets, and planned interviews over the API (ROUND-1…ROUND-5,
// FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15). Every query key starts with 'round': a live event on any
// `round:<id>` topic (and the signed-in person's `user:<id>` "rounds" events) refetches them all.
//
// Query keys in use (step 2b adds its own under ['round', id, …] and ['round', 'interview', id, …]):
//   ['round', 'list']                     the rounds I can see
//   ['round', 'mine', 'interviews']       every interview in the rounds I am on (the Dashboard)
//   ['round', id]                         one round with its team
//   ['round', id, 'interviews']           a round's interviews
//   ['round', id, 'question-set']         a round's current question set
//   ['round', id, 'team-options']         people who can join the team
//   ['round', id, 'audit']                the round's audit entries
//   ['round', 'set', setId]               any question set by id
//   ['round', 'interview', id]            one interview (ready screen)
import { useQuery } from '@tanstack/react-query';
import { api } from './http';
import { orNull, queryClient, throwIfFatal } from './queryClient';
import { useLiveTopics } from './live';
import { useMe } from './auth';
import type {
  AuditEntry,
  ChangeInterviewInput,
  InterviewDetail,
  InterviewSummary,
  PlanInterviewInput,
  PlanManyInput,
  QuestionSetDetail,
  QuestionSetInput,
  RoundDetail,
  RoundMember,
  RoundRole,
  RoundSummary,
  SaveQuestionSetResult,
  TeamOption,
} from '../shared/api';

const refresh = () => queryClient.invalidateQueries({ queryKey: ['round'] });

function useData<T>(key: readonly unknown[], fn: () => Promise<T>, enabled = true): T | undefined {
  // Round data changes as others plan: refetch whenever a screen opens (live events cover the rest).
  const q = useQuery({ queryKey: key, queryFn: fn, enabled, staleTime: 0 });
  throwIfFatal(q);
  return q.data;
}

/**
 * ROUND-2: the rounds the signed-in person can see (administrators: all). Follows each of them live;
 * `all` (administrators) also hears of rounds created by anyone. Being added to or removed from a
 * round arrives on the person's own `user:<id>` topic, which is always followed.
 */
export function useRounds(opts: { all?: boolean } = {}): RoundSummary[] | undefined {
  const data = useData(['round', 'list'], () => api.get<RoundSummary[]>('/api/rounds'));
  const me = useMe();
  useLiveTopics(me ? `user:${me.id}` : '', opts.all ? 'rounds' : '', ...(data ?? []).slice(0, 40).map((r) => `round:${r.id}`));
  return data;
}

export function useRound(id: string | undefined): RoundDetail | null | undefined {
  useLiveTopics(id ? `round:${id}` : '');
  return useData(['round', id], () => orNull(api.get<RoundDetail>(`/api/rounds/${id}`)), !!id);
}

export function useRoundInterviews(id: string | undefined): InterviewSummary[] | null | undefined {
  useLiveTopics(id ? `round:${id}` : '');
  return useData(['round', id, 'interviews'], () => orNull(api.get<InterviewSummary[]>(`/api/rounds/${id}/interviews`)), !!id);
}

export function useRoundQuestionSet(id: string | undefined): QuestionSetDetail | null | undefined {
  useLiveTopics(id ? `round:${id}` : '');
  return useData(['round', id, 'question-set'], () => orNull(api.get<QuestionSetDetail>(`/api/rounds/${id}/question-set`)), !!id);
}

export function useQuestionSet(setId: string | undefined): QuestionSetDetail | null | undefined {
  return useData(['round', 'set', setId], () => orNull(api.get<QuestionSetDetail>(`/api/question-sets/${setId}`)), !!setId);
}

export function useTeamOptions(roundId: string | undefined, enabled = true): TeamOption[] | undefined {
  return useData(['round', roundId, 'team-options'], () => api.get<TeamOption[]>(`/api/rounds/${roundId}/team-options`), !!roundId && enabled);
}

export function useRoundAudit(roundId: string | undefined, enabled = true): AuditEntry[] | undefined {
  return useData(['round', roundId, 'audit'], () => api.get<AuditEntry[]>(`/api/rounds/${roundId}/audit`), !!roundId && enabled);
}

/**
 * FLOW-1, FLOW-34, TEAM-16: every interview in the rounds I am on, soonest first. Follows each of
 * those rounds live, so planning anywhere in them shows up without reloading.
 */
export function useMyInterviews(rounds: readonly { id: string; myRole: RoundRole | null }[] | undefined): InterviewSummary[] | undefined {
  const mine = (rounds ?? []).filter((r) => r.myRole).slice(0, 40).map((r) => `round:${r.id}`);
  useLiveTopics(...mine);
  return useData(['round', 'mine', 'interviews'], () => api.get<InterviewSummary[]>('/api/my/interviews'));
}

export function useInterview(id: string | undefined): InterviewDetail | null | undefined {
  const q = useQuery({ queryKey: ['round', 'interview', id], queryFn: () => orNull(api.get<InterviewDetail>(`/api/interviews/${id}`)), enabled: !!id, staleTime: 0 });
  useLiveTopics(q.data ? `round:${q.data.roundId}` : '');
  throwIfFatal(q);
  return q.data;
}

// ---- Changes

export async function createRound(input: { name: string; trackId: string; requisitionId?: string | null }): Promise<string> {
  const r = await api.post<{ id: string }>('/api/rounds', input);
  await refresh();
  return r.id;
}

export async function updateRound(id: string, patch: { name?: string; requisitionId?: string | null; retentionUntil?: string; hideOthersScores?: boolean }): Promise<RoundDetail> {
  const r = await api.patch<RoundDetail>(`/api/rounds/${id}`, patch);
  await refresh();
  return r;
}

export async function closeRound(id: string, reason?: string): Promise<void> {
  await api.post(`/api/rounds/${id}/close`, reason ? { reason } : {});
  await refresh();
}

export async function reopenRound(id: string, reason: string): Promise<void> {
  await api.post(`/api/rounds/${id}/reopen`, { reason });
  await refresh();
}

export async function setRoundMember(roundId: string, userId: string, role: RoundRole): Promise<RoundMember[]> {
  const r = await api.put<RoundMember[]>(`/api/rounds/${roundId}/members/${userId}`, { role });
  await refresh();
  return r;
}

export async function removeRoundMember(roundId: string, userId: string): Promise<void> {
  await api.del(`/api/rounds/${roundId}/members/${userId}`);
  await refresh();
}

/** ROUND-3: save the round's questions (in place while unused; a new set once fixed, FLOW-9). */
export async function saveRoundQuestionSet(roundId: string, input: QuestionSetInput & { baseSetId: string; baseVersion: number }): Promise<SaveQuestionSetResult> {
  const r = await api.put<SaveQuestionSetResult>(`/api/rounds/${roundId}/question-set`, input);
  queryClient.setQueryData(['round', roundId, 'question-set'], r.set);
  await queryClient.invalidateQueries({ queryKey: ['round', roundId] });
  return r;
}

export async function planInterview(roundId: string, input: PlanInterviewInput): Promise<string> {
  const r = await api.post<{ id: string }>(`/api/rounds/${roundId}/interviews`, input);
  await refresh();
  return r.id;
}

export async function planMany(roundId: string, input: PlanManyInput): Promise<string[]> {
  const r = await api.post<{ ids: string[] }>(`/api/rounds/${roundId}/interviews/bulk`, input);
  await refresh();
  return r.ids;
}

export async function changeInterview(id: string, input: ChangeInterviewInput): Promise<InterviewDetail> {
  const r = await api.patch<InterviewDetail>(`/api/interviews/${id}`, input);
  await refresh();
  return r;
}

export async function cancelInterview(id: string, reason?: string): Promise<void> {
  await api.post(`/api/interviews/${id}/cancel`, reason ? { reason } : {});
  await refresh();
}

// Starting, joining and everything in a running interview: src/db/interview.ts.
