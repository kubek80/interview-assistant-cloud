import type { Answer, Category, InterviewPlan, Question, Score, TrackFile } from '../domain/types';
import { planFingerprint } from '../domain/plan';

export function makeQuestion(p: Partial<Question> & { id: string }): Question {
  return {
    trackId: 't',
    categoryId: 't-cat',
    number: Number(p.id.split('-').pop()) || 1,
    text: `Question ${p.id}`,
    description: `What question ${p.id} is asking`,
    difficulty: 'core',
    type: 'knowledge',
    lookFor: ['a', 'b', 'c', 'd'],
    redFlags: ['x'],
    probes: ['why?'],
    timeMin: 3,
    version: 1,
    status: 'active',
    rubricOverride: null,
    ...p,
  };
}

export function makeCategory(p: Partial<Category> & { id: string }): Category {
  return { trackId: 't', name: p.id, weight: 1, mustHave: false, ...p };
}

export function makePlan(questions: Question[], categories: Category[], p: Partial<InterviewPlan> = {}): InterviewPlan {
  const plan: InterviewPlan = {
    id: 'plan-1',
    trackId: 't',
    trackVersion: '1',
    name: 'Test plan',
    questions,
    categories,
    timeBudgetMin: 60,
    locked: true,
    lockedAt: '2026-11-01T10:00:00.000Z',
    fingerprint: null,
    createdAt: '2026-11-01T09:00:00.000Z',
    ...p,
  };
  if (plan.locked && !p.fingerprint) plan.fingerprint = planFingerprint(plan);
  return plan;
}

export function makeAnswer(questionId: string, p: Partial<Answer> = {}): Answer {
  return {
    sessionId: 's1',
    questionId,
    score: null,
    coveredKeyPoints: [],
    redFlagsSeen: [],
    probeHandled: false,
    notes: [],
    flagged: false,
    skipped: false,
    skipReason: null,
    elapsedSec: 0,
    timer: { accumulatedMs: 0, runningSince: null },
    ...p,
  };
}

export const scored = (questionId: string, score: Score, p: Partial<Answer> = {}) =>
  makeAnswer(questionId, { score, notes: score === 1 || score === 4 ? [{ atSec: 10, text: 'evidence' }] : [], ...p });
export const skipped = (questionId: string, reason = 'Out of time') => makeAnswer(questionId, { skipped: true, skipReason: reason });

/** The four-question plan from the worked example in docs/04-scoring.md. */
export function workedExamplePlan(networkingMustHave = false): InterviewPlan {
  const strategy = makeCategory({ id: 't-strategy', name: 'Strategy', weight: 1.0 });
  const networking = makeCategory({ id: 't-networking', name: 'Networking', weight: 1.2, mustHave: networkingMustHave });
  return makePlan(
    [
      makeQuestion({ id: 't-1', difficulty: 'core', categoryId: strategy.id }),
      makeQuestion({ id: 't-2', difficulty: 'advanced', categoryId: networking.id }),
      makeQuestion({ id: 't-3', difficulty: 'expert', categoryId: strategy.id }),
      makeQuestion({ id: 't-4', difficulty: 'advanced', categoryId: strategy.id }),
    ],
    [strategy, networking],
  );
}

export function makeTrackFile(trackId = 'tt', version = '2026.11', count = 3): TrackFile {
  return {
    track: { id: trackId, name: `Track ${trackId}`, version },
    categories: [
      { id: `${trackId}-alpha`, name: 'Alpha', weight: 1, mustHave: false },
      { id: `${trackId}-beta`, name: 'Beta', weight: 1, mustHave: true },
    ],
    questions: Array.from({ length: count }, (_, i) => ({
      id: `${trackId}-${i + 1}`,
      number: i + 1,
      categoryId: i % 2 ? `${trackId}-beta` : `${trackId}-alpha`,
      text: `Question ${i + 1} of ${trackId}`,
      description: `Steer for question ${i + 1} of ${trackId}`,
      difficulty: 'core' as const,
      type: 'knowledge' as const,
      timeMin: 3,
      lookFor: ['one', 'two'],
      redFlags: ['bad'],
      probes: ['probe?'],
      version: 1,
      status: 'active' as const,
      rubricOverride: null,
    })),
  };
}
