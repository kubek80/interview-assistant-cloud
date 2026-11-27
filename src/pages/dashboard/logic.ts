// Pure helpers for the Dashboard and a round's interview lists (FLOW-1, FLOW-34, TEAM-2, TEAM-16).
import type { InterviewStatus, InterviewSummary, RoundSummary } from '../../shared/api';
import { candidateKey, formatCandidateKey } from '../../domain/plan';

export { STATUS_LABELS } from '../../domain/rounds';

export interface DashboardModel {
  /** FLOW-34: interviews I am on that have started and that I have not submitted yet. */
  continuing: InterviewSummary[];
  /** TEAM-2, ROUND-4: my upcoming interviews first… */
  myUpcoming: InterviewSummary[];
  /** …then the rest of my rounds' upcoming interviews. */
  otherUpcoming: InterviewSummary[];
  /** Started or finished, most recent first. */
  others: InterviewSummary[];
  counts: Record<InterviewStatus, number>;
}

/** FLOW-1, FLOW-34, TEAM-2, TEAM-16: the signed-in person's view of their rounds' interviews. */
export function dashboardModel(items: readonly InterviewSummary[], meId: string): DashboardModel {
  const mine = (i: InterviewSummary) => i.panel.find((p) => p.id === meId);
  const continuing = items.filter((i) => {
    const m = mine(i);
    return (i.state === 'in_progress' || i.state === 'paused') && !!m && m.status !== 'submitted' && m.status !== 'did_not_take_part';
  });
  const upcoming = items.filter((i) => i.status === 'upcoming');
  const others = items
    .filter((i) => i.status !== 'upcoming' && !continuing.includes(i))
    .sort((a, b) => (b.date ?? b.createdAt.slice(0, 10)).localeCompare(a.date ?? a.createdAt.slice(0, 10)));
  const counts: Record<InterviewStatus, number> = { upcoming: 0, 'in-progress': 0, waiting: 0, finished: 0 };
  for (const i of items) counts[i.status]++;
  return { continuing, myUpcoming: upcoming.filter((i) => i.onMyPanel), otherUpcoming: upcoming.filter((i) => !i.onMyPanel), others, counts };
}

export interface ListFilter {
  /** Matches the candidate's name or initials and requisition id, ignoring case and extra spaces. */
  text: string;
  roundId: string;
  status: InterviewStatus | '';
}

export const NO_FILTER: ListFilter = { text: '', roundId: '', status: '' };

export function isFiltered(f: ListFilter): boolean {
  return !!(f.text.trim() || f.roundId || f.status);
}

/** TEAM-16: search by candidate; filter by round and state. */
export function filterInterviews(items: readonly InterviewSummary[], f: ListFilter): InterviewSummary[] {
  const needle = f.text.trim().toLowerCase().replace(/\s+/g, ' ');
  return items.filter(
    (i) =>
      (!needle || candidateLabel(i).toLowerCase().includes(needle) || candidateKey({ initials: i.candidate.name, requisitionId: i.candidate.requisitionId }).toLowerCase().includes(needle)) &&
      (!f.roundId || i.roundId === f.roundId) &&
      (!f.status || i.status === f.status),
  );
}

/** "Ana Diaz · REQ-1" or "AB". */
export function candidateLabel(i: Pick<InterviewSummary, 'candidate'>): string {
  return formatCandidateKey({ initials: i.candidate.name, requisitionId: i.candidate.requisitionId });
}

/** TEAM-2, TEAM-16: interviews grouped by day, in the order given (undated last). */
export function groupByDay<T extends { date: string | null }>(items: readonly T[]): Array<{ date: string | null; items: T[] }> {
  const groups: Array<{ date: string | null; items: T[] }> = [];
  for (const i of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === i.date) last.items.push(i);
    else groups.push({ date: i.date, items: [i] });
  }
  return groups;
}

export type PrimaryAction =
  | { kind: 'new-in-round'; round: Pick<RoundSummary, 'id' | 'name'> }
  | { kind: 'choose-round'; rounds: Array<Pick<RoundSummary, 'id' | 'name'>> }
  | { kind: 'create-round' }
  | { kind: 'next-interview'; interview: InterviewSummary }
  | { kind: 'none' };

/**
 * UX-9: the Dashboard's one obvious action. An organiser plans in the open rounds they organise
 * (straight into the round when there is just one); an interviewer opens their next interview;
 * someone who may create rounds but organises none creates one.
 */
export function primaryAction(rounds: readonly RoundSummary[], model: DashboardModel, canCreate: boolean): PrimaryAction {
  const organised = rounds.filter((r) => r.state === 'open' && r.myRole === 'organiser');
  if (organised.length === 1) return { kind: 'new-in-round', round: organised[0] };
  if (organised.length > 1) return { kind: 'choose-round', rounds: organised };
  if (model.myUpcoming.length) return { kind: 'next-interview', interview: model.myUpcoming[0] };
  if (canCreate) return { kind: 'create-round' };
  return { kind: 'none' };
}
