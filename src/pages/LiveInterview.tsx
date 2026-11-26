import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  goToQuestion,
  nextQuestion,
  pauseSession,
  previousQuestion,
  resumeSession,
  setProbeHandled,
  setScore,
  skipQuestion,
  startSession,
  toggleFlag,
  toggleKeyPoint,
  toggleRedFlag,
  unskipQuestion,
  useSessionBundle,
  useTracks,
} from '../db';
import { Button, IconButton, buttonClass } from '../ui/Button';
import { MenuButton, type MenuItem } from '../ui/MenuButton';
import { EmptyState, PageHeader } from '../ui/Card';
import { Checkbox } from '../ui/Field';
import { Dialog, ReasonDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ItemText } from '../ui/ItemText';
import { useToast } from '../ui/Toast';
import { isTextEntry, useHotkeys } from '../ui/hotkeys';
import { useDocumentTitle, useNow } from '../ui/hooks';
import { formatDate, formatDateTime, formatSeconds } from '../ui/format';
import { DocLink, HelpInNewTabProvider, HelpLink } from '../docs/DocLink';
import { STOPPED_TIMER, elapsedMs, overallTimerStatus, questionTimerStatus } from '../domain/timer';
import { scoreLabel } from '../domain/rubric';
import { formatCandidateKey } from '../domain/plan';
import { needsNote } from '../domain/validation';
import { descriptionOf, type Answer, type InterviewPlan, type Question, type Score, type Session } from '../domain/types';
import { TimerDisplay, useTimerAnnouncements } from './interview/Timers';
import { RubricList, ScoreControl } from './interview/ScoreControl';
import { NoteComposer, NotesList } from './interview/Notes';
import { ProgressList } from './interview/ProgressList';
import { ShortcutsDialog } from './interview/ShortcutsDialog';
import { FinishDialog, errorMessage } from './interview/FinishDialog';
import { AmendAnswerForm, OverallPanel } from './interview/Amend';
import { PreStart } from './interview/PreStart';
import { CandidateQuestion } from './interview/CandidateQuestion';
import { useNoteDraft } from './interview/useNoteDraft';
import { InterviewersDialog } from './interview/InterviewersDialog';
import { TranscriptPanel } from './transcript/TranscriptPanel';
import { formatNames, interviewersOf } from '../domain/interviewers';
import { activeShortcutKeys, candidateDisplay, explainSuggestion, progressCounts, progressItems, shortRole } from './interview/logic';
import { questionMeta } from './setup/logic';
import '../styles/pages/interview.css';

/** Route: /interview/:sessionId (FLOW-10..23, RES-1/2, RUB-1..5, KEY-1/2, AUD-4). */
export default function LiveInterview() {
  const { sessionId } = useParams();
  const bundle = useSessionBundle(sessionId);
  useDocumentTitle('Live interview');

  if (bundle === undefined) {
    return (
      <>
        <PageHeader title="Live interview" />
        <p className="muted" aria-busy="true">
          Loading the interview…
        </p>
      </>
    );
  }
  if (bundle === null) {
    return (
      <>
        <PageHeader title="Interview not found" />
        <EmptyState title="There is no interview with this link on this device." actions={<Link to="/">Go to the dashboard</Link>} />
      </>
    );
  }
  // FLOW-27: an imported panelist session is only shown through the Debrief, which applies blind scoring.
  if (bundle.session.origin !== 'local') return <Navigate to={`/debrief/${bundle.session.id}`} replace />;
  return <Interview session={bundle.session} plan={bundle.plan} answers={bundle.answers} />;
}

/** Per-tab memory of the candidate-view toggle, so a reload while sharing the screen does not reveal the interviewer pane. */
function useCandidateViewFlag(sessionId: string): [boolean, (v: boolean) => void] {
  const key = `ia.candidateView.${sessionId}`;
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        if (v) sessionStorage.setItem(key, '1');
        else sessionStorage.removeItem(key);
      } catch {
        // Storage unavailable: the toggle still works for this page view.
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * PANEL-3: who is making notes, remembered for this interview in this tab (survives a reload).
 * Only names still on the interview are kept; '' means "not marked".
 */
function useNoteAuthor(sessionId: string, names: readonly string[]): [string, (v: string) => void] {
  const key = `ia.noteBy.${sessionId}`;
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        if (v) sessionStorage.setItem(key, v);
        else sessionStorage.removeItem(key);
      } catch {
        // Storage unavailable: the choice still holds for this page view.
      }
    },
    [key],
  );
  return [names.length > 1 && names.includes(value) ? value : '', set];
}

function openCandidateWindow(sessionId: string) {
  const url = `${window.location.pathname}${window.location.search}#/present/${sessionId}`;
  window.open(url, '_blank', 'popup,width=1280,height=800,noopener');
}

const focusQuestionHeading = () => {
  // After React commits and any dialog has returned focus to its opener.
  // Never steal focus from a field the interviewer has already moved to (e.g. pressed "/" quickly).
  setTimeout(() => {
    if (isTextEntry(document.activeElement)) return;
    document.getElementById('question-heading')?.focus();
  }, 60);
};

interface InterviewProps {
  session: Session;
  plan: InterviewPlan;
  answers: Answer[];
}

/**
 * UX-4: the bottom bar is fixed to the window. Its height is published as --dock-h so the page can
 * leave room for it (nothing is ever hidden behind it) and toasts sit above it.
 */
function useDockHeight(el: HTMLElement | null) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!el) return;
    const set = () => root.style.setProperty('--dock-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--dock-h');
    };
  }, [el]);
}

/**
 * UX-4, BANK-15: the checklist card (what to look for, red flags) is never taller than the
 * room between the bars, so it never makes the page scroll: when a question's lists do not all fit,
 * the card scrolls inside itself (with a cue) while the bars and the question stay put. Publishes
 * --live-pane-max (the room below the card's top, unscrolled, down to the bottom bar) and
 * --live-bar-h (the sticky top bar's height, 0 when it does not stick) for the stylesheet.
 */
function useChecklistHeight(body: HTMLElement | null, dock: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!body) return;
    const root = document.documentElement;
    const bar = body.parentElement?.querySelector<HTMLElement>('.live-bar') ?? null;
    let frame = 0;
    const set = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sticky = bar ? getComputedStyle(bar).position === 'sticky' : false;
        const barH = sticky && bar ? bar.getBoundingClientRect().height : 0;
        const top = body.getBoundingClientRect().top + window.scrollY;
        const dockH = dock ? dock.getBoundingClientRect().height : 0;
        // The page keeps this much room above the bottom bar (.app-main's padding), so a card of
        // this height never makes the page scroll.
        const main = body.closest<HTMLElement>('.app-main');
        const room = main ? parseFloat(getComputedStyle(main).paddingBottom) - dockH : NaN;
        const gap = Number.isFinite(room) && room > 0 ? room : 24;
        root.style.setProperty('--live-bar-h', `${Math.ceil(barH)}px`);
        root.style.setProperty('--live-pane-max', `${Math.max(240, Math.floor(window.innerHeight - top - dockH - gap))}px`);
      });
    };
    set();
    const ro = new ResizeObserver(set);
    if (body.parentElement) ro.observe(body.parentElement);
    if (bar) ro.observe(bar);
    if (dock) ro.observe(dock);
    window.addEventListener('resize', set);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', set);
      root.style.removeProperty('--live-bar-h');
      root.style.removeProperty('--live-pane-max');
    };
  }, [body, dock]);
}

/** UX-4: a question longer than this (characters) is set a size smaller, so it does not crowd the screen. */
const LONG_QUESTION_CHARS = 120;

/** Height of the cue at the bottom of the checklist card, in px (padding and a 24px button). */
const CUE_ROOM = 40;

/**
 * UX-4: when the checklist card scrolls inside itself, a cue at its bottom edge says what is below
 * (usually the last red flags) and scrolls to it. Hidden when everything is in view. Each new
 * question starts at the top of the card.
 */
function PaneMoreCue({ pane, questionId }: { pane: HTMLElement | null; questionId: string }) {
  const [below, setBelow] = useState<{ label: string; target: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    if (pane) pane.scrollTop = 0;
  }, [pane, questionId]);
  useEffect(() => {
    if (!pane) return;
    const update = () => {
      const hidden = pane.scrollHeight - pane.scrollTop - pane.clientHeight > 2;
      if (!hidden) return setBelow(null);
      // Anything ending below this line is under the cue (or the card's edge), so it counts as below.
      const edge = pane.getBoundingClientRect().bottom - CUE_ROOM;
      const groups = [...pane.querySelectorAll<HTMLElement>('.evidence__group')];
      const isBelow = (g: HTMLElement) => [...g.querySelectorAll('li')].some((li) => li.getBoundingClientRect().bottom > edge);
      const first = groups.find(isBelow);
      const names = groups.filter(isBelow).map((g) => (g.classList.contains('evidence__group--flags') ? 'red flags' : 'more key points'));
      const label = names.length ? `${[...new Set(names)].join(' and ')} below`.replace(/^./, (c) => c.toUpperCase()) : 'More below';
      setBelow((prev) => (prev && prev.label === label && prev.target === first ? prev : first ? { label, target: first } : null));
    };
    update();
    pane.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    for (const child of pane.children) ro.observe(child);
    return () => {
      pane.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [pane, questionId]);
  if (!below) return <div className="interviewer-pane__more interviewer-pane__more--none" aria-hidden="true" />;
  return (
    <div className="interviewer-pane__more">
      <button
        type="button"
        className="interviewer-pane__more-button"
        onClick={() => {
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          pane?.scrollTo({ top: below.target.offsetTop - 8, behavior: reduce ? 'auto' : 'smooth' });
        }}
      >
        <Icon name="chevron-down" /> {below.label}
      </button>
    </div>
  );
}

function Interview({ session, plan, answers }: InterviewProps) {
  const navigate = useNavigate();
  const { toast, announce } = useToast();
  const tracks = useTracks();
  const trackName = tracks?.find((t) => t.id === plan.trackId)?.name ?? plan.name;
  const [candidateView, setCandidateView] = useCandidateViewFlag(session.id);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [amending, setAmending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [rubricOpen, setRubricOpen] = useState(false);
  const names = interviewersOf(session);
  const [noteBy, setNoteBy] = useNoteAuthor(session.id, names);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);

  const state = session.state;
  const running = state === 'in_progress';
  const live = state === 'in_progress' || state === 'paused';
  const readOnly = state === 'submitted';
  const now = useNow(1000, running);

  const answersById = useMemo(() => new Map(answers.map((a) => [a.questionId, a])), [answers]);
  const index = plan.questions.findIndex((q) => q.id === session.currentQuestionId);
  const question: Question | undefined = plan.questions[index >= 0 ? index : 0];
  const answer = question ? answersById.get(question.id) : undefined;
  const items = useMemo(() => progressItems(plan, answers), [plan, answers]);

  const onError = useCallback((e: unknown) => toast(errorMessage(e), 'error'), [toast]);
  useDockHeight(dockEl);
  useChecklistHeight(bodyEl, dockEl);

  // A new question starts at the top of the page (on small screens the page may be scrolled down to the notes).
  const questionId = question?.id;
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }, [questionId]);

  // AI-12: /interview/:id?amend=<questionId> (from "worth discussing" on the scorecard) opens the
  // usual amend step for that question, which asks for a reason (AUD-4). Nothing is pre-filled.
  const [params, setParams] = useSearchParams();
  const amendParam = params.get('amend');
  useEffect(() => {
    if (!amendParam) return;
    const next = new URLSearchParams(params);
    next.delete('amend');
    setParams(next, { replace: true });
    if (!readOnly || !plan.questions.some((q) => q.id === amendParam)) return;
    goToQuestion(session.id, amendParam)
      .then(() => {
        setAmending(amendParam);
        setTimeout(() => document.querySelector<HTMLElement>('.amend-form')?.scrollIntoView({ block: 'center' }), 60);
      })
      .catch(onError);
  }, [amendParam, params, setParams, readOnly, plan.questions, session.id, onError]);
  const run = useCallback(
    (fn: () => Promise<unknown>) => {
      fn().catch(onError);
    },
    [onError],
  );

  // ---- Timers (FLOW-19, RES-2, A11Y-4): derived from stored timestamps on every tick.
  const overallMs = elapsedMs(session.timer, now);
  const overallStatus = overallTimerStatus(overallMs, plan.timeBudgetMin);
  const questionMs = elapsedMs(answer?.timer ?? STOPPED_TIMER, now);
  const questionStatus = question ? questionTimerStatus(questionMs, question.timeMin) : 'normal';
  useTimerAnnouncements(live && question ? { questionId: question.id, overall: overallStatus, question: questionStatus, paused: !running } : null);

  // ---- Actions
  const goTo = useCallback(
    (questionId: string) =>
      run(async () => {
        setAmending(null);
        await goToQuestion(session.id, questionId);
        const pos = plan.questions.findIndex((q) => q.id === questionId) + 1;
        announce(`Question ${pos} of ${plan.questions.length}`);
      }),
    [run, session.id, plan.questions, announce],
  );
  const step = useCallback(
    (dir: 1 | -1) =>
      run(async () => {
        setAmending(null);
        const id = await (dir === 1 ? nextQuestion : previousQuestion)(session.id);
        if (id) announce(`Question ${plan.questions.findIndex((q) => q.id === id) + 1} of ${plan.questions.length}`);
        else if (dir === 1) toast(readOnly ? 'This is the last question.' : 'This is the last question. Choose Finish when you are ready.', 'info');
        else toast('This is the first question.', 'info');
      }),
    [run, session.id, plan.questions, announce, toast, readOnly],
  );

  const chooseScore = (score: Score) => question && run(() => setScore(session.id, question.id, score));
  const flag = () => question && run(() => toggleFlag(session.id, question.id));
  const start = () => {
    setBusy(true);
    startSession(session.id)
      .then(() => {
        announce('Interview started. Timers are running.');
        focusQuestionHeading();
      })
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const togglePause = () =>
    run(async () => {
      if (running) {
        await pauseSession(session.id);
        announce('Interview paused. Timers stopped.');
      } else {
        await resumeSession(session.id);
        announce('Interview resumed. Timers running.');
      }
    });
  const toggleCandidateView = () => {
    setCandidateView(!candidateView);
    announce(candidateView ? 'Interviewer view' : 'Candidate view: only the question is shown');
  };
  const writeNote = () => {
    notesRef.current?.focus();
    notesRef.current?.scrollIntoView({ block: 'nearest' });
  };

  // ---- Hotkeys (KEY-1, KEY-2: the hook ignores text fields, modifiers and open dialogs)
  const allowed = activeShortcutKeys({ state: state === 'planned' ? 'planned' : readOnly ? 'readonly' : 'live', candidateView });
  const handlers: Record<string, () => void> = {
    '1': () => chooseScore(1),
    '2': () => chooseScore(2),
    '3': () => chooseScore(3),
    '4': () => chooseScore(4),
    n: () => step(1),
    p: () => step(-1),
    f: flag,
    s: () => setSkipOpen(true),
    c: toggleCandidateView,
    '/': () => notesRef.current?.focus(),
    Escape: () => {
      if (document.activeElement === notesRef.current) {
        notesRef.current?.blur();
        document.getElementById('question-heading')?.focus();
      }
    },
    '?': () => setShortcutsOpen(true),
  };
  useHotkeys(Object.fromEntries(allowed.map((k) => [k, handlers[k]])), { allowInText: ['Escape'], enabled: !amending });

  const shortcutsDialog = (
    <>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {state !== 'submitted' && <InterviewersDialog open={peopleOpen} onClose={() => setPeopleOpen(false)} session={session} />}
    </>
  );

  // ---- Planned (FLOW-10)
  if (state === 'planned') {
    return (
      <div className="live live--planned">
        <PreStart
          session={session}
          plan={plan}
          trackName={trackName}
          busy={busy}
          onStart={start}
          onOpenCandidateWindow={() => openCandidateWindow(session.id)}
          onEditInterviewers={() => setPeopleOpen(true)}
        />
        {shortcutsDialog}
      </div>
    );
  }

  if (!question) {
    return (
      <>
        <PageHeader title="Live interview" />
        <EmptyState title="This interview has no questions." />
      </>
    );
  }

  // ---- Candidate view (FLOW-11): only the question number and text. No bars: the progress strip
  // shows scores and the bottom bar the score control.
  if (candidateView) {
    return (
      <div className="live live--candidate">
        <CandidateQuestion display={candidateDisplay(readOnly ? { ...session, state: 'in_progress' } : session, plan)} />
        <div className="candidate-exit">
          <Button size="sm" variant="ghost" icon="eye-off" aria-keyshortcuts="C" title="Key C" onClick={toggleCandidateView}>
            Back to interviewer view
          </Button>
        </div>
        {shortcutsDialog}
      </div>
    );
  }

  const category = plan.categories.find((c) => c.id === question.categoryId);
  const position = index + 1;
  const total = plan.questions.length;
  const onLast = index >= total - 1;
  const suggestion = explainSuggestion(question, answer);
  const editable = !readOnly;
  const missingNote = needsNote(answer);
  const counts = progressCounts(items);
  const allResolved = counts.resolved === counts.total && counts.needsNote === 0;
  const key = formatCandidateKey(session.candidate);
  const isAmending = amending === question.id && !!answer;

  // UX-9: one primary action at a time. Paused: Resume. Everything resolved: Finish. On the last
  // question: Finish (in Next's place). Otherwise: Next.
  const nextIsFinish = live && onLast;
  const primary: 'resume' | 'finish-top' | 'next' | 'finish-bottom' | 'scorecard' = readOnly
    ? 'scorecard'
    : state === 'paused'
      ? 'resume'
      : nextIsFinish
        ? 'finish-bottom'
        : allResolved
          ? 'finish-top'
          : 'next';

  const menuItems: MenuItem[] = [
    { label: 'Candidate view', icon: 'eye', shortcut: 'C', onSelect: toggleCandidateView },
    { label: 'Open candidate window', icon: 'window', onSelect: () => openCandidateWindow(session.id) },
    ...(editable ? [{ label: 'Interviewers…', icon: 'edit' as const, onSelect: () => setPeopleOpen(true) }] : []),
    { label: 'Transcript & recording…', icon: 'doc', onSelect: () => setAttachOpen(true) },
    { label: 'Keyboard shortcuts', icon: 'help', shortcut: '?', onSelect: () => setShortcutsOpen(true) },
  ];

  const scoreHint = (
    <p id="score-hint" className="live-dock__hint" aria-live="polite">
      {answer?.skipped && editable && <span className="live-dock__hint-item">Skipped. Choosing a score undoes the skip.</span>}
      {suggestion && !answer?.skipped && (
        <span className="suggestion live-dock__hint-item">
          <Icon name="info" />
          <span>
            Suggested: <strong>{suggestion.score} · {scoreLabel(suggestion.score)}</strong>
            <span className="suggestion__why"> — {suggestion.reason}</span>
          </span>
        </span>
      )}
      {missingNote ? (
        <span className="needs-note live-dock__hint-item">
          <Icon name="note" />
          <span>This question is scored {answer?.score} and needs a note.</span>
          {editable && (
            <button type="button" className="link-button" onClick={writeNote}>
              Write it
            </button>
          )}
        </span>
      ) : (
        !suggestion && !answer?.skipped && editable && <span className="live-dock__hint-item muted">A 1 or a 4 needs a note of what the candidate said.</span>
      )}
    </p>
  );

  return (
    <HelpInNewTabProvider value={live}>
      <div className={`live live--${state}`}>
        {/* ---- Top bar (UX-5): who, overall time, progress, pause, More, Finish */}
        <div className="live-bar">
          <div className="live-bar__who">
            <div className="live-bar__line">
              <h1 tabIndex={-1} className="live-bar__title">
                <span className="visually-hidden">Live interview: </span>
                {key}
              </h1>
              <span className="live-bar__role" title={trackName}>
                {shortRole(trackName)}
              </span>
            </div>
            <p className="live-bar__people">
              with {formatNames(names)}
            </p>
          </div>
          {live && <TimerDisplay inline label="Overall" elapsedMs={overallMs} limitMin={plan.timeBudgetMin} status={overallStatus} paused={!running} />}
          {readOnly && (
            <p className="live-bar__submitted" title={formatDateTime(session.submittedAt)}>
              <Icon name="check" /> Submitted {formatDate(session.submittedAt)}
            </p>
          )}
          <ProgressList items={items} currentId={question.id} onJump={goTo} />
          <div className="live-bar__actions">
            {live && (
              <Button icon={running ? 'pause' : 'play'} onClick={togglePause}>
                {running ? 'Pause' : 'Resume'}
              </Button>
            )}
            <MenuButton label="More" items={menuItems} />
            {live && !nextIsFinish && (
              <Button variant={primary === 'finish-top' ? 'primary' : 'default'} onClick={() => setFinishOpen(true)}>
                Finish…
              </Button>
            )}
            {readOnly && (
              <Link to={`/scorecard/${session.id}`} className={buttonClass('primary')}>
                View scorecard
              </Link>
            )}
          </div>
        </div>

        {state === 'paused' && (
          <div className="paused-banner" role="status">
            <Icon name="pause" />
            <p className="grow">
              <span className="paused-banner__title">Paused.</span> Both timers are stopped. You can still look back and add notes.
            </p>
            <Button variant="primary" icon="play" onClick={togglePause}>
              Resume
            </Button>
          </div>
        )}
        {readOnly && (
          <p className="live-readonly">
            <Icon name="info" />
            <span>
              This interview is submitted and read-only. To change a score, a note or the overall assessment, use <strong>Amend</strong> and give a reason.
            </span>
            <DocLink req="AUD-4" />
          </p>
        )}

        <div ref={setBodyEl} className="live-body">
          {/* ---- The question, how to steer, the probe, and notes (left) */}
          <section className="question-pane" aria-labelledby="question-heading">
            <div className="question-pane__meta">
              <h2 id="question-heading" tabIndex={-1} className="question-pane__number">
                Question {position} <span className="question-pane__of">of {total}</span>
              </h2>
              <span className="question-pane__facts">
                {questionMeta(question, category?.name ?? '')}
                {category?.mustHave && ' · must-have'}
              </span>
            </div>
            <p className={`question-text${question.text.length > LONG_QUESTION_CHARS ? ' question-text--long' : ''}`}>{question.text}</p>
            <SteeringNote question={question} />
            {/* The probe is asked after the question, so it sits with it; this leaves the checklist
                card the room for the whole of "what to look for" and the red flags (UX-4). */}
            <fieldset className="probe">
              <legend className="probe__heading">
                <Icon name="help" /> Probe{question.probes.length === 1 ? '' : 's'}: ask next
              </legend>
              <ul className="probes">
                {question.probes.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              <Tick
                label="Handled the probe without help"
                checked={!!answer?.probeHandled}
                editable={editable}
                onChange={(e) => run(() => setProbeHandled(session.id, question.id, e.target.checked))}
              />
            </fieldset>
            {answer?.skipped && (
              <div className="skip-banner" role="status">
                <Icon name="skip" />
                <p className="grow pre-wrap">
                  <span className="skip-banner__title">Skipped.</span> Reason: {answer.skipReason}
                </p>
                {editable && (
                  <Button size="sm" onClick={() => run(() => unskipQuestion(session.id, question.id))}>
                    Undo skip
                  </Button>
                )}
              </div>
            )}

            {isAmending ? (
              <AmendAnswerForm
                key={question.id}
                session={session}
                question={question}
                position={position}
                answer={answer!}
                onDone={() => {
                  setAmending(null);
                  focusQuestionHeading();
                }}
              />
            ) : (
              <section className={`notes-pane${missingNote ? ' notes-pane--needed' : ''}`} aria-labelledby="notes-heading">
                <h3 id="notes-heading" className="pane__heading">
                  Notes
                  {missingNote && <span className="notes-pane__needed">needed for this score</span>}
                </h3>
                {editable ? (
                  <LiveNotes
                    key={question.id}
                    ref={notesRef}
                    sessionId={session.id}
                    questionId={question.id}
                    answer={answer}
                    onError={onError}
                    authors={names}
                    by={noteBy}
                    onByChange={setNoteBy}
                  />
                ) : (
                  <NotesList notes={answer?.notes ?? []} editable={false} collapse />
                )}
              </section>
            )}
          </section>

          {/* ---- What to listen for (right): key points and red flags */}
          <section ref={setPaneEl} className="interviewer-pane" aria-label="What to listen for">
            <fieldset className="evidence__group evidence__group--look">
              <legend className="pane__heading">What to look for</legend>
              <ul className="checklist">
                {question.lookFor.map((k, i) => (
                  <li key={i}>
                    <Tick label={k} checked={!!answer?.coveredKeyPoints.includes(i)} editable={editable} onChange={() => run(() => toggleKeyPoint(session.id, question.id, i))} />
                  </li>
                ))}
              </ul>
            </fieldset>

            <fieldset className="evidence__group evidence__group--flags">
              <legend className="pane__heading">
                <Icon name="alert" className="evidence__flag-icon" />
                Red flags
              </legend>
              {question.redFlags.length === 0 ? (
                <p className="small muted">None listed.</p>
              ) : (
                <ul className="checklist">
                  {question.redFlags.map((r, i) => (
                    <li key={i}>
                      <Tick label={r} checked={!!answer?.redFlagsSeen.includes(i)} editable={editable} onChange={() => run(() => toggleRedFlag(session.id, question.id, i))} />
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <PaneMoreCue pane={paneEl} questionId={question.id} />
          </section>
        </div>

        {readOnly && <OverallPanel key={session.submittedAt} session={session} />}

        {/* ---- Bottom bar (UX-4): always in view. Previous · score · rubric, flag, skip · time · Next */}
        <section ref={setDockEl} className="live-dock" aria-label="Score and move on">
          <div id="rubric-panel" className="live-dock__rubric" hidden={!rubricOpen}>
            <div className="live-dock__rubric-inner">
              <div className="spread">
                <h2 className="live-dock__rubric-title">Rubric for question {position}</h2>
                <HelpLink slug="03-rubric" section="suggested-score">
                  How the suggestion works
                </HelpLink>
              </div>
              <RubricList question={question} value={answer?.score ?? null} suggested={suggestion?.score} />
            </div>
          </div>
          <div className="live-dock__inner">
            <div className="live-dock__info">
              {!isAmending && scoreHint}
              <button type="button" className="link-button live-dock__rubric-toggle" aria-expanded={rubricOpen} aria-controls="rubric-panel" onClick={() => setRubricOpen(!rubricOpen)}>
                <Icon name={rubricOpen ? 'chevron-down' : 'chevron-right'} />
                {rubricOpen ? 'Hide the rubric' : 'Rubric'}
              </button>
            </div>
            <Button className="live-dock__prev" icon="chevron-left" aria-keyshortcuts="P" title="Previous question (P)" onClick={() => step(-1)} disabled={index <= 0}>
              <span className="btn__text">Previous</span>
            </Button>
            <div className="live-dock__tools">
              {editable && (
                <>
                  <Button size="sm" variant="ghost" icon="flag" aria-pressed={!!answer?.flagged} aria-keyshortcuts="F" title="Flag for the debrief (F)" onClick={flag}>
                    <span className="btn__text">
                      {answer?.flagged ? 'Flagged' : 'Flag'}
                      <span className="visually-hidden"> for debrief</span>
                    </span>
                  </Button>
                  <Button size="sm" variant="ghost" icon="skip" aria-pressed={!!answer?.skipped} aria-keyshortcuts="S" title="Skip, with a reason (S)" onClick={() => setSkipOpen(true)}>
                    <span className="btn__text">
                      {answer?.skipped ? 'Skipped' : 'Skip…'}
                      {answer?.skipped && <span className="visually-hidden">: change the reason</span>}
                    </span>
                  </Button>
                </>
              )}
              {readOnly && answer?.flagged && (
                <span className="live-dock__flagged">
                  <Icon name="flag" /> Flagged for debrief
                </span>
              )}
              {readOnly && answer && !isAmending && (
                <Button size="sm" icon="edit" onClick={() => setAmending(question.id)}>
                  Amend this question…
                </Button>
              )}
            </div>
            {live ? (
              <TimerDisplay
                inline
                label="This question"
                elapsedMs={questionMs}
                limitMin={question.timeMin}
                status={questionStatus}
                paused={!running}
                statusText={questionStatus === 'amber' ? 'Estimate reached' : 'Within estimate'}
              />
            ) : (
              <p className="live-dock__spent">
                <span className="live-dock__spent-label">Time spent</span> {formatSeconds(answer?.elapsedSec ?? 0)}
              </p>
            )}
            <div className="live-dock__score">
              {isAmending ? (
                <p className="live-dock__amending">
                  <Icon name="edit" /> Amending question {position}: save or cancel above.
                </p>
              ) : (
                <div className="live-dock__score-row">
                  <ScoreControl
                    variant="bar"
                    question={question}
                    value={answer?.score ?? null}
                    suggested={suggestion?.score}
                    disabled={!editable}
                    showKeys={editable}
                    legend="Score"
                    hideLegend
                    describedBy="score-hint"
                    onChange={chooseScore}
                  />
                  {editable && answer?.score != null && (
                    <IconButton icon="x" size="sm" label="Clear score" className="live-dock__clear" onClick={() => run(() => setScore(session.id, question.id, null))} />
                  )}
                </div>
              )}
            </div>
            {nextIsFinish ? (
              <Button className="live-dock__next" variant={primary === 'finish-bottom' ? 'primary' : 'default'} onClick={() => setFinishOpen(true)}>
                Finish…
              </Button>
            ) : (
              <Button
                className="live-dock__next"
                variant={primary === 'next' ? 'primary' : 'default'}
                aria-keyshortcuts="N"
                title="Next question (N)"
                onClick={() => step(1)}
                disabled={onLast}
              >
                Next <Icon name="chevron-right" />
              </Button>
            )}
          </div>
        </section>

        <ReasonDialog
          open={skipOpen}
          title={`Skip question ${position}`}
          label="Reason for skipping"
          hint="A skipped question has no score and is listed with its reason on the scorecard. You can undo it before finishing."
          submitLabel="Skip question"
          initialValue={answer?.skipReason ?? ''}
          onCancel={() => setSkipOpen(false)}
          onSubmit={async (reason) => {
            await skipQuestion(session.id, question.id, reason);
            setSkipOpen(false);
            announce(`Question ${position} skipped.`);
          }}
        />
        {live && (
          <FinishDialog
            open={finishOpen}
            onClose={() => setFinishOpen(false)}
            session={session}
            plan={plan}
            answers={answers}
            onJump={(qid) => {
              setFinishOpen(false);
              goTo(qid);
              focusQuestionHeading();
            }}
            onSubmitted={() => {
              setFinishOpen(false);
              toast('Interview submitted.', 'success');
              navigate(`/scorecard/${session.id}`);
            }}
          />
        )}
        {shortcutsDialog}
        {/* TR-1, TR-2: out of the way during the interview; the scorecard is the main place afterwards. */}
        <Dialog open={attachOpen} onClose={() => setAttachOpen(false)} title="Transcript and recording" wide>
          <TranscriptPanel session={session} plan={plan} />
        </Dialog>
      </div>
    </HelpInNewTabProvider>
  );
}

interface LiveNotesProps {
  sessionId: string;
  questionId: string;
  answer: Answer | undefined;
  onError: (e: unknown) => void;
  /** PANEL-3 */
  authors: readonly string[];
  by: string;
  onByChange: (by: string) => void;
}

/** FLOW-15: add (saved while typing), list, edit and delete notes before submitting. */
const LiveNotes = forwardRef<HTMLTextAreaElement, LiveNotesProps>(function LiveNotes({ sessionId, questionId, answer, onError, authors, by, onByChange }, ref) {
  const draft = useNoteDraft(sessionId, questionId, onError, by);
  return (
    <div className="notes-pane__body">
      <NoteComposer ref={ref} value={draft.text} onChange={draft.change} onAdd={() => void draft.finish()} showLabel={false} authors={authors} by={by} onByChange={onByChange} />
      <NotesList
        notes={answer?.notes ?? []}
        hideIndex={draft.draftIndex}
        emptyText=""
        collapse
        editable
        onSave={(i, text) => draft.updateEntry(questionId, i, text)}
        onDelete={(i) => draft.removeEntry(questionId, i)}
      />
    </div>
  );
});

/** A key point, red flag or probe tick: a checkbox while editable, a plain marked item when read-only (clearer than a disabled box). */
function Tick({ label, checked, editable, onChange }: { label: string; checked: boolean; editable: boolean; onChange: (e: ChangeEvent<HTMLInputElement>) => void }) {
  // BANK-15: a key point's or red flag's leading label is emphasised so the list can be scanned.
  if (editable) return <Checkbox label={<ItemText text={label} />} checked={checked} onChange={onChange} />;
  return (
    <p className={`tick-ro${checked ? ' tick-ro--on' : ''}`}>
      <Icon name={checked ? 'check' : 'circle'} />
      <span>
        <ItemText text={label} />
        <span className="visually-hidden">{checked ? ' (ticked)' : ' (not ticked)'}</span>
      </span>
    </p>
  );
}

/**
 * FLOW-12, BANK-8: the question's description, for the interviewer to read out or paraphrase when
 * the candidate has not understood the question. Interviewer pane only (FLOW-11: never on the
 * candidate view or window). Plans locked before descriptions existed have none: nothing is shown.
 */
function SteeringNote({ question }: { question: Question }) {
  const text = descriptionOf(question);
  if (!text) return null;
  return (
    <section className="steer" aria-labelledby="steer-heading">
      <h3 id="steer-heading" className="steer__heading">
        <Icon name="steer" /> If the candidate needs steering
      </h3>
      <p className="steer__text">{text}</p>
    </section>
  );
}
