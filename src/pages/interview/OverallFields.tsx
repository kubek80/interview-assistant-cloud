import { useId } from 'react';
import { Field, TextArea } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { RUBRIC_LEVELS } from '../../domain/rubric';
import { RECOMMENDATIONS, RECOMMENDATION_LABELS, type OverallAssessment, type Recommendation, type Score } from '../../domain/types';

export interface OverallErrors {
  rating?: string;
  recommendation?: string;
  rationale?: string;
}

interface ChoiceGroupProps<T extends string | number> {
  legend: string;
  /** Default true. */
  required?: boolean;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (v: T) => void;
  error?: string;
  idPrefix: string;
}

/** A required (by default) choice of one option, as labelled radio buttons. */
export function ChoiceGroup<T extends string | number>({ legend, options, value, onChange, error, idPrefix, required = true }: ChoiceGroupProps<T>) {
  const name = useId();
  const errId = `${idPrefix}-error`;
  return (
    <fieldset className="choice-group" aria-describedby={error ? errId : undefined} aria-invalid={error ? true : undefined} id={idPrefix}>
      <legend className="field__label">
        {legend}
        {required && (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        )}
      </legend>
      <div className="choice-group__options">
        {options.map((o) => (
          <label key={String(o.value)} className={`choice${value === o.value ? ' choice--checked' : ''}`}>
            <input type="radio" name={name} value={String(o.value)} checked={value === o.value} onChange={() => onChange(o.value)} required={required} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {error && (
        <div id={errId} className="field__error">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
    </fieldset>
  );
}

interface OverallFieldsProps {
  value: OverallAssessment;
  onChange: (patch: Partial<OverallAssessment>) => void;
  errors?: OverallErrors;
  idPrefix: string;
}

/** FLOW-22: overall rating (1-4), recommendation (four options) and a written rationale. */
export function OverallFields({ value, onChange, errors = {}, idPrefix }: OverallFieldsProps) {
  return (
    <div className="stack">
      <ChoiceGroup<Score>
        legend="Overall rating"
        idPrefix={`${idPrefix}-rating`}
        options={RUBRIC_LEVELS.map((l) => ({ value: l.score, label: `${l.score} · ${l.label}` }))}
        value={value.rating}
        onChange={(rating) => onChange({ rating })}
        error={errors.rating}
      />
      <ChoiceGroup<Recommendation>
        legend="Recommendation"
        idPrefix={`${idPrefix}-recommendation`}
        options={RECOMMENDATIONS.map((r) => ({ value: r, label: RECOMMENDATION_LABELS[r] }))}
        value={value.recommendation}
        onChange={(recommendation) => onChange({ recommendation })}
        error={errors.recommendation}
      />
      <Field label="Rationale" required hint="Why this recommendation? Refer to the evidence you noted." error={errors.rationale}>
        <TextArea id={`${idPrefix}-rationale`} rows={4} value={value.rationale} onChange={(e) => onChange({ rationale: e.target.value })} />
      </Field>
    </div>
  );
}
