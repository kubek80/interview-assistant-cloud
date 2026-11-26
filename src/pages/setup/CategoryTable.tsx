import type { PlanCategory } from '../../domain/types';
import { Badge, Checkbox, Icon } from '../../ui';

export interface CategoryRow {
  category: PlanCategory;
  count: number;
  /** Weight from the seed, shown as the default (FLOW-6). */
  defaultWeight: number | null;
  weightText: string;
  weightError: string | null;
}

/**
 * FLOW-5 coverage (selected questions per category) and FLOW-6 weight and must-have controls in
 * one table. Read-only when `readOnly` (locked plan, FLOW-8).
 */
export function CategoryTable({
  rows,
  selectedTotal,
  readOnly,
  showCoverage = true,
  onWeight,
  onMustHave,
}: {
  rows: readonly CategoryRow[];
  selectedTotal: number;
  readOnly?: boolean;
  /** FLOW-5 column; the New interview screen shows coverage in "Edit questions" instead. */
  showCoverage?: boolean;
  onWeight?: (id: string, text: string) => void;
  onMustHave?: (id: string, value: boolean) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="table-wrap">
      <table className="table table--compact cat-table pc-rtable">
        <caption className="visually-hidden">{showCoverage ? 'Questions per category, weights and must-have flags' : 'Category weights and must-have flags'}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            {showCoverage && <th scope="col">Questions</th>}
            <th scope="col">Weight</th>
            <th scope="col">Must-have</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ category: c, count, defaultWeight, weightText, weightError }) => {
            const errId = `weight-${c.id}-error`;
            const hintId = `weight-${c.id}-hint`;
            return (
              <tr key={c.id}>
                <th scope="row" data-label="Category">
                  {c.name}
                </th>
                {showCoverage && (
                <td data-label="Questions">
                  <div className="coverage">
                    <span className="coverage__count tabular">{count}</span>
                    <span className="coverage__track" aria-hidden="true">
                      <span className="coverage__bar" style={{ width: `${(count / max) * 100}%` }} />
                    </span>
                    {count === 0 && selectedTotal > 0 && (
                      <Badge tone={c.mustHave ? 'warning' : 'neutral'} icon={c.mustHave ? 'alert' : 'circle'}>
                        {c.mustHave ? 'Must-have, no questions' : 'Not covered'}
                      </Badge>
                    )}
                  </div>
                </td>
                )}
                <td data-label="Weight">
                  {readOnly ? (
                    <span className="tabular">{c.weight.toFixed(2).replace(/0$/, '')}</span>
                  ) : (
                    <div className="weight-field">
                      <input
                        id={`weight-${c.id}`}
                        className="input weight-field__input"
                        type="number"
                        inputMode="decimal"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={weightText}
                        aria-label={`Weight for ${c.name}`}
                        aria-invalid={weightError ? true : undefined}
                        aria-describedby={[weightError ? errId : null, defaultWeight !== null ? hintId : null].filter(Boolean).join(' ') || undefined}
                        onChange={(e) => onWeight?.(c.id, e.target.value)}
                      />
                      {defaultWeight !== null && (
                        <span id={hintId} className="small muted nowrap">
                          {Number(weightText) === defaultWeight ? 'default' : `default ${defaultWeight}`}
                        </span>
                      )}
                      {weightError && (
                        <span id={errId} className="field__error weight-field__error">
                          <Icon name="alert" />
                          <span>{weightError}</span>
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td data-label="Must-have">
                  {readOnly ? (
                    c.mustHave ? (
                      <Badge tone="info" icon="check">
                        Must-have
                      </Badge>
                    ) : (
                      <span className="muted">No</span>
                    )
                  ) : (
                    <Checkbox
                      checked={c.mustHave}
                      onChange={(e) => onMustHave?.(c.id, e.target.checked)}
                      label={
                        <>
                          Must-have<span className="visually-hidden"> for {c.name}</span>
                        </>
                      }
                    />
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
