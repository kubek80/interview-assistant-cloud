import type { Scorecard } from '../../domain/scoring';
import { Badge, DocLink, Icon, formatAverage, formatPct } from '../../ui';
import { SIGNAL_LABELS, barWidth, categorySignal } from './model';

const fmtWeight = (w: number) => (Math.round(w * 100) / 100).toString();

/**
 * FLOW-24, A11Y-3, A11Y-5: horizontal bars of category percentage, labelled directly with the
 * percentage, average, weight and must-have marker. The same figures follow as a real table.
 */
export function CategoryChart({ scorecard }: { scorecard: Scorecard }) {
  return (
    <figure className="cat-chart">
      <figcaption className="cat-chart__caption">
        Category percentage (bar length, 0–100%) with average score (1–4). Text labels carry every figure; the table below
        repeats them. <DocLink req="SCORE-4" />
      </figcaption>
      <ul className="cat-chart__list" aria-hidden="true">
        {scorecard.categories.map((c) => {
          const signal = categorySignal(c);
          return (
            <li key={c.category.id} className={`cat-chart__row cat-chart__row--${signal}`}>
              <div className="cat-chart__label">
                <span className="cat-chart__name">{c.category.name}</span>
                <span className="cat-chart__meta">
                  {c.category.mustHave && (
                    <span className="cat-chart__must">
                      <Icon name="lock" /> Must-have
                    </span>
                  )}
                  <span>weight ×{fmtWeight(c.category.weight)}</span>
                  <span>
                    {c.answeredCount}/{c.plannedCount} answered
                  </span>
                </span>
              </div>
              <div className="cat-chart__track">
                {c.pct != null && <div className="cat-chart__bar" style={{ width: `${barWidth(c.pct)}%` }} />}
                <span className="cat-chart__value">
                  {c.pct == null ? 'No score' : `${formatPct(c.pct)} · avg ${formatAverage(c.average)}`}
                </span>
              </div>
              <div className="cat-chart__signal">
                {signal === 'strength' && <Icon name="check" />}
                {(signal === 'concern' || signal === 'no-evidence') && <Icon name="alert" />}
                {SIGNAL_LABELS[signal]}
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** A11Y-5: the chart's figures as a table. */
export function CategoryTable({ scorecard }: { scorecard: Scorecard }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Category figures">
      <table className="table table--compact">
        <caption>Category figures</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Must-have</th>
            <th scope="col" className="num">
              Weight
            </th>
            <th scope="col" className="num">
              Answered
            </th>
            <th scope="col" className="num">
              Percentage
            </th>
            <th scope="col" className="num">
              Average (1–4)
            </th>
            <th scope="col">Signal</th>
          </tr>
        </thead>
        <tbody>
          {scorecard.categories.map((c) => {
            const signal = categorySignal(c);
            return (
              <tr key={c.category.id}>
                <th scope="row">{c.category.name}</th>
                <td>{c.category.mustHave ? 'Yes' : 'No'}</td>
                <td className="num">×{fmtWeight(c.category.weight)}</td>
                <td className="num">
                  {c.answeredCount} of {c.plannedCount}
                </td>
                <td className="num">{formatPct(c.pct)}</td>
                <td className="num">{formatAverage(c.average)}</td>
                <td>
                  {signal === 'strength' ? (
                    <Badge tone="success" icon="check">
                      Strength
                    </Badge>
                  ) : signal === 'concern' || signal === 'no-evidence' ? (
                    <Badge tone="warning" icon="alert">
                      {SIGNAL_LABELS[signal]}
                    </Badge>
                  ) : (
                    <span className="muted">{SIGNAL_LABELS[signal] || '–'}</span>
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
