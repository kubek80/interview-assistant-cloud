// Pure helpers for the Dashboard (FLOW-1, FLOW-9, TEAM-2, TEAM-6, TEAM-16).
import type { IconName } from '../../ui/Icon';
import type { InterviewPlan, PlannedInterview, Session } from '../../domain/types';
import { candidateKey, formatCandidateKey } from '../../domain/plan';
import { interviewersOf, nameKey } from '../../domain/interviewers';
import { attendance, compareUpcoming, panelKey, type Attendance } from '../../domain/team';

export interface SessionAction {
  label: string;
  to: string;
  icon: IconName;
  /** Secondary action shown next to the primary one, if any. */
  secondary?: { label: string; to: string };
}

/**
 * FLOW-1: the right primary action for a session's state. Imported panelist sessions never link
 * to a scorecard (their scores stay blind until your own session is submitted, FLOW-27); they
 * link to the debrief, which applies the blinding.
 */
export function sessionAction(s: Pick<Session, 'id' | 'state' | 'origin'>): SessionAction {
  // Other people's records (imported, or entered here on their behalf, TEAM-7) open in the debrief.
  if (s.origin !== 'local') return { label: 'Open debrief', to: `/debrief/${s.id}`, icon: 'doc' };
  switch (s.state) {
    case 'planned':
      return { label: 'Ready to start', to: `/interview/${s.id}`, icon: 'play' };
    case 'in_progress':
    case 'paused':
      return { label: 'Resume', to: `/interview/${s.id}`, icon: 'play' };
    case 'submitted':
      return { label: 'Scorecard', to: `/scorecard/${s.id}`, icon: 'doc', secondary: { label: 'Debrief', to: `/debrief/${s.id}` } };
  }
}

/** The most relevant date for a session row: submitted, else started, else created. */
export function sessionDate(s: Pick<Session, 'createdAt' | 'startedAt' | 'submittedAt' | 'state'>): { label: string; iso: string } {
  if (s.submittedAt) return { label: 'Submitted', iso: s.submittedAt };
  if (s.startedAt) return { label: 'Started', iso: s.startedAt };
  return { label: 'Created', iso: s.createdAt };
}

/** Draft plans (still editable) and locked plans (reusable, exportable), newest first. */
export function splitPlans(plans: readonly InterviewPlan[]): { drafts: InterviewPlan[]; locked: InterviewPlan[] } {
  const sorted = [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { drafts: sorted.filter((p) => !p.locked), locked: sorted.filter((p) => p.locked) };
}

/** Count of sessions per plan id. */
export function sessionCounts(sessions: readonly Pick<Session, 'planId'>[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(s.planId, (m.get(s.planId) ?? 0) + 1);
  return m;
}

/**
 * FLOW-34: unfinished interviews made on this device, the one to continue first. Interviews planned
 * for later (TEAM-1: they carry an invitation id) wait under Upcoming instead, until they start.
 */
export function unfinishedSessions<S extends Pick<Session, 'state' | 'origin' | 'createdAt' | 'startedAt' | 'invitationId'>>(sessions: readonly S[]): S[] {
  const rank: Record<Session['state'], number> = { in_progress: 0, paused: 1, planned: 2, submitted: 3 };
  return sessions
    .filter((s) => s.origin === 'local' && s.state !== 'submitted' && !(s.state === 'planned' && s.invitationId))
    .sort((a, b) => rank[a.state] - rank[b.state] || (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
}

/** Sessions for the "Recent interviews" list: most recent activity first. */
export function recentSessions<S extends Pick<Session, 'createdAt' | 'startedAt' | 'submittedAt' | 'state'>>(sessions: readonly S[]): S[] {
  return [...sessions].sort((a, b) => sessionDate(b).iso.localeCompare(sessionDate(a).iso));
}

/** Local time of day, e.g. "10:32". */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------------------------
// TEAM-2, TEAM-6, TEAM-16: the interviews on this device as the Dashboard lists them.

export type InterviewStatus = 'upcoming' | 'in-progress' | 'waiting' | 'finished' | 'other-device';

export const STATUS_LABELS: Record<InterviewStatus, string> = {
  upcoming: 'Upcoming',
  'in-progress': 'In progress',
  waiting: 'Waiting for other interviewers',
  finished: 'Finished',
  'other-device': 'From another computer',
};

export interface DashboardItem {
  /** The row's record: this device's own, or (for 'other-device') an imported one. */
  session: Session;
  plan: InterviewPlan | undefined;
  planned: PlannedInterview | undefined;
  status: InterviewStatus;
  /** Display text, e.g. "Ana Diaz · REQ-1". */
  candidate: string;
  requisition: string;
  trackId: string;
  /** TEAM-6: present when someone is expected or other people's records are held. */
  attendance: Attendance | null;
  /** Imported records in the same panel (FLOW-29). */
  others: number;
}

export interface DashboardModel {
  /** Interviews planned for later (TEAM-1) that have not started, soonest first (TEAM-2). */
  upcoming: DashboardItem[];
  /** Everything else, most recent activity first; other people's records are folded into their interview. */
  interviews: DashboardItem[];
  counts: Record<Exclude<InterviewStatus, 'other-device'>, number>;
}

/**
 * TEAM-16: one item per interview. Imported records that belong to an interview of this device
 * (same candidate key and fingerprint, FLOW-29) are not listed again: they show in its attendance.
 */
export function dashboardModel(sessions: readonly Session[], plans: readonly InterviewPlan[], planned: readonly PlannedInterview[]): DashboardModel {
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const keyOf = (s: Session) => panelKey(s.candidate, plansById.get(s.planId)?.fingerprint);
  const byPanel = new Map<string, Session[]>();
  for (const s of sessions) byPanel.set(keyOf(s), [...(byPanel.get(keyOf(s)) ?? []), s]);
  const plannedBySession = new Map(planned.map((p) => [p.sessionId, p]));
  const plannedByPanel = new Map<string, PlannedInterview[]>();
  for (const p of planned) {
    const k = panelKey(p.candidate, p.fingerprint);
    plannedByPanel.set(k, [...(plannedByPanel.get(k) ?? []), p]);
  }
  const items: DashboardItem[] = [];
  for (const s of sessions) {
    const k = keyOf(s);
    const group = byPanel.get(k) ?? [s];
    const hasLocal = group.some((g) => g.origin === 'local');
    // Other people's records (imported, or entered here on their behalf) fold into their interview.
    if (s.origin !== 'local' && hasLocal) continue;
    // Several such records with no local one: list the panel once, under its first record.
    if (s.origin !== 'local' && group.find((g) => g.origin !== 'local') !== s) continue;
    const own = plannedBySession.get(s.id);
    const panelPlanned = plannedByPanel.get(k) ?? [];
    const expected = (own ? [own] : panelPlanned).flatMap((p) => p.expected);
    const others = group.filter((g) => g.origin !== 'local').length;
    const att = expected.length || others ? attendance(expected, group) : null;
    const plan = plansById.get(s.planId);
    // An organiser who planned this for others (not among the expected) is not waited for: once
    // someone has submitted, the interview is no longer upcoming for them.
    const notMine = !!own && !!expected.length && !interviewersOf(s).some((n) => expected.some((e) => nameKey(e) === nameKey(n)));
    let status: InterviewStatus;
    if (s.origin !== 'local') status = 'other-device';
    else if (s.state === 'planned' && notMine && att && att.submitted.length) status = att.toCome.length ? 'waiting' : 'finished';
    else if (s.state === 'planned') status = 'upcoming';
    else if (s.state !== 'submitted') status = 'in-progress';
    else status = att && att.toCome.length ? 'waiting' : 'finished';
    items.push({
      session: s,
      plan,
      planned: own,
      status,
      candidate: formatCandidateKey(s.candidate),
      requisition: (s.candidate.requisitionId ?? '').trim().toUpperCase(),
      trackId: plan?.trackId ?? '',
      attendance: att,
      others,
    });
  }
  const upcoming = items
    .filter((i) => i.status === 'upcoming' && i.planned)
    .sort((a, b) => compareUpcoming(a.planned!, b.planned!));
  const interviews = recentSessions(items.map((i) => i.session))
    .map((s) => items.find((i) => i.session === s)!)
    .filter((i) => !(i.status === 'upcoming' && i.planned));
  const counts = { upcoming: 0, 'in-progress': 0, waiting: 0, finished: 0 };
  for (const i of items) if (i.status !== 'other-device') counts[i.status]++;
  return { upcoming, interviews, counts };
}

export interface DashboardFilter {
  /** Matches the candidate's name or initials and the requisition id (case-insensitive). */
  text: string;
  trackId: string;
  requisition: string;
  status: InterviewStatus | '';
}

export const NO_FILTER: DashboardFilter = { text: '', trackId: '', requisition: '', status: '' };

export function isFiltered(f: DashboardFilter): boolean {
  return !!(f.text.trim() || f.trackId || f.requisition || f.status);
}

/** TEAM-16: search by candidate; filter by role, requisition and state. */
export function filterItems(items: readonly DashboardItem[], f: DashboardFilter): DashboardItem[] {
  const needle = f.text.trim().toLowerCase().replace(/\s+/g, ' ');
  return items.filter(
    (i) =>
      (!needle || i.candidate.toLowerCase().includes(needle) || candidateKey(i.session.candidate).toLowerCase().includes(needle)) &&
      (!f.trackId || i.trackId === f.trackId) &&
      (!f.requisition || i.requisition === f.requisition) &&
      (!f.status || i.status === f.status),
  );
}

/** TEAM-2, TEAM-16: Upcoming grouped by day, in order (undated last). */
export function groupByDay(items: readonly DashboardItem[]): Array<{ date: string | null; items: DashboardItem[] }> {
  const groups: Array<{ date: string | null; items: DashboardItem[] }> = [];
  for (const i of items) {
    const d = i.planned?.date ?? null;
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.items.push(i);
    else groups.push({ date: d, items: [i] });
  }
  return groups;
}
