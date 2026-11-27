import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RepoError, cancelInterview, joinInterview, markDidNotTakePart, serverNow, startInterview, useInterview, useLiveRecords, useLiveState, useMe } from '../../db';
import { localDay, whenLabel } from '../../domain/team';
import { CONSENT_TEXT, RECORDING_CONSENT_TEXT, totalTimeMin } from '../../domain/plan';
import { isPresent } from '../../domain/live';
import { Badge, Button, ConfirmDialog, EmptyState, Icon, PageHeader, buttonClass, formatDateTime, useDocumentTitle, useToast, type Tone } from '../../ui';
import { Checkbox } from '../../ui/Field';
import { questionMeta } from '../setup/logic';
import { candidateLabel } from '../dashboard/logic';
import { ChangeDialog, panelText } from '../round/InterviewList';
import { waitingLine } from './liveModel';
import type { InterviewDetail, LiveRecords, LiveState } from '../../shared/api';
import '../../styles/pages/prestart.css';
import '../../styles/pages/dashboard.css';
import '../../styles/pages/team.css';

/**
 * Route: /interviews/:id. The interview's page.
 *
 * Before it starts (FLOW-10, FLOW-7, PRIV-4, TR-4, LIVE-6): who is being interviewed, the consent text
 * to read (plus the recording sentence when that was chosen), the confirmation, and one "Start
 * interview" button with focus (A11Y-2). Starting records the consent once for the interview and
 * starts the shared timers. Someone sharing this screen can be named ("Scoring with", LIVE-5).
 *
 * Once it has started (LIVE-4, LIVE-8): that it is running, who confirmed consent and when, and the
 * panel: who has joined, who has submitted, who the interview is waiting for. Panel members join
 * (or go back to it) from here; organisers can mark someone who never joined as "did not take part".
 * Each submitted scorecard is reachable from here, as the round lets the reader see it (LIVE-3).
 */
export default function ReadyScreen() {
  const { id } = useParams();
  const interview = useInterview(id);
  const live = useLiveState(id);
  const records = useLiveRecords(live && live.state !== 'planned' ? id : undefined);
  const me = useMe();
  useDocumentTitle(live && live.state !== 'planned' ? 'Interview' : 'Ready to start');
  const loaded = !!interview && !!live;
  // A11Y-2: the screen exists to confirm one step: focus goes to its primary action once it is shown.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.tagName === 'H1' || a.id === 'main') document.querySelector<HTMLElement>('main [data-focus-target]')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [loaded]);

  if (interview === undefined || live === undefined) return <PageHeader title="Ready to start" />;
  if (interview === null || live === null) {
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
  if (live.state === 'planned') return <Planned interview={interview} live={live} meId={me?.id} />;
  return <Started interview={interview} live={live} records={records} meId={me?.id ?? ''} />;
}

/** LIVE-5: other panel members who may share my screen (on the panel, not joined on their own). */
function ScoringWith({ live, meId, value, onChange }: { live: LiveState; meId: string | undefined; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const options = live.panel.filter((p) => p.id !== meId && p.status === 'expected');
  if (!options.length) return null;
  return (
    <div className="ready__with">
      <button type="button" className="link-button" aria-expanded={open} aria-controls="ready-with" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /> Someone on the panel is sharing this screen?
      </button>
      <fieldset id="ready-with" className="ready__with-list" hidden={!open}>
        <legend className="visually-hidden">Scoring with</legend>
        <p className="small muted">They score with you on one record that carries both names, instead of their own.</p>
        {options.map((p) => (
          <Checkbox key={p.id} label={p.name} checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
        ))}
      </fieldset>
    </div>
  );
}

function Planned({ interview, live, meId }: { interview: InterviewDetail; live: LiveState; meId: string | undefined }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [told, setTold] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [changing, setChanging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withIds, setWithIds] = useState<string[]>([]);
  const checkRef = useRef<HTMLInputElement>(null);
  const recording = interview.recordingNotice;
  const key = candidateLabel(interview);
  const categories = new Map(interview.set.categories.map((c) => [c.id, c.name]));

  const start = async () => {
    if (!told) {
      setError('Read the text above to the candidate, then tick the box to confirm.');
      checkRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      // LIVE-6: consent is recorded once for the interview; if someone started it a moment ago, join it.
      const r = await startInterview(interview.id, withIds);
      if (r.alreadyStarted && live.me.onPanel) {
        await joinInterview(interview.id, withIds);
        toast('Someone on the panel had just started it. You have joined.', 'info');
      }
      navigate(live.me.onPanel ? `/interviews/${interview.id}/live` : `/interviews/${interview.id}`);
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'The interview could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ready">
      <h1 className="ready__title" tabIndex={-1}>
        Ready to start
      </h1>
      <section className="card ready__card" aria-labelledby="ready-who">
        <Head interview={interview} meId={meId} />
        {live.me.canStart ? (
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
              {live.me.onPanel && <ScoringWith live={live} meId={meId} value={withIds} onChange={setWithIds} />}
            </div>
            <div className="ready__start">
              <Button variant="primary" size="lg" icon="play" onClick={() => void start()} disabled={busy} data-autofocus data-focus-target>
                Start interview
              </Button>
              <span className="small muted">{live.panel.length > 1 ? 'The clock starts now for the whole panel. You lead; anyone can take over.' : 'The clock starts now. You can pause at any time.'}</span>
            </div>
          </>
        ) : (
          <div className="ready__start">
            <p className="grow">{live.me.status === 'did_not_take_part' ? 'You were marked as not taking part in this interview.' : 'The panel starts this interview; this page then shows how it is going.'}</p>
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

function Head({ interview, meId }: { interview: InterviewDetail; meId: string | undefined }) {
  return (
    <div className="ready__head">
      <p className="ready__who" id="ready-who">
        <span className="visually-hidden">Candidate </span>
        <span className="ready__key">{candidateLabel(interview)}</span>
        <span className="ready__role">{interview.trackName}</span>
      </p>
      <p className="ready__facts">
        {interview.set.questions.length} questions · about {totalTimeMin(interview.set.questions)} min · {panelText(interview, meId)}
        {interview.date && <> · {whenLabel(interview, localDay(new Date()))}</>} · <Link to={`/rounds/${interview.roundId}`}>{interview.roundName}</Link>
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
  );
}

const STATUS: Record<LiveState['panel'][number]['status'], { text: string; tone: Tone }> = {
  expected: { text: 'Not joined', tone: 'neutral' },
  joined: { text: 'Interviewing', tone: 'info' },
  submitted: { text: 'Submitted', tone: 'success' },
  did_not_take_part: { text: 'Did not take part', tone: 'neutral' },
};

function Started({ interview, live, records, meId }: { interview: InterviewDetail; live: LiveState; records: LiveRecords | null | undefined; meId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [withIds, setWithIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = live.state === 'completed';
  const mineId = records?.mine?.id ?? null;
  const host = live.me.onRecordOf ? live.panel.find((p) => p.id === live.me.onRecordOf) : null;
  const waiting = waitingLine(live.panel);
  const now = serverNow();

  const join = async () => {
    setBusy(true);
    try {
      await joinInterview(interview.id, withIds);
      navigate(`/interviews/${interview.id}/live`);
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'You could not join the interview.');
    } finally {
      setBusy(false);
    }
  };
  /** LIVE-3: a scorecard link only where the reader may open it. */
  const cardOf = (userId: string): string | null => {
    const p = live.panel.find((x) => x.id === userId);
    if (!p?.recordId || p.recordState !== 'submitted') return null;
    if (p.recordId === mineId) return p.recordId;
    return records && !records.hidden ? p.recordId : null;
  };

  let action = null;
  if (live.me.onPanel && !done && host) action = <p className="grow">You are scoring with {host.name} on their screen: the interview is on their record.</p>;
  else if (live.me.onPanel && !done && live.me.status === 'expected')
    action = (
      <>
        <Button variant="primary" size="lg" icon="play" onClick={() => void join()} disabled={busy} data-focus-target>
          Join the interview
        </Button>
        <span className="small muted">You score your own record and follow the panel’s question.</span>
      </>
    );
  else if (live.me.onPanel && !done && live.me.status === 'joined')
    action = (
      <Link to={`/interviews/${interview.id}/live`} className={buttonClass('primary', 'lg')} data-focus-target>
        <Icon name="play" /> Go back to the interview
      </Link>
    );
  else if (mineId && records?.mine?.state === 'submitted')
    action = (
      <Link to={`/scorecard/${mineId}`} className={buttonClass('primary', 'lg')} data-focus-target>
        View your scorecard
      </Link>
    );

  return (
    <div className="ready">
      <h1 className="ready__title" tabIndex={-1}>
        {done ? 'Interview finished' : live.state === 'paused' ? 'Interview paused' : 'Interview in progress'}
      </h1>
      <section className="card ready__card" aria-labelledby="ready-who">
        <Head interview={interview} meId={meId} />
        <div className="ready__status">
          {live.consent && (
            <p className="small ready__consented">
              <Icon name="check" /> Consent confirmed by {live.consent.byName}, {formatDateTime(live.consent.at)}
              {live.consent.recordingNotice ? ', including that it is recorded or transcribed' : ''}.
            </p>
          )}
          <h2 className="ready__label">Panel</h2>
          <ul className="panel-status" role="list" data-testid="panel-status">
            {live.panel.map((p) => {
              const s = STATUS[p.status];
              const onScreenOf = p.onRecordOf ? live.panel.find((x) => x.id === p.onRecordOf)?.name : null;
              const card = cardOf(p.id);
              const here = !done && p.status === 'joined' && isPresent(p.seenAt, now);
              return (
                <li key={p.id} className="panel-status__row" data-testid="panel-member">
                  <span className="panel-status__name">
                    {p.name}
                    {p.id === meId && <span className="muted"> (you)</span>}
                    {live.leadUserId === p.id && !done && <span className="muted"> · leads</span>}
                  </span>
                  <Badge tone={s.tone} icon={p.status === 'submitted' ? 'check' : p.status === 'joined' ? 'clock' : undefined}>
                    {onScreenOf && p.status !== 'submitted' ? `On ${onScreenOf}’s screen` : done && p.status === 'expected' ? 'Did not join' : s.text}
                  </Badge>
                  {here && <span className="small muted">here now</span>}
                  {card && (
                    <Link to={`/scorecard/${card}`} className="small">
                      Scorecard<span className="visually-hidden"> of {p.name}</span>
                    </Link>
                  )}
                  {live.me.canMark && (p.status === 'expected' || p.status === 'did_not_take_part') && !p.onRecordOf && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void markDidNotTakePart(interview.id, p.id, p.status === 'expected').then(
                          () => toast(p.status === 'expected' ? `${p.name} is marked as not taking part.` : `${p.name} is expected again.`, 'success'),
                          (err) => toast(err instanceof RepoError ? err.message : 'That could not be changed.', 'error'),
                        )
                      }
                    >
                      {p.status === 'expected' ? 'Mark as did not take part' : 'Undo “did not take part”'}
                      <span className="visually-hidden"> ({p.name})</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {!done && waiting && (
            <p className="small muted" data-testid="waiting">
              {waiting}.
            </p>
          )}
          {records?.hidden && !done && <p className="small muted">This round hides other people’s scores until you have submitted yours.</p>}
          {live.me.onPanel && live.me.status === 'expected' && !done && !host && <ScoringWith live={live} meId={meId} value={withIds} onChange={setWithIds} />}
          {error && (
            <p className="field__error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}
        </div>
        {(action || done) && (
          <div className="ready__start">
            {action}
            {done && (
              <Link to={`/debrief/${interview.id}`} className={buttonClass(action ? 'default' : 'primary')}>
                Debrief <Icon name="arrow-right" />
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
