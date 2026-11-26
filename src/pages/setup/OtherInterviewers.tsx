import { useEffect, useRef, useState } from 'react';
import { Button, Field, IconButton, TextInput } from '../../ui';
import { MAX_INTERVIEWERS, MAX_INTERVIEWER_NAME, interviewerNameProblems } from '../../domain/interviewers';

export interface OtherInterviewersProps {
  /** Id prefix; the first row with a problem gets `${idPrefix}-otherInterviewers` so it can be focused. */
  idPrefix: string;
  /** The first interviewer (this device's), for the "names must differ" check. */
  first: string;
  value: string[];
  onChange: (names: string[]) => void;
  /** Show each row's problem (after a submit attempt). */
  showErrors: boolean;
  /** Text of the add button's hint, shown only while no extra interviewer is named. */
  hint?: string;
}

/**
 * PANEL-1: more interviewers running the interview together at this machine. Nothing to fill in
 * by default; "Add interviewer" adds a name field, each removable. Used by the New interview screen.
 */
export function OtherInterviewers({ idPrefix, first, value, onChange, showErrors, hint }: OtherInterviewersProps) {
  const problems = interviewerNameProblems([first || ' ', ...value]).slice(1);
  // The first row with a problem carries the focusable id even before errors are shown, so a submit
  // attempt can move focus to it in the same event.
  const firstBad = problems.findIndex(Boolean);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const addRef = useRef<HTMLButtonElement>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);

  useEffect(() => {
    if (focusRow === null) return;
    if (focusRow < 0) addRef.current?.focus();
    else inputs.current[focusRow]?.focus();
    setFocusRow(null);
  }, [focusRow, value.length]);

  const rowId = (i: number) => (i === firstBad ? `${idPrefix}-otherInterviewers` : `${idPrefix}-interviewer-${i + 2}`);
  return (
    <div className="interviewers">
      {value.length > 0 && (
        <ul className="interviewers__list" role="list" aria-label="More interviewers">
          {value.map((name, i) => (
            <li key={i} className="interviewers__row">
              <Field label={`Interviewer ${i + 2}`} error={showErrors ? problems[i] : null} className="grow">
                <TextInput
                  id={rowId(i)}
                  ref={(el) => {
                    inputs.current[i] = el;
                  }}
                  value={name}
                  maxLength={MAX_INTERVIEWER_NAME}
                  autoComplete="off"
                  onChange={(e) => onChange(value.map((v, j) => (j === i ? e.target.value : v)))}
                />
              </Field>
              <IconButton
                icon="trash"
                label={`Remove interviewer ${i + 2}${name.trim() ? ` (${name.trim()})` : ''}`}
                className="interviewers__remove"
                onClick={() => {
                  onChange(value.filter((_, j) => j !== i));
                  setFocusRow(value.length > 1 ? Math.max(0, i - 1) : -1);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="interviewers__add">
        <Button
          ref={addRef}
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={value.length + 1 >= MAX_INTERVIEWERS}
          onClick={() => {
            onChange([...value, '']);
            setFocusRow(value.length);
          }}
        >
          Add interviewer
        </Button>
        <span className="small muted">{value.length ? 'Everyone named shares one scorecard.' : (hint ?? 'Interviewing together at this machine? You share one scorecard.')}</span>
      </div>
    </div>
  );
}
