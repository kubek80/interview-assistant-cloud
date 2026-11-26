import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { BAND_LABELS, type Band } from '../domain/scoring';
import { DIFFICULTY_LABEL, DIFFICULTY_TAG, TYPE_LABEL, TYPE_TAG, effectiveDifficulty } from '../domain/rubric';
import type { Answer, Question, SessionState } from '../domain/types';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Status pill. Always carries text; colour is never the only signal (A11Y-3). */
export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={['badge', `badge--${tone}`, className].filter(Boolean).join(' ')}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

/** Short code tag such as a RUB-6 difficulty/type letter. `title` gives the full meaning. */
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="tag" title={title}>
      {children}
      {title && <span className="visually-hidden"> ({title})</span>}
    </span>
  );
}

/** RUB-6 tags: difficulty letter (none for behavioural) and type letter. */
export function QuestionTags({ question }: { question: Pick<Question, 'difficulty' | 'type'> }) {
  return (
    <span className="cluster">
      {question.type !== 'behavioural' && <Tag title={DIFFICULTY_LABEL[effectiveDifficulty(question)]}>{DIFFICULTY_TAG[question.difficulty]}</Tag>}
      <Tag title={TYPE_LABEL[question.type]}>{TYPE_TAG[question.type]}</Tag>
    </span>
  );
}

const BAND_ICON: Record<Band, IconName> = { strong_hire: 'check', hire: 'check', lean_no_hire: 'alert', no_hire: 'x' };

/**
 * SCORE-6/7/8/9, FLOW-25: the advisory band. Shows "Insufficient evidence" in place of a band, and
 * is always labelled advisory.
 */
export function BandBadge({ band, insufficientEvidence, capped }: { band: Band | null; insufficientEvidence?: boolean; capped?: boolean }) {
  if (insufficientEvidence) {
    return (
      <Badge tone="neutral" icon="info">
        Advisory: Insufficient evidence
      </Badge>
    );
  }
  if (!band) return <Badge tone="neutral">Advisory: no band yet</Badge>;
  return (
    <span className={`badge badge--band-${band}`}>
      <Icon name={BAND_ICON[band]} />
      Advisory: {BAND_LABELS[band]}
      {capped && ' (capped)'}
    </span>
  );
}

const STATE_META: Record<SessionState, { label: string; tone: Tone; icon: IconName }> = {
  planned: { label: 'Ready to start', tone: 'neutral', icon: 'circle' },
  in_progress: { label: 'In progress', tone: 'info', icon: 'play' },
  paused: { label: 'Paused', tone: 'warning', icon: 'pause' },
  submitted: { label: 'Submitted', tone: 'success', icon: 'check' },
};

/** FLOW-1 */
export function SessionStateBadge({ state }: { state: SessionState }) {
  const m = STATE_META[state];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

export type AnswerStatus = 'unanswered' | 'scored' | 'skipped';

/** FLOW-20 progress-list status (flagged is shown separately, as it combines with any status). */
export function answerStatus(answer: Pick<Answer, 'score' | 'skipped'> | null | undefined): AnswerStatus {
  if (answer?.skipped) return 'skipped';
  return answer?.score != null ? 'scored' : 'unanswered';
}

const ANSWER_META: Record<AnswerStatus | 'flagged' | 'needs-note', { label: string; tone: Tone; icon: IconName }> = {
  unanswered: { label: 'Unanswered', tone: 'neutral', icon: 'circle' },
  scored: { label: 'Scored', tone: 'success', icon: 'check' },
  skipped: { label: 'Skipped', tone: 'warning', icon: 'skip' },
  flagged: { label: 'Flagged', tone: 'info', icon: 'flag' },
  'needs-note': { label: 'Needs note', tone: 'danger', icon: 'note' },
};

export function QuestionStatusBadge({ status, children }: { status: AnswerStatus | 'flagged' | 'needs-note'; children?: ReactNode }) {
  const m = ANSWER_META[status];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {children ?? m.label}
    </Badge>
  );
}
