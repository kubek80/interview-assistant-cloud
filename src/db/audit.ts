// The audit log from the server (HPRIV-4, AUD-3).
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, qs } from './http';
import { useLiveTopics } from './live';
import type { AuditEntry, Page } from '../shared/api';

export interface AuditFilter {
  action?: string;
  from?: string;
  to?: string;
  q?: string;
}

const params = (f: AuditFilter) => ({ action: f.action, from: f.from, to: f.to, q: f.q });

export function useAuditLog(filter: AuditFilter) {
  useLiveTopics('audit');
  const q = useInfiniteQuery({
    queryKey: ['audit', filter],
    queryFn: ({ pageParam }) => api.get<Page<AuditEntry>>(`/api/audit${qs({ ...params(filter), cursor: pageParam, limit: 100 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (q.isError) throw q.error;
  return { entries: q.data ? q.data.pages.flatMap((p) => p.items) : undefined, hasMore: !!q.hasNextPage, loadMore: () => void q.fetchNextPage(), loadingMore: q.isFetchingNextPage };
}

/** AUD-3: the filtered log as CSV (the export is itself audited on the server). */
export async function exportAuditCsv(filter: AuditFilter): Promise<{ fileName: string; mime: string; text: string }> {
  const res = await fetch(`/api/audit/export${qs(params(filter))}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('The export failed. Try again.');
  return { fileName: `audit-${new Date().toISOString().slice(0, 10)}.csv`, mime: 'text/csv', text: await res.text() };
}

/** Plain words for the actions the log records (unknown ones are shown as they are). */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'round.created': 'Round created',
  'round.changed': 'Round settings changed',
  'round.closed': 'Round closed',
  'round.reopened': 'Round reopened',
  'round.member_added': 'Added to the team',
  'round.member_changed': 'Team role changed',
  'round.member_removed': 'Removed from the team',
  'question_set.changed': 'Questions changed',
  'question_set.fixed': 'Questions fixed',
  'question_set.replaced': 'New questions for future interviews',
  'interview.planned': 'Interview planned',
  'interview.planned_many': 'Several interviews planned',
  'interview.changed': 'Interview changed',
  'interview.cancelled': 'Interview cancelled',
  'user.added': 'Person added',
  'user.changed': 'Person changed',
  'user.deactivated': 'Person deactivated',
  'user.reactivated': 'Person reactivated',
  'user.removed': 'Person removed',
  'auth.signed_in': 'Signed in',
  'auth.signed_out': 'Signed out',
  'audit.exported': 'Audit log exported',
  'settings.changed': 'Settings changed',
  export: 'Export',
  import: 'Import',
  'bank.question_added': 'Question added',
  'bank.question_edited': 'Question edited',
  'bank.question_retired': 'Question retired',
  'bank.question_restored': 'Question restored',
  'bank.category_added': 'Category added',
  'bank.category_edited': 'Category edited',
  'bank.category_removed': 'Category removed',
  'bank.track_created': 'Track created',
  'proposal.created': 'Proposal made',
  'proposal.accepted': 'Proposal accepted',
  'proposal.declined': 'Proposal declined',
  'proposal.withdrawn': 'Proposal withdrawn',
  'review.requested': 'Review requested',
  'review.closed': 'Review request closed',
};
