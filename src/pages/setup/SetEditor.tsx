import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { categoryCoverage, filterQuestions, timeMeter, type Quotas } from '../../domain/plan';
import { QUESTION_TYPES, type PlanCategory, type Question, type QuestionType } from '../../domain/types';
import type { TrackBank } from '../../db';
import { Badge, Button, Field, Icon, IconButton, Meter, Select, TextInput } from '../../ui';
import { QuestionFilters } from '../bank/QuestionFilters';
import { EMPTY_FILTERS, resultSummary, toQuestionFilter, type FilterState } from '../bank/filters';
import { MIX_LABEL, mixRange, questionMeta } from './logic';
import { SelectedList } from './SelectedList';

type Tab = 'add' | 'mix' | 'coverage';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'add', label: 'Add questions' },
  { id: 'mix', label: 'Change the mix' },
  { id: 'coverage', label: 'Coverage' },
];

export interface SetEditorProps {
  questions: readonly Question[];
  bank: TrackBank | null | undefined;
  categories: readonly PlanCategory[];
  budgetText: string;
  budgetError: string | null;
  onBudget: (text: string) => void;
  onMoveTo: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onToggle: (id: string) => void;
  onOpen: (q: Question) => void;
  quotas: Quotas;
  onQuotas: (q: Quotas) => void;
  drawFrom: string;
  onDrawFrom: (categoryId: string) => void;
  onRedraw: () => void;
  busy: boolean;
  onDone: () => void;
}

/**
 * UX-3: "Edit questions", in place on the New interview screen. The selected questions are the
 * main list (interview order, reorder, remove, peek). Secondary, in tabs beside it: add questions
 * from the bank with search and the FLOW-2 filters; change the mix (FLOW-3 quotas in plain words)
 * and draw again; and the category coverage (FLOW-5). The time budget and meter (FLOW-4) head the list.
 */
export function SetEditor(p: SetEditorProps) {
  const [tab, setTab] = useState<Tab>('add');
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const budget = Number(p.budgetText) || 0;
  const meter = timeMeter(p.questions, budget);
  const catName = useMemo(() => {
    const m = new Map(p.categories.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? '';
  }, [p.categories]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current.get(TABS[next].id)?.focus();
  };

  return (
    <div className="set-editor" id="set-editor">
      <section className="set-editor__main" aria-labelledby="set-editor-title">
        <div className="set-editor__head">
          <h3 id="set-editor-title" tabIndex={-1}>
            In interview order
          </h3>
        </div>
        <div className="set-editor__time">
          <Field label="Time budget (minutes)" error={p.budgetError} className="set-editor__budget">
            <TextInput id="set-budget" type="number" inputMode="numeric" min={5} max={600} step={5} value={p.budgetText} onChange={(e) => p.onBudget(e.target.value)} />
          </Field>
          <Meter
            label="Estimated time"
            value={meter.totalMin}
            max={Math.max(meter.budgetMin, meter.totalMin, 1)}
            valueText={`${meter.totalMin} of ${meter.budgetMin} min`}
            tone={meter.over ? 'danger' : 'success'}
            status={
              meter.over ? (
                <strong className="pc-danger">
                  <Icon name="alert" /> {meter.totalMin - meter.budgetMin} min over the budget
                </strong>
              ) : (
                `${meter.budgetMin - meter.totalMin} min to spare`
              )
            }
          />
        </div>
        {p.questions.length === 0 ? (
          <p className="set-editor__empty">
            <Icon name="info" /> No questions yet. Add some from the bank, or draw a set with “Change the mix”.
          </p>
        ) : (
          <SelectedList questions={p.questions} categoryName={catName} onMoveTo={p.onMoveTo} onRemove={p.onRemove} onOpen={p.onOpen} emptyFocusId="set-editor-title" />
        )}
        <p className="small muted set-editor__hint">Drag a question by its grip, or use the arrows, to change the order.</p>
        <Button className="set-editor__done" onClick={p.onDone} icon="check">
          Done
        </Button>
      </section>

      <div className="set-editor__side">
        <div className="tabs" role="tablist" aria-label="More ways to change the questions">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
              }}
              type="button"
              role="tab"
              id={`set-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`set-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tabs__tab"
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`} className="tabs__panel">
          {tab === 'add' && <AddQuestions bank={p.bank} categories={p.categories} selected={p.questions} onToggle={p.onToggle} onOpen={p.onOpen} />}
          {tab === 'mix' && (
            <ChangeMix
              bank={p.bank}
              categories={p.categories}
              quotas={p.quotas}
              onQuotas={p.onQuotas}
              drawFrom={p.drawFrom}
              onDrawFrom={p.onDrawFrom}
              onRedraw={p.onRedraw}
              busy={p.busy}
              selectedCount={p.questions.length}
            />
          )}
          {tab === 'coverage' && <Coverage categories={p.categories} questions={p.questions} />}
        </div>
      </div>
    </div>
  );
}

/** UX-3, FLOW-2, FLOW-3: search and filter the bank; tick to add to the end, untick to remove. */
function AddQuestions({
  bank,
  categories,
  selected,
  onToggle,
  onOpen,
}: {
  bank: TrackBank | null | undefined;
  categories: readonly PlanCategory[];
  selected: readonly Question[];
  onToggle: (id: string) => void;
  onOpen: (q: Question) => void;
}) {
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS });
  const [showFilters, setShowFilters] = useState(false);
  const pool = useMemo(() => filterQuestions(bank?.questions ?? [], toQuestionFilter(filters)), [bank, filters]);
  const total = useMemo(() => (bank?.questions ?? []).filter((q) => q.status !== 'retired').length, [bank]);
  const chosen = useMemo(() => new Set(selected.map((q) => q.id)), [selected]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  if (!bank) return <p className="muted">Loading the question bank…</p>;
  return (
    <div className="stack-sm">
      <Field label="Search the bank">
        <TextInput id="add-search" type="search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} autoComplete="off" />
      </Field>
      <div className="spread">
        <Button size="sm" variant="ghost" icon="chevron-down" aria-expanded={showFilters} aria-controls="add-filters" onClick={() => setShowFilters(!showFilters)}>
          Filter by category, difficulty or type
        </Button>
        <span className="small muted" role="status" aria-live="polite" aria-atomic="true">
          {resultSummary(pool.length, total)}
        </span>
      </div>
      <div id="add-filters" hidden={!showFilters}>
        {showFilters && <QuestionFilters idPrefix="add" value={{ ...filters }} onChange={setFilters} categories={categories} layout="stacked" />}
      </div>
      {pool.length === 0 ? (
        <p className="muted small">No questions match. Clear the search or a filter.</p>
      ) : (
        <ul className="add-list" aria-label="Questions in the bank">
          {pool.map((q) => (
            <li key={q.id} className={`add-item${chosen.has(q.id) ? ' add-item--chosen' : ''}`} data-question={q.number}>
              <label className="add-item__label">
                <input type="checkbox" checked={chosen.has(q.id)} onChange={() => onToggle(q.id)} />
                <span>
                  <span className="add-item__text">{q.text}</span>
                  <span className="add-item__meta">{questionMeta(q, catName.get(q.categoryId) ?? '')}</span>
                </span>
              </label>
              <IconButton icon="eye" size="sm" label={`Look at question: ${q.text.slice(0, 60)}`} onClick={() => onOpen(q)} aria-haspopup="dialog" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** FLOW-3 in plain words: how many of each kind, and draw a new set with that mix. */
function ChangeMix({
  bank,
  categories,
  quotas,
  onQuotas,
  drawFrom,
  onDrawFrom,
  onRedraw,
  busy,
  selectedCount,
}: {
  bank: TrackBank | null | undefined;
  categories: readonly PlanCategory[];
  quotas: Quotas;
  onQuotas: (q: Quotas) => void;
  drawFrom: string;
  onDrawFrom: (id: string) => void;
  onRedraw: () => void;
  busy: boolean;
  selectedCount: number;
}) {
  const active = (bank?.questions ?? []).filter((q) => q.status !== 'retired' && (!drawFrom || q.categoryId === drawFrom));
  const available = (t: QuestionType) => active.filter((q) => q.type === t).length;
  const total = QUESTION_TYPES.reduce((n, t) => n + quotas[t], 0);
  return (
    <div className="stack">
      <p className="small muted">How many of each kind to draw. The draw spreads the questions across the role’s categories.</p>
      <ul className="mix" aria-label="Mix of questions">
        {QUESTION_TYPES.map((t) => {
          const [min, max] = mixRange(t);
          const n = quotas[t];
          const set = (v: number) => onQuotas({ ...quotas, [t]: Math.max(min, Math.min(max, v)) });
          const id = `mix-${t}`;
          return (
            <li key={t} className="mix__row">
              <span className="mix__label" id={`${id}-label`}>
                {MIX_LABEL[t]}
                <span className="mix__hint">
                  {t === 'knowledge' ? `${min} to ${max} keeps interviews comparable · ` : ''}
                  {available(t)} in the bank
                </span>
              </span>
              <span className="stepper" role="group" aria-labelledby={`${id}-label`}>
                <IconButton icon="minus" size="sm" label={`Fewer ${MIX_LABEL[t].toLowerCase()}`} onClick={() => set(n - 1)} disabled={n <= min} />
                <output id={id} className="stepper__value" aria-live="polite">
                  {n}
                </output>
                <IconButton icon="plus" size="sm" label={`More ${MIX_LABEL[t].toLowerCase()}`} onClick={() => set(n + 1)} disabled={n >= max} />
              </span>
            </li>
          );
        })}
      </ul>
      <Field label="Draw from">
        <Select id="mix-from" value={drawFrom} onChange={(e) => onDrawFrom(e.target.value)} placeholder="All categories" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      <div className="cluster">
        <Button icon="shuffle" onClick={onRedraw} disabled={busy}>
          Draw {total} questions
        </Button>
        {selectedCount > 0 && <span className="small muted">Replaces the current {selectedCount}. You can undo.</span>}
      </div>
    </div>
  );
}

/** FLOW-5: how many selected questions fall in each category. */
function Coverage({ categories, questions }: { categories: readonly PlanCategory[]; questions: readonly Question[] }) {
  const rows = categoryCoverage(categories, questions);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="stack-sm">
      <p className="small muted">
        {rows.filter((r) => r.count > 0).length} of {rows.length} categories have a question.
      </p>
      <table className="table table--compact coverage-table">
        <caption className="visually-hidden">Questions per category</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col" className="num">
              Questions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ category: c, count }) => (
            <tr key={c.id}>
              <th scope="row">
                {c.name}
                {c.mustHave && (
                  <>
                    {' '}
                    <Badge tone="info">Must-have</Badge>
                  </>
                )}
              </th>
              <td className="num">
                <span className="coverage">
                  <span className="coverage__track" aria-hidden="true">
                    <span className="coverage__bar" style={{ width: `${(count / max) * 100}%` }} />
                  </span>
                  <span className="coverage__count tabular">{count}</span>
                  {count === 0 && (
                    <Badge tone={c.mustHave ? 'warning' : 'neutral'} icon={c.mustHave ? 'alert' : 'circle'}>
                      {c.mustHave ? 'Must-have, none yet' : 'None'}
                    </Badge>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
