import { useId } from 'react';
import { Icon } from '../../ui/Icon';
import { Button } from '../../ui/Button';
import { rubricFor } from '../../domain/rubric';
import type { Question, Score } from '../../domain/types';

interface ScoreControlProps {
  question: Pick<Question, 'rubricOverride'>;
  value: Score | null;
  suggested?: Score | null;
  disabled?: boolean;
  onChange: (score: Score) => void;
  onClear?: () => void;
  /** Show the 1-4 key hints (KEY-1). */
  showKeys?: boolean;
  legend?: string;
  /**
   * "cards" shows every level's description (the amend form). "bar" is the compact row of the live
   * interview's bottom bar: the description of a level appears above the row while it is hovered or
   * focused, and is always its accessible description; the full list is behind the "Rubric" button.
   */
  variant?: 'cards' | 'bar';
  /** Extra id(s) the radio group is described by (e.g. the hint line under the bar). */
  describedBy?: string;
  /** Keep the legend for screen readers only (the four labelled buttons explain themselves). */
  hideLegend?: boolean;
}

/**
 * RUB-1 / RUB-2 / FLOW-14: the 1-4 score as a native radio group, each level with its label and the
 * description resolved for this question. The suggestion is marked but never selected for you.
 */
export function ScoreControl({ question, value, suggested, disabled, onChange, onClear, showKeys = true, legend = 'Score', variant = 'cards', describedBy, hideLegend }: ScoreControlProps) {
  const name = useId();
  const levels = rubricFor(question);
  const bar = variant === 'bar';
  return (
    <fieldset className={`score-control score-control--${variant}`} disabled={disabled} aria-describedby={describedBy}>
      <legend className={hideLegend ? 'visually-hidden' : bar ? 'score-control__legend score-control__legend--bar' : 'score-control__legend'}>{legend}</legend>
      <div className="score-options">
        {levels.map((l) => {
          const checked = value === l.score;
          const isSuggested = suggested === l.score;
          const descId = `${name}-d${l.score}`;
          return (
            <label
              key={l.score}
              className={`score-option${checked ? ' score-option--checked' : ''}${isSuggested ? ' score-option--suggested' : ''}`}
              title={bar && showKeys ? `Key ${l.score}` : undefined}
            >
              <input
                type="radio"
                name={name}
                value={l.score}
                checked={checked}
                onChange={() => onChange(l.score)}
                aria-describedby={descId}
                aria-keyshortcuts={showKeys ? String(l.score) : undefined}
              />
              <span className="score-option__head">
                <span className="score-option__num" aria-hidden="true">
                  {l.score}
                </span>
                <span className="score-option__label">
                  <span className="visually-hidden">{l.score}: </span>
                  {l.label}
                </span>
                {checked && !bar && <Icon name="check" className="score-option__check" />}
                {isSuggested && <span className="score-option__suggested">Suggested</span>}
                {showKeys && !bar && (
                  <kbd className="kbd score-option__kbd" aria-hidden="true">
                    {l.score}
                  </kbd>
                )}
              </span>
              <span id={descId} className="score-option__desc">
                {bar && (
                  <strong className="score-option__desc-title" aria-hidden="true">
                    {l.score} · {l.label}:{' '}
                  </strong>
                )}
                {l.description}
                {l.overridden && <span className="score-option__override"> (specific to this question)</span>}
              </span>
            </label>
          );
        })}
      </div>
      {onClear && value != null && !disabled && !bar && (
        <Button size="sm" variant="ghost" icon="x" onClick={onClear} className="score-control__clear">
          Clear score
        </Button>
      )}
    </fieldset>
  );
}

/** RUB-1 / RUB-2: every level of the scale for this question, for the "Rubric" disclosure. */
export function RubricList({ question, value, suggested }: { question: Pick<Question, 'rubricOverride'>; value: Score | null; suggested?: Score | null }) {
  return (
    <dl className="rubric-list">
      {rubricFor(question).map((l) => (
        <div key={l.score} className={`rubric-list__row${value === l.score ? ' rubric-list__row--chosen' : ''}`}>
          <dt>
            <span className="rubric-list__num">{l.score}</span> {l.label}
            {value === l.score && <span className="rubric-list__tag">your score</span>}
            {suggested === l.score && <span className="rubric-list__tag rubric-list__tag--suggested">suggested</span>}
          </dt>
          <dd>
            {l.description}
            {l.overridden && <em> (specific to this question)</em>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
