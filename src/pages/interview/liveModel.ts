// Pure helpers for the hosted live interview (LIVE-1…LIVE-8). They turn the API's shapes into the
// local app's (InterviewPlan, Session, Answer) so the ported screens, the finish rules and the scoring
// module are used unchanged, and they work out what the people bar and the panel strip show.
import type { InterviewDetail, LiveRecords, LiveState, OtherRecord, QuestionSetDetail, RecordDetail } from '../../shared/api';
import type { InterviewPlan, Question, Score, Session } from '../../domain/types';
import { initialsOf, isPresent, toDomainOverall, waitingFor } from '../../domain/live';
import { namesList } from '../../domain/rounds';

export function toPlan(set: QuestionSetDetail): InterviewPlan {
  return {
    id: set.id,
    trackId: set.trackId,
    trackVersion: set.trackVersion,
    name: set.name,
    questions: set.questions,
    categories: set.categories,
    timeBudgetMin: set.timeBudgetMin,
    locked: true,
    lockedAt: set.fixedAt,
    fingerprint: set.fingerprint,
    createdAt: set.fixedAt ?? '',
  };
}

/** The record as the local app's Session (id = the record's id), for the ported finish, amend and scorecard parts. */
export function toSession(interview: InterviewDetail, record: RecordDetail, live: Pick<LiveState, 'state' | 'currentQuestionId' | 'timer' | 'startedAt' | 'consent'> | null, startedAt?: string | null): Session {
  const names = record.names.length ? record.names : ['—'];
  return {
    id: record.id,
    planId: interview.set.id,
    candidate: {
      initials: interview.candidate.name,
      requisitionId: interview.candidate.requisitionId,
      consentAt: live?.consent?.at ?? null,
      retentionUntil: interview.retentionUntil,
      recordingNotice: interview.recordingNotice,
    },
    interviewer: { name: names[0] },
    interviewers: names,
    state: record.state === 'submitted' ? 'submitted' : live?.state === 'paused' ? 'paused' : 'in_progress',
    currentQuestionId: live?.currentQuestionId ?? null,
    timer: live?.timer ?? { accumulatedMs: 0, runningSince: null },
    overall: toDomainOverall(record.overall),
    createdAt: interview.createdAt,
    startedAt: live?.startedAt ?? startedAt ?? null,
    submittedAt: record.submittedAt,
    origin: 'local',
  };
}

export interface PersonChip {
  id: string;
  name: string;
  initials: string;
  present: boolean;
  leading: boolean;
  isMe: boolean;
  /** "joined", "submitted", "not joined yet", "did not take part", "on Ana's screen". */
  note: string;
}

/** LIVE-2, LIVE-3: who is in the interview right now, who leads, and where each of the others is. */
export function peopleChips(state: Pick<LiveState, 'panel' | 'leadUserId'>, meId: string, now: number): PersonChip[] {
  const byId = new Map(state.panel.map((p) => [p.id, p]));
  return state.panel.map((p) => {
    const host = p.onRecordOf ? byId.get(p.onRecordOf) : undefined;
    const present = host ? isPresent(host.seenAt, now) : isPresent(p.seenAt, now);
    const note =
      p.status === 'did_not_take_part'
        ? 'did not take part'
        : p.status === 'submitted'
          ? 'submitted'
          : host
            ? `on ${host.name}’s screen`
            : p.status === 'expected'
              ? 'not joined yet'
              : present
                ? 'here'
                : 'away';
    return { id: p.id, name: p.name, initials: initialsOf(p.name), present: present && p.status !== 'submitted', leading: state.leadUserId === p.id, isMe: p.id === meId, note };
  });
}

/** "Waiting for Ben and Cy" (LIVE-4), or null when nobody is still interviewing. */
export function waitingLine(panel: LiveState['panel'], meId?: string): string | null {
  const names = waitingFor(panel.filter((p) => p.id !== meId));
  return names.length ? `Waiting for ${namesList(names)}` : null;
}

export interface PanelMark {
  recordId: string;
  ownerId: string;
  names: string[];
  /** They have scored or skipped this question. */
  resolved: boolean;
  /** Their marks, when the round lets me see them (LIVE-3). */
  score: Score | null;
  skipped: boolean;
  skipReason: string | null;
  keyPoints: string[];
  redFlags: string[];
  probeHandled: boolean;
  notes: Array<{ id: string; text: string; atSec: number; by: string | null }>;
  hidden: boolean;
}

/** LIVE-3: each other panel member's marks for one question, as I may see them. */
export function panelMarks(question: Pick<Question, 'id' | 'lookFor' | 'redFlags'>, others: readonly OtherRecord[]): PanelMark[] {
  return others.map((o) => {
    const a = o.marks?.answers.find((x) => x.questionId === question.id);
    return {
      recordId: o.id,
      ownerId: o.ownerId,
      names: o.names,
      resolved: o.resolved.includes(question.id),
      score: a?.score ?? null,
      skipped: !!a?.skipped,
      skipReason: a?.skipReason ?? null,
      keyPoints: (a?.coveredKeyPoints ?? []).map((i) => question.lookFor[i]).filter((s): s is string => !!s),
      redFlags: (a?.redFlagsSeen ?? []).map((i) => question.redFlags[i]).filter((s): s is string => !!s),
      probeHandled: !!a?.probeHandled,
      notes: (o.marks?.notes ?? []).filter((n) => n.questionId === question.id).map((n) => ({ id: n.id, text: n.text, atSec: n.atSec, by: n.by })),
      hidden: !o.marks,
    };
  });
}

/** The one-line summary of the panel strip: "Ben 3 · Cy —" (or "Ben ✓ · Cy —" while hidden). */
export function panelSummary(marks: readonly PanelMark[]): string {
  return marks.map((m) => `${firstName(m.names)} ${m.hidden ? (m.resolved ? 'scored' : 'not yet') : m.skipped ? 'skipped' : m.score != null ? String(m.score) : '—'}`).join(' · ');
}

export function firstName(names: readonly string[]): string {
  const first = (names[0] ?? '').split(/\s+/)[0];
  return names.length > 1 ? `${first} +${names.length - 1}` : first;
}

/** LIVE-2: what to tell me, once, when the lead changes. Null when nothing needs saying. */
export function leadChangeMessage(prev: string | null | undefined, next: string | null, meId: string, nameOf: (id: string) => string): string | null {
  if (prev === undefined || prev === next) return null;
  if (next === meId) return 'You are leading now: your Next, Previous and Pause move everyone.';
  if (prev === meId && next) return `${nameOf(next)} took the lead. Your Next and Previous now only change what you see.`;
  if (next) return `${nameOf(next)} is leading now.`;
  return null;
}

/** RES-3: the saving line in the header. */
export function savingLine(state: 'saved' | 'saving' | 'offline', pending: number, connection: 'connecting' | 'live' | 'offline', online: boolean): { tone: 'ok' | 'busy' | 'warn'; text: string } {
  if (!online || state === 'offline') {
    return { tone: 'warn', text: pending ? `Offline · ${pending} change${pending === 1 ? '' : 's'} kept on this computer` : 'Offline · nothing waiting to be saved' };
  }
  if (connection !== 'live') return { tone: 'busy', text: pending ? 'Reconnecting · saving your changes' : 'Reconnecting…' };
  if (state === 'saving') return { tone: 'busy', text: 'Saving…' };
  return { tone: 'ok', text: 'All changes saved' };
}

export type { LiveRecords };
