import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { changeRecord, sendCommand, useClockOffset, useInterview, useLiveRecords, useLiveState, useOutbox, usePresence } from '../db';
import { Button, IconButton, buttonClass } from '../ui/Button';
import { MenuButton, type MenuItem } from '../ui/MenuButton';
import { EmptyState, PageHeader } from '../ui/Card';
import { Checkbox } from '../ui/Field';
import { ReasonDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ItemText } from '../ui/ItemText';
import { useToast } from '../ui/Toast';
import { isTextEntry, useHotkeys } from '../ui/hotkeys';
import { useDocumentTitle, useNow, useOnline } from '../ui/hooks';
import { formatDate, formatDateTime, formatSeconds } from '../ui/format';
import { DocLink, HelpInNewTabProvider, HelpLink } from '../docs/DocLink';
import { STOPPED_TIMER, elapsedMs, overallTimerStatus, questionTimerStatus } from '../domain/timer';
import { scoreLabel } from '../domain/rubric';
import { formatCandidateKey } from '../domain/plan';
import { needsNote } from '../domain/validation';
import { adjacentQuestion, movesEveryone, toDomainAnswers } from '../domain/live';
import { descriptionOf, type Question, type Score } from '../domain/types';
import type { InterviewDetail, LiveRecords, LiveState, Me, RecordDetail } from '../shared/api';
import { TimerDisplay, useTimerAnnouncements } from './interview/Timers';
import { RubricList, ScoreControl } from './interview/ScoreControl';
import { NoteComposer, NotesList } from './interview/Notes';
import { ProgressList } from './interview/ProgressList';
import { ShortcutsDialog } from './interview/ShortcutsDialog';
import { FinishDialog, errorMessage } from './interview/FinishDialog';
import { AmendAnswerForm, OverallPanel } from './interview/Amend';
import { CandidateQuestion } from './interview/CandidateQuestion';
import { useNoteDraft } from './interview/useNoteDraft';
import { PanelStrip, PeopleLine } from './interview/PanelParts';
import { formatNames } from '../domain/interviewers';
import { activeShortcutKeys, candidateDisplay, explainSuggestion, progressCounts, progressItems, shortRole } from './interview/logic';
import { leadChangeMessage, panelMarks, toPlan, toSession } from './interview/liveModel';
import { questionMeta } from './setup/logic';
import '../styles/pages/interview.css';

/**
 * Route: /interviews/:id/live (LIVE-1…LIVE-8, FLOW-11…FLOW-23, RES-1…RES-3, RUB-1…RUB-5, KEY-1, KEY-2,
 * UX-4, UX-5, AUD-4). Everyone on the panel sees the same question and timers; each scores their own
 * record. The lead's Next, Previous, jumps and Pause move everyone; anyone else's look on their own.
 */
export default function LiveInterview({ me }: { me: Me }) {
  const { id } = useParams();
  const interview = useInterview(id);
  const live = useLiveState(id);
  const records = useLiveRecords(id);
  useDocumentTitle('Live interview');

  if (interview === undefined || live === undefined || records === undefined) {
    return (
      <>
        <PageHeader title="Live interview" />
        <p className="muted" aria-busy="true">
          Loading the interview…
        </p>
      </>
    );
  }
  if (interview === null || live === null || records === null) {
    return (
      <>
        <PageHeader title="Interview not found" />
        <EmptyState title="This interview does not exist, was cancelled, or is in a round you are not on." actions={<Link to="/">Go to the Dashboard</Link>} />
      </>
    );
  }
  // Not started, not joined, or on someone else's screen: the interview page says what to do.
  const mine = records.mine;
  if (live.state === 'planned' || !mine || mine.ownerId !== me.id) return <Navigate to={`/interviews/${interview.id}`} replace />;
  return <Interview me={me} interview={interview} live={live} records={records} mine={mine} />;
}

/** Per-tab memory of the candidate-view toggle, so a reload while sharing the screen does not reveal the interviewer pane. */
function useTabFlag(key: string): [boolean, (v: boolean) => void] {
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

/** PANEL-3: who is making notes on a shared screen, remembered for this interview in this tab. */
function useNoteAuthor(recordId: string, names: readonly string[]): [string, (v: string) => void] {
  const key = `ia.noteBy.${recordId}`;
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

function openCandidateWindow(interviewId: string) {
  const url = `${window.location.pathname}${window.location.search}#/interviews/${interviewId}/present`;
  window.open(url, '_blank', 'popup,width=1280,height=800,noopener');
}

const focusQuestionHeading = () => {
  // After React commits and any dialog has returned focus to its opener; never steal focus from a field.
  setTimeout(() => {
    if (isTextEntry(document.activeElement)) return;
    document.getElementById('question-heading')?.focus();
  }, 60);
};

/** UX-4: the bottom bar is fixed to the window; its height is published as --dock-h so nothing hides behind it. */
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
 * UX-4, BANK-15: the checklist card is never taller than the room between the bars: when a question's
 * lists do not all fit, the card scrolls inside itself (with a cue) while the bars and the question stay put.
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

/** UX-4: a question longer than this (characters) is set a size smaller. */
const LONG_QUESTION_CHARS = 120;
/** Height of the cue at the bottom of the checklist card, in px. */
const CUE_ROOM = 40;

/** UX-4: when the checklist card scrolls inside itself, a cue at its bottom edge says what is below. */
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

interface InterviewProps {
  me: Me;
  interview: InterviewDetail;
  live: LiveState;
  records: LiveRecords;
  mine: RecordDetail;
}

function Interview({ me, interview, live, records, mine }: InterviewProps) {
  const navigate = useNavigate();
  const { toast, announce } = useToast();
  const online = useOnline();
  const plan = useMemo(() => toPlan(interview.set), [interview.set]);
  const ids = useMemo(() => plan.questions.map((q) => q.id), [plan]);
  const session = useMemo(() => toSession(interview, mine, live), [interview, mine, live]);
  const answers = useMemo(() => toDomainAnswers(mine, mine.id), [mine]);
  const [candidateView, setCandidateView] = useTabFlag(`ia.candidateView.${interview.id}`);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [amending, setAmending] = useState<string | null>(null);
  const [rubricOpen, setRubricOpen] = useState(false);
  /** LIVE-2: the question I look at on my own (null: I follow the panel). */
  const [browsing, setBrowsing] = useState<string | null>(null);
  const names = mine.names;
  const [noteBy, setNoteBy] = useNoteAuthor(mine.id, names);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef<() => boolean>(() => false);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);

  const readOnly = mine.state === 'submitted';
  const state = live.state;
  const running = state === 'in_progress';
  const isLive = (state === 'in_progress' || state === 'paused') && !readOnly;
  /** I lead (LIVE-2); my moves reach everyone only while I am online. */
  const iLead = live.leadUserId === me.id;
  const leading = movesEveryone(live, me.id, online);
  const offset = useClockOffset();
  const now = useNow(1000, running && !readOnly) + offset;
  const nameOf = useCallback((uid: string) => live.panel.find((p) => p.id === uid)?.name ?? 'Someone', [live.panel]);

  useOutbox(me.id, useCallback((m: string) => toast(m, 'error'), [toast]));
  usePresence(interview.id, isLive);

  // ---- Which question is on screen (LIVE-2)
  const panelQ = live.currentQuestionId;
  const shownId = browsing ?? panelQ ?? ids[0];
  const index = Math.max(0, ids.indexOf(shownId));
  const question: Question | undefined = plan.questions[index];
  const panelIndex = panelQ ? ids.indexOf(panelQ) : -1;
  const lookingAway = isLive && browsing != null && browsing !== panelQ;

  // Caught up with the panel: follow it again.
  useEffect(() => {
    if (browsing && browsing === panelQ) setBrowsing(null);
  }, [browsing, panelQ]);

  // LIVE-2, A11Y-2: the panel moved. Announce it once; if I am in the middle of a note, I stay where I am.
  const prevPanelQ = useRef(panelQ);
  useEffect(() => {
    const prev = prevPanelQ.current;
    prevPanelQ.current = panelQ;
    if (!isLive || !panelQ || prev === panelQ) return;
    const pos = ids.indexOf(panelQ) + 1;
    if (browsing == null && prev && typingRef.current() && !leading) {
      setBrowsing(prev);
      toast(`The panel moved on to question ${pos}. You stay on question ${ids.indexOf(prev) + 1} while you finish your note.`, 'info');
    } else if (browsing == null) {
      announce(`Question ${pos} of ${ids.length}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the panel's question changes
  }, [panelQ]);

  // LIVE-2: the lead changed. Say so once (the previous lead sees that it happened).
  const prevLead = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const msg = leadChangeMessage(prevLead.current, live.leadUserId, me.id, nameOf);
    prevLead.current = live.leadUserId;
    if (msg && isLive) toast(msg, 'info');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the lead changes
  }, [live.leadUserId]);

  // A paused or resumed interview is announced to followers once (the lead hears it from their own action).
  const prevState = useRef(state);
  useEffect(() => {
    if (prevState.current !== state && isLive && !leading) announce(state === 'paused' ? `${nameOf(live.leadUserId ?? '')} paused the interview. Timers stopped.` : 'The interview resumed. Timers running.');
    prevState.current = state;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the state changes
  }, [state]);

  const answersById = useMemo(() => new Map(answers.map((a) => [a.questionId, a])), [answers]);
  const answer = question ? answersById.get(question.id) : undefined;
  const items = useMemo(() => progressItems(plan, answers), [plan, answers]);
  const onError = useCallback((e: unknown) => toast(errorMessage(e), 'error'), [toast]);
  useDockHeight(dockEl);
  useChecklistHeight(bodyEl, dockEl);

  const questionId = question?.id;
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }, [questionId]);

  // ---- Timers (FLOW-19, RES-2, A11Y-4): server timestamps, corrected for this computer's clock.
  const overallMs = elapsedMs(live.timer, now);
  const overallStatus = overallTimerStatus(overallMs, plan.timeBudgetMin);
  const questionMs = elapsedMs((question && live.questionTimers[question.id]) || STOPPED_TIMER, now);
  const questionStatus = question ? questionTimerStatus(questionMs, question.timeMin) : 'normal';
  useTimerAnnouncements(isLive && question ? { questionId: question.id, overall: overallStatus, question: questionStatus, paused: !running } : null);
  const elapsedSec = useCallback(() => Math.floor(elapsedMs(live.timer, Date.now() + offset) / 1000), [live.timer, offset]);

  // ---- Record changes (LIVE-1, RES-1): shown at once, saved through the outbox.
  const change = useCallback((...ops: Parameters<typeof changeRecord>[2]) => changeRecord(me.id, mine.id, ops), [me.id, mine.id]);

  // ---- Moving (LIVE-2): the lead moves everyone; anyone else looks on their own.
  const goTo = useCallback(
    (target: string, how: 'step' | 'jump' = 'jump') => {
      setAmending(null);
      const pos = ids.indexOf(target) + 1;
      if (readOnly) {
        setBrowsing(target);
        announce(`Question ${pos} of ${ids.length}`);
        return;
      }
      if (leading && panelQ) {
        setBrowsing(null);
        sendCommand(interview.id, { type: 'move', from: panelQ, to: target })
          .then(() => announce(`Question ${pos} of ${ids.length}. The panel follows you.`))
          .catch((e) => {
            onError(e);
            setBrowsing(null);
          });
        return;
      }
      setBrowsing(target === panelQ ? null : target);
      if (target === panelQ) announce(`Back with the panel on question ${pos}.`);
      else if (live.leadUserId === me.id && !online) toast(`You’re offline, so the panel can’t follow you. You’re looking at question ${pos} on your own.`, 'warning');
      else if (how === 'step' || target !== panelQ) announce(`Looking at question ${pos} on your own. The panel is on question ${panelIndex + 1}.`);
    },
    [ids, readOnly, leading, panelQ, interview.id, announce, onError, live.leadUserId, me.id, online, toast, panelIndex],
  );
  const step = useCallback(
    (dir: 1 | -1) => {
      const target = adjacentQuestion(ids, shownId, dir);
      if (!target) return toast(dir === 1 ? (readOnly ? 'This is the last question.' : 'This is the last question. Choose Finish when you are ready.') : 'This is the first question.', 'info');
      goTo(target, 'step');
    },
    [ids, shownId, goTo, toast, readOnly],
  );
  const follow = () => {
    setBrowsing(null);
    announce(`Back with the panel on question ${panelIndex + 1}.`);
    focusQuestionHeading();
  };
  const takeLead = () => {
    if (!online) return toast('You’re offline, so you can’t take the lead now. Your own marks are still kept.', 'warning');
    sendCommand(interview.id, { type: 'lead' })
      .then(() => setBrowsing(null))
      .catch(onError);
  };
  const togglePause = () => {
    if (!online) return toast('You’re offline, so the panel can’t follow you. Pause again when the connection is back.', 'warning');
    sendCommand(interview.id, { type: running ? 'pause' : 'resume' })
      .then(() => announce(running ? 'Interview paused for everyone. Timers stopped.' : 'Interview resumed for everyone. Timers running.'))
      .catch(onError);
  };

  const chooseScore = (score: Score) => question && !readOnly && change({ t: 'score', q: question.id, v: score });
  const flag = () => question && !readOnly && change({ t: 'flag', q: question.id, on: !answer?.flagged });
  const toggleCandidateView = () => {
    setCandidateView(!candidateView);
    announce(candidateView ? 'Interviewer view' : 'Candidate view: only the question is shown');
  };
  const writeNote = () => {
    notesRef.current?.focus();
    notesRef.current?.scrollIntoView({ block: 'nearest' });
  };

  // ---- Hotkeys (KEY-1, KEY-2): N and P move the panel only for the lead; for anyone else they look on their own.
  const allowed = activeShortcutKeys({ state: readOnly ? 'readonly' : 'live', candidateView });
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

  const shortcutsDialog = <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />;

  if (!question) {
    return (
      <>
        <PageHeader title="Live interview" />
        <EmptyState title="This interview has no questions." />
      </>
    );
  }

  // ---- Candidate view (FLOW-11): only the question number and text of the panel's question.
  if (candidateView) {
    return (
      <div className="live live--candidate">
        <CandidateQuestion display={candidateDisplay({ ...session, currentQuestionId: panelQ, state: readOnly ? 'in_progress' : session.state }, plan)} />
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
  const key = formatCandidateKey({ initials: interview.candidate.name, requisitionId: interview.candidate.requisitionId });
  const isAmending = amending === question.id && !!answer;
  const marks = panelMarks(question, records.others);

  // UX-9: one primary action at a time. Paused (lead): Resume. Everything resolved: Finish. On the last question: Finish. Otherwise: Next.
  const nextIsFinish = isLive && onLast;
  const primary: 'resume' | 'finish-top' | 'next' | 'finish-bottom' | 'scorecard' = readOnly
    ? 'scorecard'
    : state === 'paused' && iLead
      ? 'resume'
      : nextIsFinish
        ? 'finish-bottom'
        : allResolved
          ? 'finish-top'
          : 'next';

  const menuItems: MenuItem[] = [
    { label: 'Candidate view', icon: 'eye', shortcut: 'C', onSelect: toggleCandidateView },
    { label: 'Open candidate window', icon: 'window', onSelect: () => openCandidateWindow(interview.id) },
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

  const nextLabel = leading ? 'Next question for everyone (N)' : 'Next question, on your own (N)';
  const prevLabel = leading ? 'Previous question for everyone (P)' : 'Previous question, on your own (P)';

  return (
    <HelpInNewTabProvider value={isLive}>
      <div className={`live live--${readOnly ? 'submitted' : state}`}>
        {/* ---- Top bar (UX-5): who and who is here, overall time, progress, pause or take the lead, More, Finish */}
        <div className="live-bar">
          <div className="live-bar__who">
            <div className="live-bar__line">
              <h1 tabIndex={-1} className="live-bar__title">
                <span className="visually-hidden">Live interview: </span>
                {key}
              </h1>
              <span className="live-bar__role" title={interview.trackName}>
                {shortRole(interview.trackName)}
              </span>
            </div>
            {readOnly ? <p className="live-bar__people">{names.length > 1 ? `with ${formatNames(names)}` : `by ${names[0]}`}</p> : <PeopleLine live={live} meId={me.id} now={now} />}
          </div>
          {isLive && <TimerDisplay inline label="Overall" elapsedMs={overallMs} limitMin={plan.timeBudgetMin} status={overallStatus} paused={!running} />}
          {readOnly && (
            <p className="live-bar__submitted" title={formatDateTime(mine.submittedAt)}>
              <Icon name="check" /> Submitted {formatDate(mine.submittedAt)}
            </p>
          )}
          <ProgressList items={items} currentId={question.id} panelId={isLive && lookingAway ? panelQ : null} onJump={(qid) => goTo(qid)} />
          <div className="live-bar__actions">
            {isLive &&
              (iLead ? (
                <Button icon={running ? 'pause' : 'play'} onClick={togglePause} title={running ? 'Pause the interview for everyone' : 'Resume the interview for everyone'}>
                  {running ? 'Pause' : 'Resume'}
                </Button>
              ) : (
                <Button icon="lead" onClick={takeLead} data-testid="take-lead" title="Lead: your Next, Previous and Pause will move everyone">
                  Take the lead
                </Button>
              ))}
            <MenuButton label="More" items={menuItems} />
            {isLive && !nextIsFinish && (
              <Button variant={primary === 'finish-top' ? 'primary' : 'default'} onClick={() => setFinishOpen(true)}>
                Finish…
              </Button>
            )}
            {readOnly && (
              <Link to={`/scorecard/${mine.id}`} className={buttonClass('primary')}>
                View scorecard
              </Link>
            )}
          </div>
        </div>

        {state === 'paused' && isLive && (
          <div className="paused-banner" role="status">
            <Icon name="pause" />
            <p className="grow">
              <span className="paused-banner__title">Paused{iLead ? '' : ` by ${nameOf(live.leadUserId ?? '')}`}.</span> Both timers are stopped for everyone. You can still look back and add notes.
            </p>
            {iLead && (
              <Button variant="primary" icon="play" onClick={togglePause}>
                Resume
              </Button>
            )}
          </div>
        )}
        {readOnly && (
          <p className="live-readonly">
            <Icon name="info" />
            <span>
              Your record is submitted and read-only. To change a score, a note or the overall assessment, use <strong>Amend</strong> and give a reason.
            </span>
            <DocLink req="AUD-4" />
          </p>
        )}

        <div ref={setBodyEl} className="live-body">
          {/* ---- The question, how to steer, the probe, notes and the panel's marks (left) */}
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
            {lookingAway && (
              <p className="browsing" data-testid="browsing">
                <Icon name="eye" />
                <span>
                  <strong>Looking on your own.</strong> The panel is on question {panelIndex + 1}.
                </span>
                <Button size="sm" onClick={follow}>
                  Follow the panel
                </Button>
              </p>
            )}
            <p className={`question-text${question.text.length > LONG_QUESTION_CHARS ? ' question-text--long' : ''}`}>{question.text}</p>
            <SteeringNote question={question} />
            <fieldset className="probe">
              <legend className="probe__heading">
                <Icon name="help" /> Probe{question.probes.length === 1 ? '' : 's'}: ask next
              </legend>
              <ul className="probes">
                {question.probes.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              <Tick label="Handled the probe without help" checked={!!answer?.probeHandled} editable={editable} onChange={(e) => change({ t: 'probe', q: question.id, on: e.target.checked })} />
            </fieldset>
            {answer?.skipped && (
              <div className="skip-banner" role="status">
                <Icon name="skip" />
                <p className="grow pre-wrap">
                  <span className="skip-banner__title">Skipped.</span> Reason: {answer.skipReason}
                </p>
                {editable && (
                  <Button size="sm" onClick={() => change({ t: 'unskip', q: question.id })}>
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
                    typingRef={typingRef}
                    userId={me.id}
                    record={mine}
                    questionId={question.id}
                    elapsedSec={elapsedSec}
                    authors={names}
                    by={noteBy}
                    onByChange={setNoteBy}
                  />
                ) : (
                  <NotesList notes={answer?.notes ?? []} editable={false} collapse />
                )}
              </section>
            )}
            {marks.length > 0 && <PanelStrip question={question} marks={marks} hidden={records.hidden} />}
          </section>

          {/* ---- What to listen for (right): key points and red flags */}
          <section ref={setPaneEl} className="interviewer-pane" aria-label="What to listen for">
            <fieldset className="evidence__group evidence__group--look">
              <legend className="pane__heading">What to look for</legend>
              <ul className="checklist">
                {question.lookFor.map((k, i) => (
                  <li key={i}>
                    <Tick label={k} checked={!!answer?.coveredKeyPoints.includes(i)} editable={editable} onChange={(e) => change({ t: 'kp', q: question.id, i, on: e.target.checked })} />
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
                      <Tick label={r} checked={!!answer?.redFlagsSeen.includes(i)} editable={editable} onChange={(e) => change({ t: 'rf', q: question.id, i, on: e.target.checked })} />
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <PaneMoreCue pane={paneEl} questionId={question.id} />
          </section>
        </div>

        {readOnly && <OverallPanel key={mine.submittedAt} session={session} />}

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
            <Button className="live-dock__prev" icon="chevron-left" aria-keyshortcuts="P" title={prevLabel} onClick={() => step(-1)} disabled={index <= 0}>
              <span className="btn__text">Previous</span>
              <span className="visually-hidden">{leading ? ' for everyone' : ', on your own'}</span>
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
            {isLive && !lookingAway ? (
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
                <span className="live-dock__spent-label">Time spent</span> {formatSeconds(Math.floor(questionMs / 1000))}
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
                  {editable && answer?.score != null && <IconButton icon="x" size="sm" label="Clear score" className="live-dock__clear" onClick={() => change({ t: 'score', q: question.id, v: null })} />}
                </div>
              )}
            </div>
            {nextIsFinish ? (
              <Button className="live-dock__next" variant={primary === 'finish-bottom' ? 'primary' : 'default'} onClick={() => setFinishOpen(true)}>
                Finish…
              </Button>
            ) : (
              <Button className="live-dock__next" variant={primary === 'next' ? 'primary' : 'default'} aria-keyshortcuts="N" title={nextLabel} onClick={() => step(1)} disabled={onLast}>
                Next
                <span className="visually-hidden">{leading ? ' for everyone' : ', on your own'}</span> <Icon name="chevron-right" />
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
            change({ t: 'skip', q: question.id, reason });
            setSkipOpen(false);
            announce(`Question ${position} skipped.`);
          }}
        />
        {isLive && (
          <FinishDialog
            open={finishOpen}
            userId={me.id}
            onClose={() => setFinishOpen(false)}
            session={session}
            plan={plan}
            answers={answers}
            onJump={(qid) => {
              setFinishOpen(false);
              // Going to a question to resolve it is my own business: it never moves the panel.
              setBrowsing(qid === panelQ ? null : qid);
              focusQuestionHeading();
            }}
            onSubmitted={() => {
              setFinishOpen(false);
              toast('Your record is submitted.', 'success');
              navigate(`/scorecard/${mine.id}`);
            }}
          />
        )}
        {shortcutsDialog}
      </div>
    </HelpInNewTabProvider>
  );
}

interface LiveNotesProps {
  userId: string;
  record: RecordDetail;
  questionId: string;
  elapsedSec: () => number;
  typingRef: MutableRefObject<() => boolean>;
  /** PANEL-3 */
  authors: readonly string[];
  by: string;
  onByChange: (by: string) => void;
}

/** FLOW-15: add (saved while typing), list, edit and delete notes before submitting. */
const LiveNotes = forwardRef<HTMLTextAreaElement, LiveNotesProps>(function LiveNotes({ userId, record, questionId, elapsedSec, typingRef, authors, by, onByChange }, ref) {
  const draft = useNoteDraft(userId, record.id, questionId, elapsedSec, by);
  typingRef.current = draft.typing;
  const notes = record.notes.filter((n) => n.questionId === questionId);
  const hideIndex = draft.draftId ? notes.findIndex((n) => n.id === draft.draftId) : -1;
  return (
    <div className="notes-pane__body">
      <NoteComposer ref={ref} value={draft.text} onChange={draft.change} onAdd={() => draft.finish()} showLabel={false} authors={authors} by={by} onByChange={onByChange} />
      <NotesList
        notes={notes.map((n) => ({ atSec: n.atSec, text: n.text, ...(n.by ? { by: n.by } : {}) }))}
        hideIndex={hideIndex >= 0 ? hideIndex : null}
        emptyText=""
        collapse
        editable
        onSave={(i, text) => draft.updateEntry(notes[i].id, text)}
        onDelete={(i) => draft.removeEntry(notes[i].id)}
      />
    </div>
  );
});

/** A key point, red flag or probe tick: a checkbox while editable, a plain marked item when read-only. */
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

/** FLOW-12, BANK-8: the question's description, for the interviewer to read out or paraphrase. Never on the candidate view. */
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
