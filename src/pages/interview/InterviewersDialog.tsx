import { useState, type FormEvent } from 'react';
import { addInterviewer, removeInterviewer } from '../../db';
import { Alert, Button, Dialog, DocLink, Field, TextInput, useToast } from '../../ui';
import { MAX_INTERVIEWERS, MAX_INTERVIEWER_NAME, interviewerNameProblems, interviewersOf } from '../../domain/interviewers';
import type { Session } from '../../domain/types';
import { errorMessage } from './FinishDialog';

/**
 * PANEL-1: add or remove interviewers on the shared record until it is submitted. Each change is
 * saved at once and recorded in the audit log (by the repository).
 */
export function InterviewersDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: Session }) {
  const names = interviewersOf(session);
  const { announce } = useToast();
  const [name, setName] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = interviewerNameProblems([...names, name]).at(-1) ?? null;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    setError(null);
    if (problem) {
      document.getElementById('add-interviewer-name')?.focus();
      return;
    }
    try {
      await addInterviewer(session.id, name);
      announce(`${name.trim()} added as an interviewer.`);
      setName('');
      setAttempted(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (n: string) => {
    setError(null);
    try {
      await removeInterviewer(session.id, n);
      announce(`${n} removed from the interviewers.`);
      document.getElementById('add-interviewer-name')?.focus();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Interviewers"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="stack">
        <p className="small">
          Everyone named here runs this interview together and shares this one scorecard. Changes are saved now and recorded in the audit log.{' '}
          <DocLink req="PANEL-1" />
        </p>
        <ul className="interviewers-dialog__list" aria-label="Interviewers on this interview">
          {names.map((n, i) => (
            <li key={n}>
              <span>
                <strong>{n}</strong>
                {i === 0 && <span className="small muted"> · this device’s interviewer</span>}
              </span>
              <Button size="sm" variant="ghost" icon="trash" disabled={names.length === 1} onClick={() => void remove(n)}>
                Remove<span className="visually-hidden"> {n}</span>
              </Button>
            </li>
          ))}
        </ul>
        <form className="interviewers-dialog__add" onSubmit={add} noValidate>
          <Field label="Add an interviewer" error={attempted ? problem : null}>
            <TextInput id="add-interviewer-name" value={name} maxLength={MAX_INTERVIEWER_NAME} autoComplete="off" onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Button type="submit" icon="plus" disabled={names.length >= MAX_INTERVIEWERS}>
            Add interviewer
          </Button>
        </form>
        {error && <Alert tone="danger" title={error} role="alert" />}
      </div>
    </Dialog>
  );
}
