// The Users page's data (USER-1…USER-4).
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, qs } from './http';
import { queryClient } from './queryClient';
import { useLiveTopics } from './live';
import type { InvitePreviewLine, InviteResult, Page, Role, UserSummary } from '../shared/api';

const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

/** Everyone with access, a page at a time (all pages loaded so far, in email order). */
export function useUsers(search = '') {
  useLiveTopics('users');
  const q = useInfiniteQuery({
    queryKey: ['users', 'list', search],
    queryFn: ({ pageParam }) => api.get<Page<UserSummary>>(`/api/users${qs({ cursor: pageParam, q: search.trim() || undefined, limit: 200 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (q.isError) throw q.error;
  return {
    users: q.data ? q.data.pages.flatMap((p) => p.items) : undefined,
    hasMore: !!q.hasNextPage,
    loadMore: () => void q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
  };
}

export function previewInvites(text: string): Promise<InvitePreviewLine[]> {
  return api.post('/api/users/preview', { text });
}

export async function addUsers(text: string, role: Role): Promise<InviteResult> {
  const r = await api.post<InviteResult>('/api/users', { text, role });
  await refresh();
  return r;
}

export async function updateUser(id: string, patch: { role?: Role; active?: boolean }): Promise<UserSummary> {
  const r = await api.patch<UserSummary>(`/api/users/${id}`, patch);
  await refresh();
  await queryClient.invalidateQueries({ queryKey: ['me'] });
  return r;
}

export async function removeUser(id: string): Promise<void> {
  await api.del(`/api/users/${id}`);
  await refresh();
}
