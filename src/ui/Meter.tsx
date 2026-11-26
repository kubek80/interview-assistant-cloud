import type { ReactNode } from 'react';

export interface MeterProps {
  label: ReactNode;
  value: number;
  max: number;
  /** Visible value text, e.g. "52 / 60 min". Also used as aria-valuetext. */
  valueText: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  /** Extra visible status text (A11Y-3: never rely on the bar colour alone), e.g. "Over budget". */
  status?: ReactNode;
}

/** Horizontal meter for time budgets (FLOW-4), coverage, percentages. */
export function Meter({ label, value, max, valueText, tone = 'default', status }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`meter${tone !== 'default' ? ` meter--${tone}` : ''}`}>
      <div className="meter__head">
        <span className="meter__label">{label}</span>
        <span className="meter__value">
          {valueText}
          {status && <> · {status}</>}
        </span>
      </div>
      <div className="meter__track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={valueText} aria-label={typeof label === 'string' ? label : undefined}>
        <div className="meter__bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
