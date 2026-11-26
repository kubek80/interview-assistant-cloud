import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RepoError, confirmConsent, discardInterview, usePlannedInterviews } from '../../db';
import { localDay, whenLabel } from '../../domain/team';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/Dialog';
import { Checkbox } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { CONSENT_TEXT, RECORDING_CONSENT_TEXT, formatCandidateKey, totalTimeMin } from '../../domain/plan';
import type { InterviewPlan, Session } from '../../domain/types';
import { formatNames, interviewersOf } from '../../domain/interviewers';
import { questionMeta } from '../setup/logic';
import '../../styles/pages/prestart.css';

interface PreStartProps {
  session: Session;
  plan: InterviewPlan;
  trackName: string;
  busy: boolean;
  /** Starts the interview (the consent confirmation has been stored). */
  onStart: () => void;
  onOpenCandidateWindow: () => void;
  /** PANEL-1: open the interviewers dialog. */
  onEditInterviewers?: () => void;
}

/**
 * FLOW-10, FLOW-7, PRIV-4, TR-4: the ready screen. One job: with the candidate present, read the
 * consent text (plus the recording sentence when that was chosen), confirm, and start. Start is
 * the single primary action and has focus (A11Y-2); pressed without the confirmation it explains
 * and moves focus to the checkbox. Quiet secondary links: candidate window, preview, interviewers,
 * discard (FLOW-8: until it starts, the interview can be discarded and set up again).
 */
export function PreStart({ session, plan, trackName, busy, onStart, onOpenCandidateWindow, onEditInterviewers }: PreStartProps) {
  const navigate = useNavigate();
  const [told, setTold] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const checkRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  // A11Y-2: the screen may first render a loading heading that takes focus; hand focus to Start
  // once ready, unless the user has already moved it somewhere else.
  useEffect(() => {
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.tagName === 'H1' || a.id === 'main') startRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const planned = usePlannedInterviews()?.find((p) => p.sessionId === session.id);
  const recording = session.candidate.recordingNotice === true;
  const names = interviewersOf(session);
  const key = formatCandidateKey(session.candidate);
  const categories = new Map(plan.categories.map((c) => [c.id, c.name]));

  const start = async () => {
    if (!told) {
      setError('Read the text above to the candidate, then tick the box to confirm.');
      checkRef.current?.focus();
      return;
    }
    setWorking(true);
    try {
      await confirmConsent(session.id, { recordingNotice: recording });
      onStart();
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'The consent could not be saved.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="ready">
      <h1 className="ready__title" tabIndex={-1}>
        Ready to start
      </h1>
      <section className="card ready__card" aria-labelledby="ready-who">
        <div className="ready__head">
          <p className="ready__who" id="ready-who">
            <span className="visually-hidden">Candidate </span>
            <span className="ready__key">{key}</span>
            <span className="ready__role">{trackName}</span>
          </p>
          <p className="ready__facts">
            {plan.questions.length} questions · about {totalTimeMin(plan.questions)} min · with {formatNames(names)}
            {planned?.date && <> · {whenLabel(planned, localDay(new Date()))}</>}
          </p>
          {planned?.note && (
            <p className="ready__note">
              <Icon name="note" /> <span>{planned.note}</span>
              {planned.source === 'invitation' && <span className="muted"> ({planned.organiser})</span>}
            </p>
          )}
        </div>

        <div className={`ready__consent${error ? ' ready__consent--invalid' : ''}`}>
          <h2 className="ready__label">Read this to the candidate</h2>
          <blockquote id="ready-consent-text" className="ready__text consent__text">
            <p>{CONSENT_TEXT}</p>
            {recording && <p className="consent__extra">{RECORDING_CONSENT_TEXT}</p>}
          </blockquote>
          <Checkbox
            ref={checkRef}
            id="ready-consent"
            className="ready__check"
            checked={told}
            onChange={(e) => {
              setTold(e.target.checked);
              if (e.target.checked) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'ready-consent-error' : undefined}
            label={<>I confirm the candidate has been told the text above{recording ? ', including that the interview is recorded or transcribed' : ''}.</>}
          />
          {error && (
            <p id="ready-consent-error" className="field__error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="ready__start">
          <Button ref={startRef} variant="primary" size="lg" icon="play" onClick={start} disabled={busy || working} data-autofocus data-focus-target>
            Start interview
          </Button>
          <span className="small muted">The clock starts now. You can pause at any time.</span>
        </div>
      </section>

      <div className="ready__links">
        <Button size="sm" variant="ghost" icon="window" onClick={onOpenCandidateWindow}>
          Open candidate window
        </Button>
        <Button size="sm" variant="ghost" icon="eye" aria-expanded={preview} aria-controls="ready-preview" onClick={() => setPreview(!preview)}>
          {preview ? 'Hide the questions' : 'Preview the questions'}
        </Button>
        {onEditInterviewers && (
          <Button size="sm" variant="ghost" icon="edit" onClick={onEditInterviewers}>
            {names.length > 1 ? 'Interviewers' : 'Add interviewer'}
          </Button>
        )}
        {planned?.source !== 'invitation' && (
          <Button size="sm" variant="ghost" icon="undo" onClick={() => setDiscardOpen(true)}>
            Discard and set up again
          </Button>
        )}
      </div>

      <ol id="ready-preview" className="ready__list" hidden={!preview} aria-label="Questions in interview order">
        {plan.questions.map((q) => (
          <li key={q.id}>
            <span className="ready__qtext">{q.text}</span>
            <span className="ready__qmeta">{questionMeta(q, categories.get(q.categoryId) ?? '')}</span>
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={discardOpen}
        title="Discard this interview?"
        danger
        confirmLabel="Discard and set up again"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={async () => {
          try {
            const { planId } = await discardInterview(session.id);
            setDiscardOpen(false);
            navigate(`/setup/${planId}`);
          } catch (err) {
            setDiscardOpen(false);
            setError(err instanceof RepoError ? err.message : 'The interview could not be discarded.');
          }
        }}
      >
        <p>The interview with {key} has not started. It is removed and its set-up opens again, with everything you entered, so you can change it.</p>
      </ConfirmDialog>
    </div>
  );
}
