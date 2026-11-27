import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { recordExported, useScorecard } from '../db';
import { formatCandidateKey, shortFingerprint } from '../domain/plan';
import { scoreLabel } from '../domain/rubric';
import { computeScorecard, type Scorecard as ScorecardResult } from '../domain/scoring';
import { scorecardCsv, scorecardMarkdown, exportFileName } from '../domain/export';
import { toDomainAnswers } from '../domain/live';
import { RECOMMENDATION_LABELS, type InterviewPlan, type Session } from '../domain/types';
import type { ScorecardData } from '../shared/api';
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
import { toPlan, toSession } from './interview/liveModel';
import { interviewersLabel, interviewersOf } from '../domain/interviewers';
import '../styles/pages/scorecard.css';
import '../styles/pages/print.css';

/**
 * Route: /scorecard/:recordId (FLOW-24, FLOW-25, FLOW-31, FLOW-32, SCORE-1…SCORE-10, LIVE-3). One panel
 * member's record, worked out by the scoring module unchanged. Its owner sees it always; the rest of
 * the round once it is submitted, and when the round hides scores, once their own is submitted too
 * (the server decides). The side-by-side debrief is a separate screen.
 */
export default function Scorecard() {
  const { recordId } = useParams();
  const data = useScorecard(recordId);
  useDocumentTitle('Scorecard');
  const { title, subtitle, actions, body } = scorecardContent(data);
  return (
    <div className="scorecard">
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {body}
    </div>
  );
}

function scorecardContent(data: ScorecardData | null | 'hidden' | undefined): { title: string; subtitle?: string; actions?: ReactNode; body: ReactNode } {
  if (data === undefined) {
    return {
      title: 'Scorecard',
      body: (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ),
    };
  }
  if (data === 'hidden') {
    return {
      title: 'Scorecard',
      body: (
        <Alert tone="info" title="Hidden until you have submitted yours.">
          <p>
            This round has interviewers rate independently, so other people’s scores are shown once your own record of this interview is submitted. <DocLink req="LIVE-3" />
          </p>
        </Alert>
      ),
    };
  }
  if (data === null) {
    return {
      title: 'Scorecard',
      body: <EmptyState title="This scorecard was not found, is not submitted yet, or is in a round you are not on." actions={<Link to="/">Go to the Dashboard</Link>} />,
    };
  }
  const { record, interview } = data;
  const key = formatCandidateKey({ initials: interview.candidate.name, requisitionId: interview.candidate.requisitionId });
  if (record.state !== 'submitted') {
    return {
      title: 'Scorecard',
      subtitle: `Candidate ${key}`,
      body: (
        <Alert tone="info" title="The scorecard is available once the record is submitted.">
          <p>
            Finish the interview first: score or skip every question, then give an overall rating, recommendation and rationale. <DocLink req="FLOW-22" />
          </p>
          <p>
            <Link to={`/interviews/${interview.id}/live`}>Back to the interview</Link>
          </p>
        </Alert>
      ),
    };
  }
  return {
    title: `Scorecard: ${key}`,
    subtitle: `${data.mine ? '' : `${record.names.join(', ')} · `}Submitted ${formatDateTime(record.submittedAt)}`,
    actions: <ScorecardActions data={data} />,
    body: <ScorecardBody data={data} />,
  };
}

function useModel(data: ScorecardData) {
  return useMemo(() => {
    const plan = toPlan(data.interview.set);
    const session = toSession(data.interview, data.record, null, data.startedAt);
    const answers = toDomainAnswers(data.record, data.record.id, data.elapsedSec);
    return { plan, session, scorecard: computeScorecard(plan, answers) };
  }, [data]);
}

/** UX-9: one primary (back to the interview's page, with the panel); the exports in one menu (FLOW-31, FLOW-32). */
function ScorecardActions({ data }: { data: ScorecardData }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { plan, session, scorecard } = useModel(data);
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
      // FLOW-32: recorded in the audit log before the file is given out.
      await recordExported(data.record.id, format);
      if (format === 'markdown') downloadFile(exportFileName('scorecard', data.record.id.slice(0, 8), 'md'), 'text/markdown', scorecardMarkdown(plan, session, scorecard));
      else downloadFile(exportFileName('scorecard', data.record.id.slice(0, 8), 'csv'), 'text/csv', scorecardCsv(scorecard));
      toast(`Scorecard exported as ${format === 'markdown' ? 'Markdown' : 'CSV'}. The export is recorded in the audit log.`, 'success');
    });
  const print = () =>
    run(async () => {
      await recordExported(data.record.id, 'print');
      window.print();
    });
  const exportItems: MenuItem[] = [
    { label: 'Markdown', icon: 'download', onSelect: () => void exportFile('markdown') },
    { label: 'CSV, one row per question', icon: 'download', onSelect: () => void exportFile('csv') },
    { label: 'Print or save as PDF', icon: 'doc', onSelect: () => void print() },
  ];
  return (
    <>
      {data.mine && (
        <Link className={buttonClass('ghost')} to={`/interviews/${data.interview.id}/live`}>
          <Icon name="edit" /> Amend (reason required)
        </Link>
      )}
      <MenuButton label="Export" items={exportItems.map((i) => ({ ...i, disabled: busy }))} />
      <Link className={buttonClass('primary')} to={`/interviews/${data.interview.id}`}>
        The interview and its panel <Icon name="arrow-right" />
      </Link>
    </>
  );
}

function ScorecardBody({ data }: { data: ScorecardData }) {
  const { plan, session, scorecard } = useModel(data);
  return <ScorecardView session={session} plan={plan} scorecard={scorecard} trackName={data.interview.trackName} setName={data.interview.set.name} />;
}

type SectionId = 'summary' | 'questions';
const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'questions', label: 'Questions' },
];

function ScorecardView({ session, plan, scorecard, trackName, setName }: { session: Session; plan: InterviewPlan; scorecard: ScorecardResult; trackName: string; setName: string }) {
  const key = formatCandidateKey(session.candidate);
  const cap = capNote(scorecard);
  const names = interviewersOf(session);
  const goTo = useCallback((id: SectionId) => {
    const h = document.getElementById(`sc-${id}-h`);
    if (!h) return;
    h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }, []);

  return (
    <>
      <nav className="sc-nav no-print" aria-label="Scorecard sections">
        <span className="small muted">On this page:</span>
        <ul>
          {SECTIONS.map((x) => (
            <li key={x.id}>
              <button type="button" className="sc-nav__link" onClick={() => goTo(x.id)}>
                {x.label}
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
          <dt>{names.length > 1 ? 'Interviewers' : 'Interviewer'}</dt>
          <dd>
            {interviewersLabel(session)}
            {names.length > 1 && <span className="muted small"> (one shared scorecard)</span>}
          </dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{formatDate(session.startedAt ?? session.createdAt)}</dd>
        </div>
        <div>
          <dt>Questions</dt>
          <dd>{setName}</dd>
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

      <section className="sc-summary" aria-labelledby="sc-summary-h">
        <Card className="sc-figure" title="Overall" level={3}>
          <p className="sc-big tabular" data-testid="sc-overall">
            {formatPct(scorecard.overallPct)}
          </p>
          <p className="small">
            Weighted over {scorecard.answeredCount} of {scorecard.plannedCount} answered questions. <DocLink req="SCORE-3" />
          </p>
          <p className="small">
            Coverage <strong className="tabular" data-testid="sc-coverage">{formatCoverage(scorecard.coverage)}</strong> of planned weight (70% needed for a band). <DocLink req="SCORE-6" />
          </p>
        </Card>

        <Card className="sc-figure" title="Advisory band" level={3}>
          <p data-testid="sc-band">
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

        <Card className="sc-figure sc-decision" title={names.length > 1 ? 'Interviewers’ decision' : 'Interviewer’s decision'} level={3}>
          <dl className="sc-decision__list">
            <div>
              <dt>Recommendation</dt>
              <dd>
                <strong data-testid="sc-recommendation">{session.overall.recommendation ? RECOMMENDATION_LABELS[session.overall.recommendation] : '–'}</strong>
              </dd>
            </div>
            <div>
              <dt>Overall rating</dt>
              <dd>{session.overall.rating ? `${session.overall.rating} – ${scoreLabel(session.overall.rating)}` : '–'}</dd>
            </div>
          </dl>
          <p className="small muted">
            Recorded by {interviewersLabel(session)}
            {names.length > 1 ? ', on behalf of all of them' : ''}. <DocLink req="FLOW-25" />
          </p>
        </Card>
      </section>

      <section className="sc-rationale" aria-labelledby="sc-rationale-h">
        <h2 id="sc-rationale-h">Rationale</h2>
        {session.overall.rationale.trim() ? <p className="pre-wrap sc-rationale__text">{session.overall.rationale}</p> : <p className="muted">None given.</p>}
      </section>

      {scorecard.insufficientEvidence && (
        <Alert tone="warning" title="Insufficient evidence: no band is shown.">
          <p>
            Only {formatCoverage(scorecard.coverage)} of the planned question weight was answered; at least 70% is needed. The percentage is still shown. <DocLink req="SCORE-6" />
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
            <ul className="sc-list" data-testid="sc-strengths">
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
            <ul className="sc-list" data-testid="sc-concerns">
              {scorecard.concerns.map((c) => (
                <li key={c.category.id}>
                  <Icon name="alert" /> {c.category.name}{' '}
                  <span className="muted">{c.reason === 'no-evidence' ? '(must-have, no evidence: no answered questions)' : `(average ${formatAverage(c.average)})`}</span>
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
        <QuestionTable scorecard={scorecard} />
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
                  <Icon name="flag" /> <strong>Q{r.index + 1}.</strong> {r.question.text} {r.skipped ? <Badge tone="warning">Skipped</Badge> : r.score ? <span className="muted">(score {r.score})</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </Card>
      </section>

      <p className="sc-footnote small muted">
        The band is advisory. People record every score and the final decision. Percentages are rounded to whole numbers and averages to one decimal place; thresholds use unrounded values.{' '}
        <DocLink req="SCORE-10" className="no-print" />
      </p>
    </>
  );
}
