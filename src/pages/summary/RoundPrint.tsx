import { BAND_LABELS, formatAverage, formatPct } from '../../domain/scoring';
import { enteredLabel } from '../../domain/decision';
import { formatNames } from '../../domain/interviewers';
import { outcomeLine } from '../../domain/export';
import { STATE_LABELS, type CandidateDetail, type RoundRow } from '../../domain/round';
import { RECOMMENDATION_LABELS } from '../../domain/types';
import { formatDate } from '../../ui';

const when = (r: RoundRow) => (r.date ? `${new Date(`${r.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${r.time ? ` ${r.time}` : ''}` : '–');
const few = (xs: string[]) => (xs.length ? `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ` +${xs.length - 3} more` : ''}` : '–');
const band = (r: RoundRow) => (r.score.pct == null ? '' : r.score.insufficientEvidence ? 'Insufficient evidence' : r.score.band ? BAND_LABELS[r.score.band] : '');

/**
 * SUM-5: the round report as a printable page (PDF through the browser's print dialog): a cover
 * line, the overview table, then one page per candidate with the outcome and rationale, the
 * written summary, every judgement, categories, strongest and weakest answers, flags and skips.
 * Mounted only while printing; hidden on screen.
 */
export function RoundPrint({ items, scope, exportedBy }: { items: Array<{ row: RoundRow; detail: CandidateDetail }>; scope: string; exportedBy: string }) {
  const sets = new Set(items.map((i) => i.row.fingerprint)).size;
  return (
    <div className="print-only rp" data-testid="round-print">
      <header className="rp-cover">
        <p className="rp-title">Interview round summary</p>
        <p className="rp-sub">
          {items.length} candidate{items.length === 1 ? '' : 's'} · {scope} · prepared {formatDate(new Date().toISOString())}
          {exportedBy ? ` by ${exportedBy}` : ''}
        </p>
        <p className="rp-sub">Scores and bands are advisory: people make every decision. A panel decision is shown next to the individual figures, never instead of them.</p>
        {sets > 1 && <p className="rp-sub">These candidates were asked {sets} different question sets: scores are comparable only within the same question set.</p>}
      </header>
      <table className="rp-table">
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Date</th>
            <th>Outcome</th>
            <th>Score</th>
            <th>Strengths</th>
            <th>Concerns</th>
            <th>Still missing</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ row: r }) => (
            <tr key={r.ref}>
              <td>
                <strong>{r.name}</strong>
                {r.requisition && <div className="rp-muted">{r.requisition}</div>}
                {sets > 1 && <div className="rp-muted">{r.planName}</div>}
              </td>
              <td>{when(r)}</td>
              <td>
                <strong>{r.outcome.kind === 'none' ? '–' : r.outcome.text}</strong>
                <div className="rp-muted">{r.outcome.kind === 'decision' ? 'Panel decision' : r.outcome.kind === 'recommendations' ? (r.outcome.split ? 'Split' : 'Recommendations') : ''}</div>
              </td>
              <td>
                {r.score.pct == null ? '–' : <strong>{formatPct(r.score.pct)}</strong>}
                <div className="rp-muted">{r.score.pct == null ? '' : `${r.score.label}; ${band(r)}`}</div>
              </td>
              <td>{few(r.strengths)}</td>
              <td>{few(r.concerns)}</td>
              <td>{r.missing.join('; ') || 'Nothing'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.map(({ row: r, detail: d }) => (
        <section key={r.ref} className="rp-cand">
          <h2 className="rp-cand__name">{r.candidate}</h2>
          <p className="rp-muted">
            {r.trackName} · {r.planName} ({r.questionCount} questions) · {when(r)} · {formatNames(r.interviewers) || 'no interviewers named'} · {STATE_LABELS[r.state]}
          </p>
          <div className="rp-outcome">
            <p>
              <strong>{outcomeLine(r)}</strong>
            </p>
            {r.decision && (
              <>
                <p className="rp-why">{r.decision.rationale}</p>
                <p className="rp-muted">
                  Agreed by {formatNames(r.decision.participants)}; recorded by {r.decision.recordedBy}, {formatDate(r.decision.recordedAt)}
                  {r.decision.rating ? `; agreed rating ${r.decision.rating}` : ''}.
                </p>
              </>
            )}
            <p>
              Score: {r.score.pct == null ? 'no scores' : `${formatPct(r.score.pct)} (${r.score.label}); advisory band ${band(r) || '–'}`}
              {r.score.spreadFlag ? `; the interviewers differ by ${Math.round(r.score.spread!)} points` : ''}
            </p>
          </div>
          <h3>Written summary</h3>
          <p className="rp-why">{r.summaryText.trim() || '–'}</p>
          <h3>Judgements</h3>
          {r.judgements.length ? (
            <table className="rp-table">
              <thead>
                <tr>
                  <th>Interviewer</th>
                  <th>Recommendation</th>
                  <th>Rating</th>
                  <th>Overall</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {r.judgements.map((j) => (
                  <tr key={j.session.id}>
                    <td>
                      {formatNames(j.names)}
                      {j.entered && <div className="rp-muted">{enteredLabel(j.session)}</div>}
                    </td>
                    <td>{j.hidden ? 'Hidden' : j.recommendation ? RECOMMENDATION_LABELS[j.recommendation] : '–'}</td>
                    <td>{j.hidden ? '' : (j.session.overall.rating ?? '–')}</td>
                    <td>{j.scorecard && j.scorecard.answeredCount ? formatPct(j.scorecard.overallPct) : '–'}</td>
                    <td className="rp-why">{j.hidden ? '' : j.session.overall.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>None yet.</p>
          )}
          {d.columns.length > 0 && (
            <>
              <h3>Categories (average 1–4)</h3>
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    {d.columns.map((c) => (
                      <th key={c.label}>{c.label}</th>
                    ))}
                    <th>Panel</th>
                  </tr>
                </thead>
                <tbody>
                  {d.categories.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.name}
                        {c.mustHave ? ' (must-have)' : ''}
                      </td>
                      {c.averages.map((a, i) => (
                        <td key={i}>{formatAverage(a)}</td>
                      ))}
                      <td>
                        <strong>{formatAverage(c.figure)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {(['strongest', 'weakest'] as const).map((k) => (
            <div key={k}>
              <h3>{k === 'strongest' ? 'Strongest answers' : 'Weakest answers'}</h3>
              {d[k].length ? (
                <ul>
                  {d[k].map((h) => (
                    <li key={h.questionId}>
                      Q{h.index + 1} ({h.category}), {formatAverage(h.score)}: {h.text}
                      {h.by.some((b) => b.notes.length) && (
                        <ul>
                          {h.by
                            .filter((b) => b.notes.length)
                            .map((b) => (
                              <li key={b.names.join()}>
                                {formatNames(b.names)}: {b.notes.join(' / ')}
                              </li>
                            ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>None.</p>
              )}
            </div>
          ))}
          {(d.flagged.length > 0 || d.skipped.length > 0) && (
            <>
              <h3>Flagged and skipped questions</h3>
              <ul>
                {d.flagged.map((x) => (
                  <li key={`f${x.index}`}>
                    Flagged Q{x.index + 1} by {formatNames(x.by)}: {x.text}
                  </li>
                ))}
                {d.skipped.map((x) => (
                  <li key={`s${x.index}${x.by}`}>
                    Skipped Q{x.index + 1} by {x.by} ({x.reason}): {x.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
