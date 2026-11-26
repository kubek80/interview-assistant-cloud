import '../../styles/pages/team.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, IconButton, TextArea, TextInput } from '../../ui';
import { MAX_INTERVIEWER_NAME } from '../../domain/interviewers';
import { MAX_EXPECTED, MAX_NOTE, scheduleProblems, type ScheduleInput } from '../../domain/team';

export interface ScheduleDialogProps {
  open: boolean;
  title: string;
  submitLabel: string;
  initial: ScheduleInput;
  /** Shown above the fields, e.g. who the interview is with. */
  intro?: string;
  onCancel: () => void;
  /** Throws to show an error in the dialog. */
  onSubmit: (value: ScheduleInput) => Promise<void>;
}

/**
 * TEAM-1, TEAM-2: the optional date, time, interviewers and note of a planned interview. Used by
 * "Save for later" on the New interview screen and "Change" under Upcoming. Interviewers are the
 * whole panel: everyone expected to submit a record, each on their own computer or together.
 */
export function ScheduleDialog({ open, title, submitLabel, initial, intro, onCancel, onSubmit }: ScheduleDialogProps) {
  const [v, setV] = useState<ScheduleInput>(initial);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  useEffect(() => {
    if (open) {
      setV({ ...initial, expected: initial.expected.length ? [...initial.expected] : [''] });
      setAttempted(false);
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focusRow !== null) inputs.current[focusRow]?.focus();
    setFocusRow(null);
  }, [focusRow]);
  const errors = scheduleProblems({ ...v, expected: v.expected.filter((n) => n.trim()) });
  const show = (k: keyof ScheduleInput) => (attempted ? (errors[k] ?? null) : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...v, expected: v.expected.map((n) => n.trim()).filter(Boolean), note: v.note.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" form="schedule-form" disabled={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="schedule-form" className="stack schedule" onSubmit={submit} noValidate>
        {intro && <p className="schedule__intro">{intro}</p>}
        <div className="schedule__when">
          <Field label="Date" error={show('date')}>
            <TextInput type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} data-autofocus />
          </Field>
          <Field label="Time" error={show('time')}>
            <TextInput type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} />
          </Field>
        </div>
        <fieldset className="schedule__names">
          <legend className="field__label">Interviewers</legend>
          <p className="field__hint" id="schedule-names-hint">
            Everyone who will score this interview. Each imports the invitation on their own computer.
          </p>
          <ul role="list" className="schedule__list">
            {v.expected.map((name, i) => (
              <li key={i} className="schedule__row">
                <TextInput
                  ref={(el) => {
                    inputs.current[i] = el;
                  }}
                  aria-label={`Interviewer ${i + 1}`}
                  aria-describedby="schedule-names-hint"
                  value={name}
                  maxLength={MAX_INTERVIEWER_NAME}
                  autoComplete="off"
                  onChange={(e) => setV({ ...v, expected: v.expected.map((n, j) => (j === i ? e.target.value : n)) })}
                />
                <IconButton
                  icon="trash"
                  label={`Remove interviewer ${i + 1}${name.trim() ? ` (${name.trim()})` : ''}`}
                  onClick={() => {
                    setV({ ...v, expected: v.expected.filter((_, j) => j !== i) });
                    setFocusRow(Math.max(0, i - 1));
                  }}
                />
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={v.expected.length >= MAX_EXPECTED}
            onClick={() => {
              setV({ ...v, expected: [...v.expected, ''] });
              setFocusRow(v.expected.length);
            }}
          >
            Add interviewer
          </Button>
          {show('expected') && <p className="field__error">{show('expected')}</p>}
        </fieldset>
        <Field label="Note for the interviewers" error={show('note')}>
          <TextArea rows={2} value={v.note} maxLength={MAX_NOTE} onChange={(e) => setV({ ...v, note: e.target.value })} />
        </Field>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
