import type { Difficulty, Question, QuestionType, RubricOverride, Score, ScoreKey } from './types';

export interface RubricLevel {
  score: Score;
  label: string;
  description: string;
  /** True when the description comes from the question's rubricOverride (RUB-2). */
  overridden: boolean;
}

/** RUB-1: the shared scale. */
export const RUBRIC_LEVELS: readonly RubricLevel[] = [
  { score: 1, label: 'Poor', description: 'Any red flag, or under 25% of the key points. The answer is wrong or memorised.', overridden: false },
  { score: 2, label: 'Partial', description: 'Some key points but shallow, with no trade-offs or examples.', overridden: false },
  { score: 3, label: 'Solid senior', description: 'Most key points, correct and grounded in experience, covering trade-offs.', overridden: false },
  { score: 4, label: 'Exceptional', description: 'All key points plus failure modes, alternatives and quantified outcomes. Handles the probe without help.', overridden: false },
];

export function scoreLabel(score: Score): string {
  return RUBRIC_LEVELS[score - 1].label;
}

/** RUB-2: shared levels with any per-question override applied. */
export function rubricFor(question: { rubricOverride: RubricOverride } | null | undefined): RubricLevel[] {
  const override = question?.rubricOverride ?? null;
  return RUBRIC_LEVELS.map((level) => {
    const text = override?.[String(level.score) as ScoreKey];
    return typeof text === 'string' && text.trim() ? { ...level, description: text, overridden: true } : { ...level };
  });
}

/**
 * RUB-5: what every behavioural question's key points and red flags cover. Each question says it in
 * its own words (the bundled questions do), so these are not listed on any question; the editor
 * offers them as starting items for a new behavioural question, written as BANK-15 asks ("label:
 * what you would hear"), to be reworded for that question.
 */
export const BEHAVIOURAL_STARTING_KEY_POINTS = [
  'Specific situation: describes one real occasion, with when it happened, who was involved and what was at stake.',
  'Own actions: makes clear what they personally did and decided, saying "I" where it was their work.',
  'Measurable result: gives the outcome with evidence, such as numbers, dates or a change that lasted.',
  'Reflection: says what they learned and what they would do differently next time.',
] as const;
export const BEHAVIOURAL_STARTING_RED_FLAGS = [
  'Answers hypothetically ("I would…") or in general principles instead of describing a real occasion.',
  'Blames others for what went wrong without looking at their own part.',
  'Cannot say how it ended or what result it had.',
] as const;

/** RUB-6 tag letters. */
export const DIFFICULTY_TAG: Record<Difficulty, string> = { core: 'C', advanced: 'A', expert: 'E' };
export const TYPE_TAG: Record<QuestionType, string> = { knowledge: 'K', scenario: 'S', design: 'D', behavioural: 'B' };
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { core: 'Core', advanced: 'Advanced', expert: 'Expert' };
export const TYPE_LABEL: Record<QuestionType, string> = { knowledge: 'Knowledge', scenario: 'Scenario', design: 'Design', behavioural: 'Behavioural' };

/** RUB-6: behavioural questions are treated as core. */
export function effectiveDifficulty(q: Pick<Question, 'difficulty' | 'type'>): Difficulty {
  return q.type === 'behavioural' ? 'core' : q.difficulty;
}

export interface Ticks {
  keyPointCount: number;
  coveredKeyPoints: readonly number[];
  redFlagsSeen: readonly number[];
  probeHandled: boolean;
}

/**
 * RUB-3: first matching rule wins. Returns null until at least one box is ticked.
 * Advisory only: never applied automatically (FLOW-14).
 */
export function suggestScore(t: Ticks): Score | null {
  const covered = new Set(t.coveredKeyPoints).size;
  if (covered === 0 && t.redFlagsSeen.length === 0 && !t.probeHandled) return null;
  if (t.redFlagsSeen.length > 0) return 1;
  const ratio = t.keyPointCount > 0 ? covered / t.keyPointCount : 1;
  if (ratio < 0.25) return 1;
  if (ratio < 0.6) return 2;
  if (ratio >= 1 && t.probeHandled) return 4;
  return 3;
}

export function suggestScoreFor(question: Pick<Question, 'lookFor'>, answer: Omit<Ticks, 'keyPointCount'>): Score | null {
  return suggestScore({ ...answer, keyPointCount: question.lookFor.length });
}
