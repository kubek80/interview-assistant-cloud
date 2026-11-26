import type { Scorecard } from '../../domain/scoring';
import { scoreLabel } from '../../domain/rubric';
import { Icon, ItemText, QuestionTags, formatSeconds } from '../../ui';
import { keyPointsCovered, redFlagsSeen } from './model';
import { AI_LABEL, formatDifference, type AiReport } from '../../domain/ai/report';

const fmtWeight = (w: number) => (Math.round(w * 100) / 100).toString();

/**
 * FLOW-24: one row per planned question. All text is rendered as React text (SEC-2).
 * AI-11: with `ai`, a separate, labelled "AI second opinion" column next to the interviewers' score.
 */
export function QuestionTable({ scorecard, ai }: { scorecard: Scorecard; ai?: AiReport | null }) {
  return (
    <div className="table-wrap sc-questions" tabIndex={0} role="region" aria-label="All questions">
      <table className="table table--compact">
        <caption>All questions in interview order</caption>
        <thead>
          <tr>
            <th scope="col" className="num">
              #
            </th>
            <th scope="col">Question</th>
            <th scope="col">Category</th>
            <th scope="col">Tags</th>
            <th scope="col" className="num">
              Weight
            </th>
            <th scope="col">Score</th>
            {ai && (
              <th scope="col" className="sc-ai__col">
                {AI_LABEL} <span className="muted">(not a decision)</span>
              </th>
            )}
            <th scope="col">Key points</th>
            <th scope="col">Red flags seen</th>
            <th scope="col">Flagged</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {scorecard.questions.map((r) => {
            const kp = keyPointsCovered(r);
            const flags = redFlagsSeen(r);
            const notes = r.answer?.notes ?? [];
            return (
              <tr key={r.question.id} className={r.skipped ? 'sc-row--skipped' : undefined}>
                <td className="num">{r.index + 1}</td>
                <td className="sc-qtext">{r.question.text}</td>
                <td>
                  {r.category?.name ?? r.question.categoryId}
                  {r.category?.mustHave && <span className="muted small"> (must-have)</span>}
                </td>
                <td>
                  <QuestionTags question={r.question} />
                </td>
                <td className="num">{fmtWeight(r.weight)}</td>
                <td className="nowrap">
                  {r.skipped ? (
                    <span>
                      <Icon name="skip" /> Skipped
                    </span>
                  ) : r.score ? (
                    <span>
                      <strong>{r.score}</strong> {scoreLabel(r.score)}
                    </span>
                  ) : (
                    <span className="muted">Not scored</span>
                  )}
                </td>
                {ai && <AiCell report={ai} index={r.index} />}
                <td className="nowrap">
                  {kp.covered} of {kp.total}
                </td>
                <td className="sc-flags">
                  {flags.length ? (
                    <ul className="sc-cell-list">
                      {flags.map((f, i) => (
                        <li key={i}>
                          <ItemText text={f} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
                <td className="nowrap">
                  {r.flagged ? (
                    <span>
                      <Icon name="flag" /> Flagged
                    </span>
                  ) : (
                    <span className="muted">No</span>
                  )}
                </td>
                <td className="sc-notes">
                  {notes.length ? (
                    <ul className="sc-cell-list">
                      {notes.map((n, i) => (
                        <li key={i}>
                          <span className="mono small muted">[{formatSeconds(n.atSec)}]</span> <span className="pre-wrap">{n.text}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AiCell({ report, index }: { report: AiReport; index: number }) {
  const row = report.comparison.rows[index];
  if (!row?.ai) return <td className="sc-ai__col muted">–</td>;
  return (
    <td className="nowrap sc-ai__col">
      {row.aiCovered && row.aiScore ? (
        <>
          <strong>{row.aiScore}</strong> {scoreLabel(row.aiScore)}
          {row.difference != null && row.difference !== 0 && <span className="muted"> ({formatDifference(row.difference)})</span>}
        </>
      ) : (
        <span className="muted">Not covered</span>
      )}
    </td>
  );
}
