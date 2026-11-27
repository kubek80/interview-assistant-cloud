import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RepoError, planInterview, useMe, useRound, useRoundInterviews, useRoundQuestionSet } from '../db';
import { candidateKey, cleanCandidate, isValidCandidate, MAX_CANDIDATE, shortFingerprint } from '../domain/plan';
import { MAX_PLAN_NOTE, MAX_REQUISITION } from '../domain/rounds';
import { localDay } from '../domain/team';
import { Alert, Button, Checkbox, EmptyState, Field, Icon, PageHeader, TextArea, TextInput, formatDate, useDocumentTitle, useToast } from '../ui';
import { PanelPicker } from './round/PanelPicker';
import { QuestionSetPanel, draftOf, type SetDraft } from './round/QuestionSetPanel';
import { useKeepHeadingFocus } from './setup/useKeepHeadingFocus';
import '../styles/pages/setup.css';
import '../styles/pages/rounds.css';

interface Form {
  candidate: string;
  requisitionId: string;
  date: string;
  time: string;
  panel: string[] | null;
  note: string;
  recording: boolean;
  /** "Use different questions for this interview" (ROUND-3): the interview's own set. */
  own: SetDraft | null;
  moreOpen: boolean;
}

const EMPTY: Form = { candidate: '', requisitionId: '', date: '', time: '', panel: null, note: '', recording: false, own: null, moreOpen: false };

/**
 * An unfinished New interview form lives in memory only (HOST-1: the browser keeps no candidate data):
 * it survives moving around the app, and leaving the page asks first. A reload starts afresh.
 */
const drafts = new Map<string, Form>();

/**
 * Route: /rounds/:roundId/new (FLOW-33, UX-1, UX-2, ROUND-3, ROUND-4, TEAM-1, PANEL-1). One screen:
 * the candidate (name or initials) is the one required input; the date and time, and the panel (me
 * by default, one click per team member) are beside it. The round's questions are already there; using
 * different questions for this interview is a secondary path. Everything else is under "More options".
 * One primary action: "Continue" (to the ready screen now) or, when the interview is on a later day,
 * "Save" (planned for later); the other is offered beside it.
 */
export default function NewInterview() {
  useDocumentTitle('New interview');
  useKeepHeadingFocus();
  const { roundId = '' } = useParams();
  const me = useMe();
  const round = useRound(roundId);
  const set = useRoundQuestionSet(roundId);
  const interviews = useRoundInterviews(roundId);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [form, setFormState] = useState<Form>(() => drafts.get(roundId) ?? EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const problemsRef = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const update = (patch: Partial<Form>) =>
    setFormState((f) => {
      const next = { ...f, ...patch };
      drafts.set(roundId, next);
      return next;
    });
  const typed = !!form.candidate.trim();
  useEffect(() => {
    if (!typed) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (done.current) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [typed]);

  const today = localDay(new Date());
  const meOnTeam = !!round && !!me && round.team.some((m) => m.id === me.id);
  const panel = form.panel ?? (meOnTeam && me ? [me.id] : []);
  const name = cleanCandidate(form.candidate);
  const existing = useMemo(() => {
    if (!name || !interviews) return 0;
    const key = candidateKey({ initials: name, requisitionId: form.requisitionId });
    return interviews.filter((i) => candidateKey({ initials: i.candidate.name, requisitionId: i.candidate.requisitionId }) === key).length;
  }, [name, form.requisitionId, interviews]);

  if (round === null) {
    return (
      <>
        <PageHeader title="New interview" />
        <EmptyState title="This round does not exist, or you are not on its team." />
      </>
    );
  }
  if (round && !round.canPlan) {
    return (
      <>
        <PageHeader title="New interview" />
        <EmptyState title={round.state === 'closed' ? 'This round is closed, so no interviews can be planned in it.' : 'Only the round’s organisers plan its interviews.'}>
          <p>
            <Link to={`/rounds/${roundId}`}>Back to the round</Link>
          </p>
        </EmptyState>
      </>
    );
  }

  const later = !!form.date && form.date > today;
  const problems: Array<{ id: string; message: string }> = [];
  if (!name) problems.push({ id: 'ni-candidate', message: 'Enter the candidate’s name or initials.' });
  else if (!isValidCandidate(name)) problems.push({ id: 'ni-candidate', message: 'Use letters, spaces, hyphens, apostrophes and full stops only.' });
  if (form.time && !form.date) problems.push({ id: 'ni-date', message: 'Choose the day as well as the time.' });
  if (!panel.length) problems.push({ id: `ni-panel-${round?.team[0]?.id ?? ''}`, message: 'Choose at least one interviewer.' });
  if (form.own && !form.own.ids.length) problems.push({ id: 'own-set-edit', message: 'Add at least one question.' });
  const show = (id: string) => (attempted ? (problems.find((p) => p.id === id)?.message ?? null) : null);

  const submit = async (mode: 'continue' | 'save') => {
    setAttempted(true);
    setError(null);
    if (problems.length) {
      const el = document.getElementById(problems[0].id);
      el?.scrollIntoView({ block: 'center' });
      el?.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    try {
      const id = await planInterview(roundId, {
        candidate: { name, requisitionId: form.requisitionId.trim() || null },
        date: form.date || null,
        time: form.time || null,
        panel,
        note: form.note.trim(),
        recordingNotice: form.recording,
        ...(form.own ? { questions: { questionIds: form.own.ids, categories: form.own.categories.map((c) => ({ id: c.id, weight: c.weight, mustHave: c.mustHave })), timeBudgetMin: form.own.budget } } : {}),
      });
      done.current = true;
      drafts.delete(roundId);
      if (mode === 'continue') navigate(`/interviews/${id}`);
      else {
        toast(`Planned: ${name}${form.date ? `, ${formatDate(form.date)}${form.time ? ` at ${form.time}` : ''}` : ''}.`, 'success');
        navigate(`/rounds/${roundId}`);
      }
    } catch (err) {
      setBusy(false);
      setError(err instanceof RepoError ? { message: err.message, details: err.details } : { message: 'The interview could not be planned.', details: [] });
      requestAnimationFrame(() => problemsRef.current?.focus());
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(later ? 'save' : 'continue');
  };

  const summary: string[] = [];
  if (form.requisitionId.trim()) summary.push(`Requisition ${form.requisitionId.trim()}`);
  if (form.recording) summary.push('recorded or transcribed');
  if (form.note.trim()) summary.push('note for the interviewers');
  if (!summary.length) summary.push('requisition, note, recording');

  return (
    <>
      <PageHeader title="New interview" subtitle={round ? <Link to={`/rounds/${roundId}`}>{round.name}</Link> : undefined} />
      <form className="ni" onSubmit={onSubmit} noValidate aria-label="New interview">
        <div className="card ni-card">
          <div className="ni-who ni-who--round">
            <Field label="Candidate" hint="Name or initials" required error={show('ni-candidate')} className="ni-initials">
              <TextInput id="ni-candidate" value={form.candidate} onChange={(e) => update({ candidate: e.target.value.slice(0, MAX_CANDIDATE) })} autoComplete="off" spellCheck={false} maxLength={MAX_CANDIDATE} />
            </Field>
            <Field label="Date" hint="Optional" error={show('ni-date')}>
              <TextInput id="ni-date" type="date" value={form.date} onChange={(e) => update({ date: e.target.value })} />
            </Field>
            <Field label="Time" hint="Optional">
              <TextInput id="ni-time" type="time" value={form.time} onChange={(e) => update({ time: e.target.value })} />
            </Field>
          </div>
          {existing > 0 && (
            <p className="ni-note ni-note--inline" role="status">
              <Icon name="info" /> {name} is already in this round: this will be another interview with them.
            </p>
          )}
          <div className="ni-panel">
            {round && me ? (
              <PanelPicker idPrefix="ni" team={round.team} value={panel} onChange={(ids) => update({ panel: ids })} meId={me.id} error={show(`ni-panel-${round.team[0]?.id ?? ''}`)} />
            ) : (
              <p className="muted">Loading the team…</p>
            )}
            {round && round.team.length < 2 && round.canManage && (
              <p className="small muted">
                Others will interview too? <Link to={`/rounds/${roundId}/team`}>Add them to the team</Link>.
              </p>
            )}
          </div>

          {set && round ? (
            form.own ? (
              <div className="ni-own">
                <QuestionSetPanel
                  trackId={set.trackId}
                  value={form.own}
                  snapshot={set.questions}
                  onChange={(own) => update({ own })}
                  title="Questions for this interview only"
                  idPrefix="own-set"
                  startEditing
                  note={
                    <p className="ni-note ni-note--warn">
                      <Icon name="alert" /> Different from the round’s questions, so this candidate cannot be compared directly with the others.{' '}
                      <button type="button" className="pc-linkbtn" onClick={() => update({ own: null })}>
                        Use the round’s questions
                      </button>
                    </p>
                  }
                />
              </div>
            ) : (
              <section className="ni-set" aria-labelledby="ni-set-title">
                <div className="ni-set__row">
                  <div className="ni-set__text">
                    <h2 id="ni-set-title" className="ni-label">
                      Questions
                    </h2>
                    <p className="ni-set__count" data-testid="set-summary">
                      <strong>{set.questions.length} questions</strong> · about {set.questions.reduce((n, q) => n + q.timeMin, 0)} min <span className="muted">of {set.timeBudgetMin}</span>
                    </p>
                    <p className="ni-set__mix">
                      The round’s questions, so the candidates can be compared <span className="muted small">(comparison code <span className="mono">{shortFingerprint(set.fingerprint)}</span>)</span>.
                    </p>
                  </div>
                  <div className="ni-set__actions">
                    <button type="button" className="pc-linkbtn" id="ni-own" onClick={() => update({ own: draftOf(set) })}>
                      Use different questions for this interview…
                    </button>
                  </div>
                </div>
              </section>
            )
          ) : (
            <p className="muted ni-set">Loading the questions…</p>
          )}

          <section className="ni-more" aria-labelledby="ni-more-title">
            <h2 className="visually-hidden" id="ni-more-title">
              More options
            </h2>
            <button type="button" className="ni-more__toggle" aria-expanded={form.moreOpen} aria-controls="ni-more-body" onClick={() => update({ moreOpen: !form.moreOpen })}>
              <Icon name="chevron-down" className={`ni-chevron${form.moreOpen ? ' ni-chevron--open' : ''}`} />
              <span className="ni-more__label">More options</span>
              <span className="ni-more__summary">{summary.join(' · ')}</span>
            </button>
            <div id="ni-more-body" className="ni-more__body" hidden={!form.moreOpen}>
              <div className="ni-grid">
                <Field label="Requisition id" hint="Optional. For this candidate.">
                  <TextInput id="ni-req" value={form.requisitionId} maxLength={MAX_REQUISITION} onChange={(e) => update({ requisitionId: e.target.value })} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Note for the interviewers" hint="For example the room or the video link.">
                  <TextArea id="ni-note" rows={2} value={form.note} maxLength={MAX_PLAN_NOTE} onChange={(e) => update({ note: e.target.value })} />
                </Field>
              </div>
              <Checkbox
                id="ni-recording"
                checked={form.recording}
                onChange={(e) => update({ recording: e.target.checked })}
                label="This interview will be recorded or transcribed"
                description="The candidate is told when you read the consent text."
              />
              {round && <p className="small muted">The record is kept until {formatDate(round.retentionUntil)}, the round’s retention date.</p>}
            </div>
          </section>

          <div className="ni-footer">
            <Button type="submit" variant="primary" size="lg" className="ni-continue" disabled={busy}>
              {later ? (
                <>
                  <Icon name="clock" /> Save
                </>
              ) : (
                <>
                  Continue <Icon name="arrow-right" />
                </>
              )}
            </Button>
            <Button onClick={() => void submit(later ? 'continue' : 'save')} disabled={busy}>
              {later ? 'Continue now' : 'Save for later'}
            </Button>
            <span className="small muted">{later ? `Planned for ${formatDate(form.date)}; it appears under Upcoming for the panel.` : 'Next: read the consent text to the candidate, then start.'}</span>
          </div>
          {attempted && (problems.length > 0 || error) && (
            <div ref={problemsRef} tabIndex={-1} className="ni-problems">
              <Alert tone="danger" title={error ? error.message : problems.length === 1 ? 'One thing to fix first:' : `${problems.length} things to fix first:`} role="alert">
                <ul>
                  {error?.details.map((d, i) => <li key={`e${i}`}>{d}</li>)}
                  {!error &&
                    problems.map((p) => (
                      <li key={p.message}>
                        <button type="button" className="pc-linkbtn" onClick={() => document.getElementById(p.id)?.focus()}>
                          {p.message}
                        </button>
                      </li>
                    ))}
                </ul>
              </Alert>
            </div>
          )}
        </div>
      </form>
    </>
  );
}
