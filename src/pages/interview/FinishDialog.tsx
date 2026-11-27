import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Card';
import { Field, TextArea } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { useToast } from '../../ui/Toast';
import { DocLink } from '../../docs/DocLink';
import { RepoError, changeRecord, submitRecord } from '../../db';
import { canFinish } from '../../domain/validation';
import type { Answer, InterviewPlan, OverallAssessment, Session } from '../../domain/types';
import { OverallFields, type OverallErrors } from './OverallFields';
import { formatNames, interviewersOf } from '../../domain/interviewers';
import { finishSummary, unresolvedSentence } from './logic';

interface FinishDialogProps {
  open: boolean;
  /** The signed-in person (the record's owner); their changes go through their outbox (HOST-6). */
  userId: string;
  onClose: () => void;
  session: Session;
  plan: InterviewPlan;
  answers: Answer[];
  /** Close the dialog and show a question that blocks finishing. */
  onJump: (questionId: string) => void;
  onSubmitted: () => void;
}

/**
 * FLOW-22, FLOW-23, FLOW-16, UX-6: what is left, summarised (never one row per question):
 * unanswered questions in one line with "go to the first one" and "skip the remaining N with one
 * reason"; a 1 or 4 without a note as compact jump links. Then the overall rating, recommendation and
 * rationale (autosaved, RES-1), on behalf of every interviewer (PANEL-4), and Submit.
 */
export function FinishDialog({ open, userId, onClose, session, plan, answers, onJump, onSubmitted }: FinishDialogProps) {
  const { announce } = useToast();
  const [overall, setLocal] = useState<OverallAssessment>(session.overall);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [lastSkip, setLastSkip] = useState<{ ids: string[]; reason: string } | null>(null);
  const pending = useRef<Partial<OverallAssessment> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setLocal(session.overall);
      setShowErrors(false);
      setError(null);
      setSkipping(false);
      setReason('');
      setReasonError(null);
      setLastSkip(null);
    }
    // Only when opening: afterwards the local copy leads and is saved as it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = null;
    if (patch) changeRecord(userId, session.id, [{ t: 'overall', ...patch }]);
  };

  // Save on unmount/close too.
  useEffect(() => () => void flush().catch(() => {}), []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<OverallAssessment>) => {
    setLocal((o) => ({ ...o, ...patch }));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    // Choices save at once; typing is batched.
    timer.current = setTimeout(() => void flush().catch((e) => setError({ message: errorMessage(e), details: [] })), patch.rationale !== undefined ? 400 : 0);
  };

  const problems = useMemo(() => canFinish(plan, answers, overall), [plan, answers, overall]);
  const summary = useMemo(() => finishSummary(plan, answers), [plan, answers]);
  const names = interviewersOf(session);
  const unresolved = summary.unresolved;
  const errors: OverallErrors = showErrors
    ? {
        rating: problems.find((p) => p.code === 'overall-rating')?.message,
        recommendation: problems.find((p) => p.code === 'recommendation')?.message,
        rationale: problems.find((p) => p.code === 'rationale')?.message,
      }
    : {};

  const close = () => {
    void flush().catch(() => {});
    onClose();
  };

  const skipRest = async () => {
    if (!reason.trim()) {
      setReasonError('A reason is required.');
      document.getElementById('finish-skip-reason')?.focus();
      return;
    }
    try {
      const ids = summary.unresolved.map((u) => u.questionId);
      changeRecord(
        userId,
        session.id,
        ids.map((q) => ({ t: 'skip' as const, q, reason: reason.trim() })),
      );
      setLastSkip({ ids, reason: reason.trim() });
      setSkipping(false);
      setReason('');
      setReasonError(null);
      announce(`${ids.length} question${ids.length === 1 ? '' : 's'} skipped.`);
      setTimeout(() => document.getElementById('finish-problems')?.focus(), 0);
    } catch (e) {
      setReasonError(errorMessage(e));
    }
  };

  const undoSkip = async () => {
    if (!lastSkip) return;
    try {
      changeRecord(
        userId,
        session.id,
        lastSkip.ids.map((q) => ({ t: 'unskip' as const, q })),
      );
      announce('The skips were undone.');
      setLastSkip(null);
      setTimeout(() => document.getElementById('finish-problems')?.focus(), 0);
    } catch (e) {
      setError({ message: errorMessage(e), details: [] });
    }
  };

  const submit = async () => {
    setShowErrors(true);
    setError(null);
    if (problems.length) {
      const first = problems.find((p) => !p.questionId);
      if (summary.questionCount || !first) {
        document.getElementById('finish-problems')?.focus();
      } else {
        const id = first.code === 'overall-rating' ? 'finish-rating' : first.code === 'recommendation' ? 'finish-recommendation' : 'finish-rationale';
        const el = document.getElementById(id);
        (el?.matches('textarea') ? el : el?.querySelector<HTMLElement>('input'))?.focus();
      }
      return;
    }
    setBusy(true);
    try {
      await flush();
      changeRecord(userId, session.id, [{ t: 'overall', rating: overall.rating, recommendation: overall.recommendation, rationale: overall.rationale }]);
      await submitRecord(userId, session.id);
      onSubmitted();
    } catch (e) {
      setError({ message: errorMessage(e), details: e instanceof RepoError ? e.details : [] });
    } finally {
      setBusy(false);
    }
  };

  const n = unresolved.length;
  const first = unresolved[0];

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title="Finish and submit the interview"
      footer={
        <>
          <p className="finish__lock">
            <Icon name="info" /> After you submit, a change needs a reason and is recorded. <DocLink req="FLOW-23" />
          </p>
          <Button onClick={close}>Keep interviewing</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            Submit interview
          </Button>
        </>
      }
    >
      <div className="stack-lg finish">
        <section aria-labelledby="finish-problems" className={`finish__questions${summary.questionCount ? ' finish__questions--open' : ''}`}>
          <h3 id="finish-problems" tabIndex={-1} className="finish__heading">
            {summary.questionCount ? (
              <>
                <Icon name="alert" /> {summary.questionCount} question{summary.questionCount === 1 ? '' : 's'} to resolve first
              </>
            ) : (
              <>
                <Icon name="check" /> Every question is scored or skipped
              </>
            )}
          </h3>

          {n > 0 && (
            <div className="finish__row">
              <p className="finish__line">
                <Icon name="circle" />
                <span>{unresolvedSentence(unresolved)}</span>
              </p>
              {!skipping && (
                <div className="cluster">
                  <Button size="sm" onClick={() => onJump(first.questionId)}>
                    {n === 1 ? `Go to question ${first.position}` : `Go to the first one (question ${first.position})`}
                  </Button>
                  <Button
                    size="sm"
                    icon="skip"
                    onClick={() => {
                      setSkipping(true);
                      setTimeout(() => document.getElementById('finish-skip-reason')?.focus(), 0);
                    }}
                  >
                    {n === 1 ? `Skip question ${first.position}…` : `Skip the remaining ${n}…`}
                  </Button>
                </div>
              )}
              {skipping && (
                <form
                  className="finish__skip"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void skipRest();
                  }}
                >
                  <Field
                    label={n === 1 ? 'Reason for skipping it' : `One reason for skipping all ${n}`}
                    hint="Shown with each skipped question on the scorecard. You can still undo a skip on its question."
                    error={reasonError}
                    required
                  >
                    <TextArea id="finish-skip-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <div className="cluster">
                    <Button type="submit" size="sm" variant="default" icon="skip">
                      {n === 1 ? 'Skip question' : `Skip ${n} questions`}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSkipping(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}

          {summary.needsNote.length > 0 && (
            <div className="finish__row">
              <p className="finish__line">
                <Icon name="note" />
                <span>
                  A score of 1 or 4 needs a note of what the candidate said:
                </span>
              </p>
              <ul className="finish__jumps">
                {summary.needsNote.map((q) => (
                  <li key={q.questionId}>
                    <Button size="sm" onClick={() => onJump(q.questionId)}>
                      Question {q.position} <span className="finish__jump-score">scored {q.score}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastSkip && (
            <p className="finish__done" role="status">
              <Icon name="check" />
              <span>
                Skipped {lastSkip.ids.length} question{lastSkip.ids.length === 1 ? '' : 's'}: “{lastSkip.reason}”.
              </span>
              <Button size="sm" variant="ghost" icon="undo" onClick={() => void undoSkip()}>
                Undo
              </Button>
            </p>
          )}
        </section>

        <section aria-labelledby="finish-overall" className="stack">
          <div>
            <h3 id="finish-overall" className="finish__heading">
              {names.length > 1 ? 'Your shared overall assessment' : 'Your overall assessment'}
            </h3>
            {names.length > 1 ? (
              <p className="finish__names">
                Interviewers: <strong>{formatNames(names)}</strong>. The rating, recommendation and rationale are recorded on behalf of all of them.{' '}
                <DocLink req="PANEL-4" />
              </p>
            ) : (
              <p className="finish__names">
                Recorded by <strong>{names[0]}</strong>. The band on the scorecard is only advisory. <DocLink req="OV-4" />
              </p>
            )}
          </div>
          <OverallFields value={overall} onChange={change} errors={errors} idPrefix="finish" />
        </section>

        {error && (
          <Alert tone="danger" title={error.message} role="alert">
            {error.details.length > 0 && (
              <ul>
                {error.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Your changes are kept and sent when the server can be reached.';
}
