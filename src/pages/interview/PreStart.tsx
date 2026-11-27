import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RepoError, cancelInterview, useInterview, useMe } from '../../db';
import { localDay, whenLabel } from '../../domain/team';
import { CONSENT_TEXT, RECORDING_CONSENT_TEXT, totalTimeMin } from '../../domain/plan';
import { Button, ConfirmDialog, EmptyState, Icon, PageHeader, useDocumentTitle, useToast } from '../../ui';
import { Checkbox } from '../../ui/Field';
import { questionMeta } from '../setup/logic';
import { candidateLabel } from '../dashboard/logic';
import { ChangeDialog, panelText } from '../round/InterviewList';
import '../../styles/pages/prestart.css';
import '../../styles/pages/dashboard.css';
import '../../styles/pages/team.css';

/**
 * Route: /interviews/:id (FLOW-10, FLOW-7, PRIV-4, TR-4, LIVE-6 display). The ready screen: who is
 * being interviewed, for which role and round, the panel, the consent text to read (plus the recording
 * sentence when that was chosen), the confirmation, and one "Start interview" button with focus
 * (A11Y-2). Organisers of the round can still change or cancel it here.
 *
 * STEP 2b SEAM: starting is not built yet. "Start interview" checks the confirmation box and then
 * only navigates to /interviews/:id/live (a "Coming in the next step" page); nothing is recorded.
 * Step 2b adds `startInterview(id)` to src/db/rounds.ts (POST /api/interviews/:id/start: consent
 * stored once for the interview with who confirmed it, LIVE-6; state in_progress; timers) and calls
 * it in `start` below before navigating.
 */
export default function ReadyScreen() {
  const { id } = useParams();
  const interview = useInterview(id);
  const me = useMe();
  useDocumentTitle('Ready to start');
  const navigate = useNavigate();
  const { toast } = useToast();
  const [told, setTold] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [changing, setChanging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const checkRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const loaded = !!interview;
  // A11Y-2: the screen exists to confirm one step: focus goes to its primary action once it is shown.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.tagName === 'H1' || a.id === 'main') startRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [loaded]);

  if (interview === undefined) return <PageHeader title="Ready to start" />;
  if (interview === null) {
    return (
      <>
        <PageHeader title="Interview not found" />
        <EmptyState title="This interview does not exist, was cancelled, or is in a round you are not on.">
          <p>
            <Link to="/">Go to the Dashboard</Link>
          </p>
        </EmptyState>
      </>
    );
  }
  const recording = interview.recordingNotice;
  const key = candidateLabel(interview);
  const categories = new Map(interview.set.categories.map((c) => [c.id, c.name]));
  const planned = interview.state === 'planned';

  const start = () => {
    if (!told) {
      setError('Read the text above to the candidate, then tick the box to confirm.');
      checkRef.current?.focus();
      return;
    }
    // Step 2b: `await startInterview(interview.id)` goes here (it records the consent, LIVE-6).
    navigate(`/interviews/${interview.id}/live`);
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
            <span className="ready__role">{interview.trackName}</span>
          </p>
          <p className="ready__facts">
            {interview.set.questions.length} questions · about {totalTimeMin(interview.set.questions)} min · {panelText(interview, me?.id)}
            {interview.date && <> · {whenLabel(interview, localDay(new Date()))}</>} ·{' '}
            <Link to={`/rounds/${interview.roundId}`}>{interview.roundName}</Link>
          </p>
          {!interview.questionSet.isRoundDefault && (
            <p className="ready__note">
              <Icon name="info" /> <span>Different questions from the round’s current set, so this candidate is not directly comparable with those on other sets.</span>
            </p>
          )}
          {interview.note && (
            <p className="ready__note">
              <Icon name="note" /> <span>{interview.note}</span>
            </p>
          )}
        </div>

        {planned ? (
          <>
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
              <Button ref={startRef} variant="primary" size="lg" icon="play" onClick={start} data-autofocus data-focus-target>
                Start interview
              </Button>
              <span className="small muted">The clock starts now. You can pause at any time.</span>
            </div>
          </>
        ) : (
          <div className="ready__start">
            <p>This interview has started.</p>
            <Button ref={startRef} variant="primary" size="lg" icon="play" onClick={() => navigate(`/interviews/${interview.id}/live`)} data-focus-target>
              Go to the interview
            </Button>
          </div>
        )}
      </section>

      <div className="ready__links">
        <Button size="sm" variant="ghost" icon="eye" aria-expanded={preview} aria-controls="ready-preview" onClick={() => setPreview(!preview)}>
          {preview ? 'Hide the questions' : 'Preview the questions'}
        </Button>
        {interview.canPlan && (
          <>
            <Button size="sm" variant="ghost" icon="edit" onClick={() => setChanging(true)}>
              Change date, interviewers or note
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setCancelling(true)}>
              Cancel interview
            </Button>
          </>
        )}
      </div>

      <ol id="ready-preview" className="ready__list" hidden={!preview} aria-label="Questions in interview order">
        {interview.set.questions.map((q) => (
          <li key={q.id}>
            <span className="ready__qtext">{q.text}</span>
            <span className="ready__qmeta">{questionMeta(q, categories.get(q.categoryId) ?? '')}</span>
          </li>
        ))}
      </ol>

      <ChangeDialog interview={changing ? interview : null} onClose={() => setChanging(false)} onSaved={() => toast('Saved.', 'success')} />
      <ConfirmDialog
        open={cancelling}
        title="Cancel this interview?"
        danger
        confirmLabel="Cancel interview"
        cancelLabel="Keep it"
        onCancel={() => setCancelling(false)}
        onConfirm={async () => {
          try {
            await cancelInterview(interview.id);
            setCancelling(false);
            toast(`The interview with ${key} is cancelled.`, 'success');
            navigate(`/rounds/${interview.roundId}`);
          } catch (err) {
            setCancelling(false);
            setError(err instanceof RepoError ? err.message : 'The interview could not be cancelled.');
          }
        }}
      >
        <p>The interview with {key} is removed from the round’s list for everyone.</p>
      </ConfirmDialog>
    </div>
  );
}
