import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import type { AiView, TranscriptRecord } from '../../db';
import { AI_LABEL, AI_NOT_A_DECISION, buildAiReport, compareTicks, formatDifference, isNotCandidateQuote, type AiReport, type TickComparison } from '../../domain/ai/report';
import type { AiComparisonRow } from '../../domain/ai/result';
import type { AiQuotation } from '../../domain/ai/types';
import type { Scorecard } from '../../domain/scoring';
import { scoreLabel } from '../../domain/rubric';
import type { InterviewPlan, Session } from '../../domain/types';
import { Alert, BandBadge, Badge, DocLink, Icon, ItemText, formatCoverage, formatDateTime, formatPct } from '../../ui';
import { AiRunButton } from '../transcript/TranscriptPanel';

/** AI-7…AI-12: the stored AI second opinion as a report beside (never merged with) the human scorecard. */
export function useAiReport(plan: InterviewPlan, human: Scorecard, view: AiView | undefined): AiReport | null {
  return useMemo(() => (view?.state === 'ready' ? buildAiReport(plan, human, view.record.result, view.currentTranscriptHash) : null), [plan, human, view]);
}

/**
 * AI-7, AI-8, AI-10, AI-11, AI-12: the scorecard's "AI second opinion" section. Clearly separate and
 * labelled with the model and "not a decision". Nothing here can change a human score: a
 * difference links to the usual amend step, which asks for a reason (AUD-4).
 */
export function AiSection({
  session,
  plan,
  human,
  report,
  view,
  transcript,
  onJumpToLine,
}: {
  session: Session;
  plan: InterviewPlan;
  human: Scorecard;
  report: AiReport | null;
  view: AiView | undefined;
  transcript: TranscriptRecord | null | undefined;
  onJumpToLine: (line: number) => void;
}) {
  // Print shows every question's rationale and evidence, not just the open ones.
  useEffect(() => {
    const open = () => document.querySelectorAll<HTMLDetailsElement>('.sc-ai details').forEach((d) => (d.open = true));
    window.addEventListener('beforeprint', open);
    return () => window.removeEventListener('beforeprint', open);
  }, []);

  if (!report) {
    return (
      <div className="stack">
        <p>
          No AI second opinion has been run for this interview. It scores the transcript with the same questions and rubric, as an advisory second opinion
          shown beside the interviewers’ scores. <DocLink req="AI-11" />
        </p>
        <div className="no-print">
          <AiRunButton session={session} plan={plan} transcript={transcript} />
        </div>
        {view === undefined && <span className="visually-hidden">Loading</span>}
      </div>
    );
  }

  const { result, aiScorecard: ai, comparison } = report;
  const answers = new Map(human.questions.map((q) => [q.question.id, q.answer]));
  return (
    <div className="sc-ai stack">
      <div className="sc-ai__label">
        <Badge tone="info" icon="steer">
          {AI_LABEL}
        </Badge>
        <span>
          <strong>{result.model}</strong> · {AI_NOT_A_DECISION} · run {formatDateTime(result.createdAt)}
        </span>
      </div>
      <p className="small">
        Scored by {result.model} from the transcript, with the same questions and rubric as the interviewers. It is advisory: it never changes a human
        score, the panel score, the advisory band or the recorded recommendation, and it is not counted in the panel median or spread.{' '}
        <DocLink req="AI-10" />
      </p>
      {report.outOfDate && (
        <Alert tone="warning" title="Out of date: the transcript has changed since this was run.">
          <p>
            These results are based on an earlier transcript (fingerprint <span className="mono">{result.transcriptHash.slice(0, 12)}</span>). Run it again to
            update them. <DocLink req="AI-8" />
          </p>
          <div className="no-print">
            <AiRunButton session={session} plan={plan} transcript={transcript} />
          </div>
        </Alert>
      )}
      {result.unverifiedQuoteCount > 0 && (
        <Alert tone="warning" title={`${result.unverifiedQuoteCount} quotation${result.unverifiedQuoteCount === 1 ? ' was' : 's were'} not found in the transcript.`}>
          <p>
            Unverified quotations are marked below. Treat the evidence behind them with care. <DocLink req="AI-6" />
          </p>
        </Alert>
      )}

      <div className="table-wrap sc-ai__figures-wrap" tabIndex={0} role="region" aria-label="Interviewers and AI figures">
        <table className="table sc-ai__figures">
          <caption>Interviewers’ figures and the {AI_LABEL}, side by side (not combined)</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Figure</span>
              </th>
              <th scope="col">Interviewers</th>
              <th scope="col" className="sc-ai__col">
                {AI_LABEL}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Overall</th>
              <td className="tabular">{formatPct(human.overallPct)}</td>
              <td className="tabular sc-ai__col">{formatPct(ai.overallPct)}</td>
            </tr>
            <tr>
              <th scope="row">Coverage</th>
              <td className="tabular">{formatCoverage(human.coverage)}</td>
              <td className="tabular sc-ai__col">
                {formatCoverage(ai.coverage)}
              </td>
            </tr>
            <tr>
              <th scope="row">Advisory band</th>
              <td>
                <BandBadge band={human.band} insufficientEvidence={human.insufficientEvidence} capped={human.capApplied} />
              </td>
              <td className="sc-ai__col">
                <BandBadge band={ai.band} insufficientEvidence={ai.insufficientEvidence} capped={ai.capApplied} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        The AI’s percentage and band use the same maths as a human scorecard; a question “not covered in the transcript” counts as skipped. <DocLink req="AI-7" />
      </p>

      <section className="sc-ai__discuss" aria-labelledby="sc-ai-discuss-h">
        <h3 id="sc-ai-discuss-h">Worth discussing ({comparison.worthDiscussing.length})</h3>
        <p className="small muted">Questions where the AI and the interviewers differ by two points or more, with the AI’s evidence.</p>
        {comparison.worthDiscussing.length ? (
          <ul className="sc-ai__discuss-list">
            {comparison.worthDiscussing.map((r) => (
              <li key={r.question.id} className="sc-ai__discuss-item">
                <p>
                  <strong>Q{r.index + 1}.</strong> {r.question.text}
                </p>
                <p className="small">
                  Interviewers <strong>{r.humanScore}</strong> · {AI_LABEL} <strong>{r.aiScore}</strong> ({formatDifference(r.difference)})
                </p>
                {r.ai?.rationale && <p className="small pre-wrap">{r.ai.rationale}</p>}
                <Quotes quotes={r.ai?.quotes ?? []} onJumpToLine={onJumpToLine} />
                {session.origin === 'local' && (
                  <p className="small no-print">
                    <Link to={`/interview/${session.id}?amend=${encodeURIComponent(r.question.id)}`}>
                      <Icon name="edit" /> Changed your mind? Amend Q{r.index + 1} (reason required)
                    </Link>
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>None: the AI and the interviewers are within one point on every question both scored.</p>
        )}
      </section>

      <section aria-labelledby="sc-ai-q-h" className="stack-sm">
        <h3 id="sc-ai-q-h">Per question</h3>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Scores per question">
          <table className="table table--compact">
            <caption>Interviewers’ score and the {AI_LABEL} score for each question</caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">Question</th>
                <th scope="col">Interviewers</th>
                <th scope="col" className="sc-ai__col">
                  {AI_LABEL}
                </th>
                <th scope="col" className="num">
                  Difference
                </th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((r) => {
                const h = human.questions[r.index];
                return (
                  <tr key={r.question.id}>
                    <td className="num">{r.index + 1}</td>
                    <td className="sc-qtext">{r.question.text}</td>
                    <td className="nowrap">{h?.skipped ? 'Skipped' : r.humanScore ? `${r.humanScore} ${scoreLabel(r.humanScore)}` : '–'}</td>
                    <td className="nowrap sc-ai__col">{r.aiCovered && r.aiScore ? `${r.aiScore} ${scoreLabel(r.aiScore)}` : <span className="muted">Not covered</span>}</td>
                    <td className="num">
                      {formatDifference(r.difference) ?? '–'}
                      {r.worthDiscussing && (
                        <>
                          {' '}
                          <Badge tone="warning" icon="alert">
                            Discuss
                          </Badge>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="sc-ai__details">
          {comparison.rows.map((r) => (
            <QuestionDetails key={r.question.id} row={r} answer={answers.get(r.question.id)} onJumpToLine={onJumpToLine} />
          ))}
        </div>
      </section>
    </div>
  );
}

function QuestionDetails({ row, answer, onJumpToLine }: { row: AiComparisonRow; answer: { coveredKeyPoints: number[]; redFlagsSeen: number[] } | undefined; onJumpToLine: (line: number) => void }) {
  const ticks = compareTicks(row, answer);
  const q = row.ai;
  return (
    <details className="sc-ai__q">
      <summary>
        <strong>Q{row.index + 1}</strong> · {row.aiCovered ? `AI ${row.aiScore}` : 'not covered in the transcript'}
        {row.humanScore ? ` · interviewers ${row.humanScore}` : ''} · rationale and evidence
      </summary>
      <div className="stack-sm sc-ai__q-body">
        <p className="small">{row.question.text}</p>
        {q && <p className="pre-wrap">{q.rationale}</p>}
        <TickTable title="Key points" items={ticks.keyPoints} aiWord="judged covered" />
        {ticks.redFlags.length > 0 && <TickTable title="Red flags" items={ticks.redFlags} aiWord="judged present" />}
        <Quotes quotes={q?.quotes ?? []} onJumpToLine={onJumpToLine} />
      </div>
    </details>
  );
}

function TickTable({ title, items, aiWord }: { title: string; items: TickComparison[]; aiWord: string }) {
  if (!items.length) return null;
  const mark = (on: boolean, yes: string) => (
    <span className={on ? 'sc-ai__tick sc-ai__tick--on' : 'sc-ai__tick'}>
      <Icon name={on ? 'check' : 'circle'} /> {on ? yes : 'No'}
    </span>
  );
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={`${title}: interviewers and AI`}>
      <table className="table table--compact sc-ai__ticks">
        <caption>{title}: ticked by the interviewers and as {aiWord} by the AI</caption>
        <thead>
          <tr>
            <th scope="col">{title.replace(/s$/, '')}</th>
            <th scope="col">Interviewers</th>
            <th scope="col" className="sc-ai__col">
              AI
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.index}>
              <td className="sc-ai__item">
                <ItemText text={t.text} />
              </td>
              <td className="nowrap">{mark(t.human, 'Ticked')}</td>
              <td className="nowrap sc-ai__col">{mark(t.ai, 'Yes')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** AI-6: quotations with verified/unverified status, whose words they are, and a jump to the line. */
function Quotes({ quotes, onJumpToLine }: { quotes: AiQuotation[]; onJumpToLine: (line: number) => void }) {
  if (!quotes.length) return null;
  return (
    <ul className="sc-ai__quotes" aria-label="Quotations from the transcript">
      {quotes.map((q, i) => (
        <li key={i} className="sc-ai__quote">
          <q>{q.text}</q>{' '}
          {q.status === 'verified' ? (
            <>
              <Badge tone="success" icon="check">
                Verified
              </Badge>{' '}
              <span className="small muted">{q.speaker ?? 'no speaker'}</span>
              {isNotCandidateQuote(q) && (
                <>
                  {' '}
                  <Badge tone="warning" icon="alert">
                    Not the candidate’s words
                  </Badge>
                </>
              )}
              {q.line != null && (
                <>
                  {' '}
                  <button type="button" className="sc-ai__jump no-print" onClick={() => onJumpToLine(q.line!)}>
                    Line {q.line}
                  </button>
                  <span className="print-only small"> (line {q.line})</span>
                </>
              )}
            </>
          ) : (
            <Badge tone="danger" icon="alert">
              Unverified: not found in the transcript
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
