import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { exportScorecard, exportSessionFile, useAiSecondOpinion, usePanel, usePanelRecordFor, useSessionBundle, useTracks, useTranscript } from '../db';
import { DecisionNote } from './panel/PanelParts';
import { enteredLabel } from '../domain/decision';
import { formatCandidateKey, shortFingerprint } from '../domain/plan';
import { scoreLabel } from '../domain/rubric';
import { RECOMMENDATION_LABELS, type InterviewPlan, type Session } from '../domain/types';
import type { Scorecard as ScorecardData } from '../domain/scoring';
import {
  Alert,
  BandBadge,
  Badge,
  Card,
  MenuButton,
  DocLink,
  EmptyState,
  HelpLink,
  Icon,
  PageHeader,
  buttonClass,
  downloadFile,
  formatAverage,
  formatCoverage,
  formatDate,
  formatDateTime,
  formatPct,
  useDocumentTitle,
  useToast,
} from '../ui';
import type { MenuItem } from '../ui';
import { CategoryChart, CategoryTable } from './scorecard/CategoryChart';
import { QuestionTable } from './scorecard/QuestionTable';
import { capNote } from './scorecard/model';
import { AiSection, useAiReport } from './scorecard/AiSection';
import { TranscriptPanel } from './transcript/TranscriptPanel';
import type { FocusLineRequest } from './transcript/TranscriptViewer';
import '../styles/pages/scorecard.css';
import '../styles/pages/print.css';
import { interviewersLabel, interviewersOf } from '../domain/interviewers';

/** Route: /scorecard/:sessionId (FLOW-24, FLOW-25, FLOW-31, FLOW-32, SCORE-3…10). */
export default function Scorecard() {
  const { sessionId } = useParams();
  const bundle = useSessionBundle(sessionId);
  // FLOW-27: an imported panelist's scorecard stays hidden until your own interview is submitted.
  const panel = usePanel(sessionId);
  useDocumentTitle('Scorecard');
  const { title, subtitle, actions, body } = scorecardContent(bundle, panel);
  // One stable h1 (A11Y-2): it is focused on route change and keeps focus as data loads.
  return (
    <div className="scorecard">
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {body}
    </div>
  );
}

function scorecardContent(
  bundle: ReturnType<typeof useSessionBundle>,
  panel: ReturnType<typeof usePanel>,
): { title: string; subtitle?: string; actions?: ReactNode; body: ReactNode } {
  if (bundle === undefined || (bundle?.session.origin === 'imported' && panel === undefined)) {
    return {
      title: 'Scorecard',
      body: (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ),
    };
  }
  if (bundle === null) {
    return {
      title: 'Scorecard',
      body: (
        <EmptyState title="This interview was not found on this device." actions={<Link to="/">Go to the dashboard</Link>}>
          <p>It may have been deleted by a deletion request or the retention purge.</p>
        </EmptyState>
      ),
    };
  }
  const { session, plan, scorecard } = bundle;
  const key = formatCandidateKey(session.candidate);

  if (session.state !== 'submitted') {
    return {
      title: 'Scorecard',
      subtitle: `Candidate ${key}`,
      body: (
        <Alert tone="info" title="The scorecard is available once the interview is submitted.">
          <p>
            Finish the interview first: score or skip every question, then give an overall rating, recommendation and rationale.{' '}
            <DocLink req="FLOW-22" />
          </p>
          <p>
            <Link to={`/interview/${session.id}`}>Back to the interview</Link>
          </p>
        </Alert>
      ),
    };
  }

  const entry = panel?.entries.find((e) => e.session.id === session.id);
  if (session.origin === 'imported' && (!entry || entry.hidden)) {
    return {
      title: 'Scorecard',
      subtitle: `Candidate ${key} · panelist ${interviewersLabel(session)}`,
      body: (
        <Alert tone="info" title="Hidden until your own interview is submitted (blind scoring).">
          <p>
            Interviewers rate independently. This scorecard from another interviewer is shown once your own interview of this candidate,
            with the same questions, is submitted. <DocLink req="FLOW-27" />
          </p>
          <p>
            <Link to={`/debrief/${session.id}`}>Go to the debrief</Link>
          </p>
        </Alert>
      ),
    };
  }

  return {
    title: `Scorecard: ${key}`,
    actions: <ScorecardActions session={session} />,
    subtitle:
      session.origin === 'imported'
        ? `Imported from panelist ${interviewersLabel(session)}. Read-only.`
        : session.origin === 'entered'
          ? `${enteredLabel(session)}, ${formatDateTime(session.enteredAt)}. Read-only: correct it from the candidate summary.`
          : `Submitted ${formatDateTime(session.submittedAt)}`,
    body: <ScorecardView session={session} plan={plan} scorecard={scorecard} />,
  };
}


/** UX-9: the scorecard's actions. One primary (the debrief, the next step); the exports in one menu (FLOW-31, FLOW-32). */
function ScorecardActions({ session }: { session: Session }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // Other people's records (imported, or entered here on their behalf) are read-only here.
  const imported = session.origin !== 'local';
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const exportFile = (format: 'markdown' | 'csv') =>
    run(async () => {
      const f = await exportScorecard(session.id, format);
      downloadFile(f.fileName, f.mime, f.text);
      toast(`Scorecard exported as ${format === 'markdown' ? 'Markdown' : 'CSV'}. The export is recorded in the audit log.`, 'success');
    });
  const print = () =>
    run(async () => {
      await exportScorecard(session.id, 'print'); // FLOW-32: audited before the print dialog opens.
      window.print();
    });
  const exportSession = () =>
    run(async () => {
      const f = await exportSessionFile(session.id);
      downloadFile(f.fileName, f.mime, f.text);
      toast('Interview file exported. Share it with the other interviewers for the debrief.', 'success');
    });

  const exportItems: MenuItem[] = [
    { label: 'Markdown', icon: 'download', onSelect: () => void exportFile('markdown') },
    { label: 'CSV, one row per question', icon: 'download', onSelect: () => void exportFile('csv') },
    { label: 'Print or save as PDF', icon: 'doc', onSelect: () => void print() },
    ...(!imported ? [{ label: 'Interview file for the debrief', icon: 'download' as const, onSelect: () => void exportSession() }] : []),
  ];

  return (
    <>
      {!imported && (
        <Link className={buttonClass('ghost')} to={`/interview/${session.id}`}>
          <Icon name="edit" /> Amend (reason required)
        </Link>
      )}
      <MenuButton label="Export" items={exportItems.map((i) => ({ ...i, disabled: busy }))} />
      <Link className={buttonClass('primary')} to={`/debrief/${session.id}`}>
        Debrief <Icon name="arrow-right" />
      </Link>
    </>
  );
}

function ScorecardView({ session, plan, scorecard }: { session: Session; plan: InterviewPlan; scorecard: ScorecardData }) {
  const tracks = useTracks();
  const trackName = tracks?.find((t) => t.id === plan.trackId)?.name ?? plan.trackId;
  const key = formatCandidateKey(session.candidate);
  const cap = capNote(scorecard);
  const imported = session.origin !== 'local';
  // TEAM-12: the panel decision is the outcome, shown beside this interviewer's own figures.
  const record = usePanelRecordFor(session.id);
  // AI-9: the data layer returns the AI result only for a submitted local session.
  const aiView = useAiSecondOpinion(session.id);
  const transcript = useTranscript(session.id);
  const report = useAiReport(plan, scorecard, aiView);
  const [focusLine, setFocusLine] = useState<FocusLineRequest | null>(null);
  const [params] = useSearchParams();
  const sections = imported ? SECTIONS.filter((x) => x.id === 'summary' || x.id === 'questions') : SECTIONS;
  const goTo = useCallback((id: SectionId) => {
    const h = document.getElementById(`sc-${id}-h`);
    if (!h) return;
    h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }, []);
  const jumpToLine = useCallback(
    (line: number) => {
      setFocusLine((f) => ({ line, nonce: (f?.nonce ?? 0) + 1 }));
    },
    [],
  );
  // Deep link: /scorecard/:id?section=ai (from the transcript panel).
  const wanted = params.get('section') as SectionId | null;
  useEffect(() => {
    if (wanted && SECTIONS.some((x) => x.id === wanted)) setTimeout(() => goTo(wanted), 50);
  }, [wanted, goTo]);

  return (
    <>
      <nav className="sc-nav no-print" aria-label="Scorecard sections">
        <span className="small muted">On this page:</span>
        <ul>
          {sections.map((x) => (
            <li key={x.id}>
              <button type="button" className="sc-nav__link" onClick={() => goTo(x.id)}>
                {x.label}
                {x.id === 'ai' && report?.comparison.worthDiscussing.length ? <span className="sc-nav__count"> ({report.comparison.worthDiscussing.length} to discuss)</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <h2 id="sc-summary-h" className="sc-part" tabIndex={-1}>
        Summary
      </h2>
      <dl className="sc-meta">
        <div>
          <dt>Candidate</dt>
          <dd>{key}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{trackName}</dd>
        </div>
        <div>
          <dt>{interviewersOf(session).length > 1 ? 'Interviewers' : 'Interviewer'}</dt>
          <dd>
            {interviewersLabel(session)}
            {interviewersOf(session).length > 1 && <span className="muted small"> (one shared scorecard)</span>}
          </dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{formatDate(session.startedAt ?? session.createdAt)}</dd>
        </div>
        <div>
          <dt>Question set</dt>
          <dd>{plan.name}</dd>
        </div>
        <div>
          <dt>
            Comparison code <DocLink req="FLOW-9" label="Comparing candidates" className="no-print" />
          </dt>
          <dd className="mono" title={plan.fingerprint ?? undefined}>
            {shortFingerprint(plan.fingerprint)}
          </dd>
        </div>
      </dl>

      {record?.decision && <DecisionNote decision={record.decision} to={`/candidate/${session.id}`} />}

      <section className="sc-summary" aria-labelledby="sc-summary-h">
        <Card className="sc-figure" title="Overall" level={3}>
          <p className="sc-big tabular">{formatPct(scorecard.overallPct)}</p>
          <p className="small">
            Weighted over {scorecard.answeredCount} of {scorecard.plannedCount} answered questions. <DocLink req="SCORE-3" />
          </p>
          <p className="small">
            Coverage <strong className="tabular">{formatCoverage(scorecard.coverage)}</strong> of planned weight (70% needed for a
            band). <DocLink req="SCORE-6" />
          </p>
        </Card>

        <Card className="sc-figure" title="Advisory band" level={3}>
          <p>
            <BandBadge band={scorecard.band} insufficientEvidence={scorecard.insufficientEvidence} capped={scorecard.capApplied} />
          </p>
          <p className="small">
            Worked out from the overall percentage. Advisory only: people make the decision. <DocLink req="SCORE-9" />
          </p>
          <p className="small">
            <HelpLink slug="04-scoring" section="bands">
              Band thresholds
            </HelpLink>
          </p>
        </Card>

        <Card className="sc-figure sc-decision" title="Interviewer’s decision" level={3}>
          <dl className="sc-decision__list">
            <div>
              <dt>Recommendation</dt>
              <dd>
                <strong>{session.overall.recommendation ? RECOMMENDATION_LABELS[session.overall.recommendation] : '–'}</strong>
              </dd>
            </div>
            <div>
              <dt>Overall rating</dt>
              <dd>{session.overall.rating ? `${session.overall.rating} – ${scoreLabel(session.overall.rating)}` : '–'}</dd>
            </div>
          </dl>
          <p className="small muted">
            Recorded by {interviewersLabel(session)}{interviewersOf(session).length > 1 ? ', on behalf of all of them' : ''}. <DocLink req="FLOW-25" />
          </p>
        </Card>
      </section>

      <section className="sc-rationale" aria-labelledby="sc-rationale-h">
        <h2 id="sc-rationale-h">Rationale</h2>
        {session.overall.rationale.trim() ? (
          <p className="pre-wrap sc-rationale__text">{session.overall.rationale}</p>
        ) : (
          <p className="muted">None given.</p>
        )}
      </section>

      {scorecard.insufficientEvidence && (
        <Alert tone="warning" title="Insufficient evidence: no band is shown.">
          <p>
            Only {formatCoverage(scorecard.coverage)} of the planned question weight was answered; at least 70% is needed. The
            percentage is still shown. <DocLink req="SCORE-6" />
          </p>
        </Alert>
      )}
      {cap && (
        <Alert tone="warning" title={scorecard.capApplied ? 'Must-have cap applied.' : 'Must-have category below 2.0.'}>
          <p>
            {cap} <DocLink req="SCORE-8" />
          </p>
        </Alert>
      )}

      <section className="sc-section" aria-labelledby="sc-cat-h">
        <h2 id="sc-cat-h">Categories</h2>
        <CategoryChart scorecard={scorecard} />
        <CategoryTable scorecard={scorecard} />
      </section>

      <section className="sc-section sc-lists" aria-labelledby="sc-sc-h">
        <h2 id="sc-sc-h" className="visually-hidden">
          Strengths and concerns
        </h2>
        <Card title="Strengths" level={3} actions={<DocLink req="SCORE-5" className="no-print" />}>
          <p className="small muted">Categories averaging 3.0 or more.</p>
          {scorecard.strengths.length ? (
            <ul className="sc-list">
              {scorecard.strengths.map((s) => (
                <li key={s.category.id}>
                  <Icon name="check" /> {s.category.name} <span className="muted">(average {formatAverage(s.average)})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </Card>
        <Card title="Concerns" level={3} actions={<DocLink req="SCORE-5" className="no-print" />}>
          <p className="small muted">Categories averaging 2.0 or less, and must-have categories with no evidence.</p>
          {scorecard.concerns.length ? (
            <ul className="sc-list">
              {scorecard.concerns.map((c) => (
                <li key={c.category.id}>
                  <Icon name="alert" /> {c.category.name}{' '}
                  <span className="muted">
                    {c.reason === 'no-evidence' ? '(must-have, no evidence: no answered questions)' : `(average ${formatAverage(c.average)})`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </Card>
      </section>

      <section className="sc-section" aria-labelledby="sc-questions-h">
        <h2 id="sc-questions-h" className="sc-part" tabIndex={-1}>
          Questions
        </h2>
        <QuestionTable scorecard={scorecard} ai={report} />
      </section>

      <section className="sc-section sc-lists" aria-labelledby="sc-sf-h">
        <h2 id="sc-sf-h" className="visually-hidden">
          Skipped and flagged questions
        </h2>
        <Card title={`Skipped questions (${scorecard.skipped.length})`} level={3} actions={<DocLink req="FLOW-17" className="no-print" />}>
          <p className="small muted">Excluded from the percentages; they reduce coverage.</p>
          {scorecard.skipped.length ? (
            <ul className="sc-list">
              {scorecard.skipped.map((r) => (
                <li key={r.question.id}>
                  <strong>Q{r.index + 1}.</strong> {r.question.text}
                  <br />
                  <span className="muted">Reason:</span> <span className="pre-wrap">{r.skipReason ?? '–'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </Card>
        <Card title={`Flagged for the debrief (${scorecard.flagged.length})`} level={3} actions={<DocLink req="FLOW-18" className="no-print" />}>
          {scorecard.flagged.length ? (
            <ul className="sc-list">
              {scorecard.flagged.map((r) => (
                <li key={r.question.id}>
                  <Icon name="flag" /> <strong>Q{r.index + 1}.</strong> {r.question.text}{' '}
                  {r.skipped ? <Badge tone="warning">Skipped</Badge> : r.score ? <span className="muted">(score {r.score})</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </Card>
      </section>

      <p className="sc-footnote small muted">
        The band is advisory. People record every score and the final decision. Percentages are rounded to whole numbers and
        averages to one decimal place; thresholds use unrounded values. <DocLink req="SCORE-10" className="no-print" />
      </p>

      {!imported && (
        <section className="sc-section sc-ai-section" aria-labelledby="sc-ai-h">
          <h2 id="sc-ai-h" className="sc-part" tabIndex={-1}>
            AI second opinion <span className="sc-part__note">not a decision</span>
          </h2>
          <AiSection session={session} plan={plan} human={scorecard} report={report} view={aiView} transcript={transcript} onJumpToLine={(line) => {
            jumpToLine(line);
            goTo('transcript');
          }} />
        </section>
      )}

      {!imported && (
        <section className="sc-section no-print" aria-labelledby="sc-transcript-h">
          <h2 id="sc-transcript-h" className="sc-part" tabIndex={-1}>
            Transcript and recording
          </h2>
          <TranscriptPanel session={session} plan={plan} focusLine={focusLine} headingLevel={2} />
        </section>
      )}
    </>
  );
}

type SectionId = 'summary' | 'questions' | 'ai' | 'transcript';
const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'questions', label: 'Questions' },
  { id: 'ai', label: 'AI second opinion' },
  { id: 'transcript', label: 'Transcript and recording' },
];
