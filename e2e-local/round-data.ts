// Builds files the way other computers would send them (interview results inside a panel file),
// from an invitation file exported through the UI. Used to give the Summary screen many candidates
// in mixed states without driving dozens of interviews; everything still enters the app through
// "Import files", with the app's own validation.
import { randomUUID } from 'node:crypto';

interface InvitationEntry {
  invitationId: string;
  candidate: { initials: string; requisitionId: string | null };
  date: string | null;
  time: string | null;
  expectedInterviewers: string[];
  retentionUntil: string;
  plan: { id: string; questions: Array<{ id: string; lookFor: string[] }> };
}

export interface JudgementSpec {
  name: string;
  /** One score per question (null: left out); a single number scores every question the same. */
  scores: number | Array<number | null>;
  rating: 1 | 2 | 3 | 4;
  recommendation: 'strong_hire' | 'hire' | 'lean_no_hire' | 'no_hire';
  rationale?: string;
  notes?: Record<number, string>;
  flagged?: number[];
}

export interface PanelSpec {
  judgements: JudgementSpec[];
  decision?: { recommendation: JudgementSpec['recommendation']; rationale: string; participants: string[] } | null;
  summary?: string | null;
}

const ts = (d: Date) => d.toISOString();

/** One panel entry for a planned interview, with the given judgements (and optionally a decision and summary). */
export function panelEntry(inv: InvitationEntry, spec: PanelSpec, now = new Date()) {
  const judgements = spec.judgements.map((j, k) => {
    const id = randomUUID();
    const at = new Date(now.getTime() - (k + 1) * 3600_000);
    const scores = inv.plan.questions.map((_, i) => (Array.isArray(j.scores) ? (j.scores[i] ?? null) : j.scores));
    return {
      session: {
        id,
        planId: inv.plan.id,
        candidate: { initials: inv.candidate.initials, requisitionId: inv.candidate.requisitionId, consentAt: ts(at), retentionUntil: inv.retentionUntil },
        interviewer: { name: j.name },
        interviewers: [j.name],
        state: 'submitted',
        currentQuestionId: null,
        timer: { accumulatedMs: 3_000_000, runningSince: null },
        overall: { rating: j.rating, recommendation: j.recommendation, rationale: j.rationale ?? `${j.name}: the evidence in my notes supports this.` },
        createdAt: ts(at),
        startedAt: ts(at),
        submittedAt: ts(new Date(at.getTime() + 3_000_000)),
        origin: 'local',
        invitationId: inv.invitationId,
      },
      answers: inv.plan.questions.flatMap((q, i) => {
        const s = scores[i];
        if (s == null) return [];
        const note = j.notes?.[i] ?? (s === 1 || s === 4 ? `${j.name} noted: ${s === 4 ? 'excellent, concrete example' : 'could not explain the basics'}.` : '');
        return [
          {
            sessionId: id,
            questionId: q.id,
            score: s,
            coveredKeyPoints: [],
            redFlagsSeen: [],
            probeHandled: false,
            notes: note ? [{ atSec: 60 * (i + 1), text: note }] : [],
            flagged: j.flagged?.includes(i) ?? false,
            skipped: false,
            skipReason: null,
            elapsedSec: 180,
          },
        ];
      }),
    };
  });
  return {
    plan: inv.plan,
    candidate: inv.candidate,
    retentionUntil: inv.retentionUntil,
    expected: inv.expectedInterviewers,
    date: inv.date,
    time: inv.time,
    judgements,
    decision: spec.decision ? { ...spec.decision, rating: null, scores: {}, recordedBy: 'Olive Organiser', recordedAt: ts(now) } : null,
    summary: spec.summary ? { text: spec.summary, updatedBy: 'Olive Organiser', updatedAt: ts(now) } : null,
  };
}

/** A panel file holding these panels (as another computer would export it). */
export function panelFileText(entries: unknown[], exportedBy = 'Olive Organiser'): string {
  return JSON.stringify({ kind: 'interview-panel', formatVersion: 1, exportedAt: new Date().toISOString(), exportedBy, panels: entries });
}

const RECS = ['strong_hire', 'hire', 'lean_no_hire', 'no_hire'] as const;

/**
 * A realistic mix for a round: some decided, some split, some waiting for a judgement, some with
 * one judgement, some not interviewed yet. `i` picks the pattern.
 */
export function mixedSpec(i: number, names: string[]): PanelSpec {
  const [a, b] = names;
  const pick = (k: number) => RECS[k % 4];
  switch (i % 6) {
    case 0:
      return {
        judgements: [
          { name: a, scores: [4, 3, 3, 4, 3, 3, 2, 3, 3, 4, 3, 3, 3, 3], rating: 3, recommendation: 'hire', flagged: [6] },
          { name: b, scores: 3, rating: 3, recommendation: 'hire' },
        ],
        decision: { recommendation: 'hire', rationale: 'Strong on test strategy and automation; minor gaps in performance testing are coachable.', participants: [a, b] },
        summary: 'Clear, structured thinker with real automation experience. Recommend moving to the final round.',
      };
    case 1:
      return {
        judgements: [
          { name: a, scores: [3, 3, 2, 3, 3, 2, 2, 3, 2, 3, 3, 2, 3, 3], rating: 3, recommendation: 'hire' },
          { name: b, scores: [2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 3, 2, 2, 2], rating: 2, recommendation: 'lean_no_hire' },
        ],
      };
    case 2:
      return { judgements: [{ name: a, scores: [2, 3, 2, 2, 3, 2, 2, 2, 1, 2, 3, 2, 2, 2], rating: 2, recommendation: pick(i) === 'strong_hire' ? 'lean_no_hire' : pick(i) }] };
    case 3:
      return { judgements: [] };
    case 4:
      return {
        judgements: [
          { name: a, scores: 2, rating: 2, recommendation: 'no_hire' },
          { name: b, scores: [1, 2, 1, 2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 2], rating: 1, recommendation: 'no_hire' },
        ],
        decision: { recommendation: 'no_hire', rationale: 'Could not explain the basics of test design; both interviewers agree.', participants: [a, b] },
      };
    default:
      return {
        judgements: [
          { name: a, scores: 4, rating: 4, recommendation: 'strong_hire' },
          { name: b, scores: [4, 4, 3, 4, 4, 3, 4, 4, 4, 3, 4, 4, 4, 4], rating: 4, recommendation: 'strong_hire' },
        ],
      };
  }
}
