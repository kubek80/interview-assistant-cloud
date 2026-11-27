import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTrackBank } from '../../db';
import { DEFAULT_QUOTAS, drawBalanced, filterQuestions, totalTimeMin, type Quotas, type UnmetQuota } from '../../domain/plan';
import type { PlanCategory, Question } from '../../domain/types';
import { Button, DocLink, Icon, useToast } from '../../ui';
import { QuestionDetailDialog } from '../bank/QuestionDetail';
import { CategoryTable } from '../setup/CategoryTable';
import { SetEditor } from '../setup/SetEditor';
import { mixInWords, moveTo, parseBudget, parseWeight, shortfallInWords, toggleSelected } from '../setup/logic';
import '../../styles/pages/setup.css';

/** The editable parts of a question set (FLOW-3…FLOW-6). */
export interface SetDraft {
  ids: string[];
  categories: PlanCategory[];
  budget: number;
}

export function draftOf(set: { questions: readonly Question[]; categories: readonly PlanCategory[]; timeBudgetMin: number }): SetDraft {
  return { ids: set.questions.map((q) => q.id), categories: set.categories.map((c) => ({ ...c })), budget: set.timeBudgetMin };
}

export function sameDraft(a: SetDraft, b: SetDraft): boolean {
  return a.ids.join('|') === b.ids.join('|') && a.budget === b.budget && a.categories.map((c) => `${c.id}:${c.weight}:${c.mustHave}`).join('|') === b.categories.map((c) => `${c.id}:${c.weight}:${c.mustHave}`).join('|');
}

/**
 * ROUND-3, FLOW-33, UX-2, UX-3: a question set shown as a summary (how many, how long against the
 * budget, the mix in words) with Shuffle and "Edit questions" in place: the selected questions as
 * the main list (reorder by drag or keyboard, remove), adding from the bank with search and filters,
 * changing the mix, coverage, the time budget and meter; category weights and must-have under
 * "Weights". The same panel edits a round's set and an interview's own set. One implementation of
 * the draw (src/domain/plan.ts drawBalanced), here in the browser and on the server at round creation.
 */
export function QuestionSetPanel({
  trackId,
  value,
  snapshot,
  onChange,
  readOnly,
  title = 'Questions',
  note,
  idPrefix = 'set',
  startEditing = false,
}: {
  trackId: string;
  value: SetDraft;
  /** Questions as stored in the set (kept even if the bank has changed or retired them). */
  snapshot: readonly Question[];
  onChange: (next: SetDraft) => void;
  readOnly?: boolean;
  title?: ReactNode;
  /** A line under the summary, e.g. the comparison code or whether the set is fixed. */
  note?: ReactNode;
  idPrefix?: string;
  startEditing?: boolean;
}) {
  const bank = useTrackBank(trackId);
  const { announce, toast } = useToast();
  const [editing, setEditing] = useState(startEditing);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [detail, setDetail] = useState<Question | null>(null);
  const [quotas, setQuotas] = useState<Quotas>({ ...DEFAULT_QUOTAS });
  const [drawFrom, setDrawFrom] = useState('');
  const [unmet, setUnmet] = useState<UnmetQuota[]>([]);
  const [undo, setUndo] = useState<{ draft: SetDraft; message: string } | null>(null);
  const [budgetText, setBudgetText] = useState(String(value.budget));
  const [weightText, setWeightText] = useState<Record<string, string>>({});
  useEffect(() => setBudgetText(String(value.budget)), [value.budget]);

  const byId = useMemo(() => {
    const m = new Map<string, Question>(snapshot.map((q) => [q.id, q]));
    // Questions added from the bank are shown as the bank has them; the server takes the snapshot.
    for (const q of bank?.questions ?? []) if (!m.has(q.id)) m.set(q.id, q);
    return m;
  }, [bank, snapshot]);
  const selected = useMemo(() => value.ids.map((id) => byId.get(id)).filter((q): q is Question => !!q), [value.ids, byId]);
  const budget = parseBudget(budgetText);
  const minutes = totalTimeMin(selected);
  const over = minutes - value.budget;
  const defaults = useMemo(() => new Map((bank?.categories ?? []).map((c) => [c.id, c])), [bank]);
  const changedCats = value.categories.filter((c) => {
    const d = defaults.get(c.id);
    return d && (d.weight !== c.weight || d.mustHave !== c.mustHave);
  });
  const mustHave = value.categories.filter((c) => c.mustHave).map((c) => c.name);

  const setIds = (ids: string[]) => onChange({ ...value, ids });
  const shuffle = (message: string) => {
    if (!bank) return;
    const pool = filterQuestions(bank.questions, drawFrom ? { categoryIds: [drawFrom] } : {});
    const draw = drawBalanced(pool, quotas, value.budget, Math.floor(Math.random() * 2 ** 31));
    if (!draw.questions.length) {
      toast('There are no questions to draw from.', 'error');
      return;
    }
    setUndo({ draft: value, message });
    setUnmet(draw.unmet);
    onChange({ ...value, ids: draw.questions.map((q) => q.id) });
    announce(`${message} ${draw.questions.length} questions.`);
  };
  const onWeight = (id: string, text: string) => {
    setWeightText((w) => ({ ...w, [id]: text }));
    const w = parseWeight(text);
    if (w.value !== null) onChange({ ...value, categories: value.categories.map((c) => (c.id === id ? { ...c, weight: w.value! } : c)) });
  };

  return (
    <section className="ni-set qs-panel" aria-labelledby={`${idPrefix}-title`}>
      <div className="ni-set__row">
        <div className="ni-set__text" aria-live="polite">
          <h2 id={`${idPrefix}-title`} className="ni-label">
            {title}
          </h2>
          <p className="ni-set__count" data-testid="set-summary">
            <strong>
              {selected.length} question{selected.length === 1 ? '' : 's'}
            </strong>{' '}
            · about {minutes} min{' '}
            {over > 0 ? (
              <span className="ni-over">
                <Icon name="alert" /> {over} min over the {value.budget}-minute budget
              </span>
            ) : (
              <span className="muted">of {value.budget}</span>
            )}
          </p>
          <p className="ni-set__mix">
            {mixInWords(selected)}
            {mustHave.length > 0 && <> · must-have: {mustHave.join(', ')}</>}
          </p>
          {note}
        </div>
        {!readOnly && (
          <div className="ni-set__actions">
            <Button id={`${idPrefix}-shuffle`} icon="shuffle" onClick={() => shuffle('New questions drawn.')} disabled={!bank}>
              Shuffle
            </Button>
            <Button id={`${idPrefix}-edit`} icon="edit" aria-expanded={editing} aria-controls={`${idPrefix}-editor`} onClick={() => setEditing(!editing)}>
              Edit questions
            </Button>
            <Button variant="ghost" aria-expanded={weightsOpen} aria-controls={`${idPrefix}-weights`} onClick={() => setWeightsOpen(!weightsOpen)}>
              Weights{changedCats.length ? ` (${changedCats.length} changed)` : ''}
            </Button>
          </div>
        )}
      </div>
      {shortfallInWords(unmet) && (
        <p className="ni-note ni-note--warn">
          <Icon name="alert" /> {shortfallInWords(unmet)}
        </p>
      )}
      {undo && (
        <p className="ni-note" role="status">
          {undo.message}{' '}
          <button
            type="button"
            className="pc-linkbtn"
            onClick={() => {
              onChange(undo.draft);
              setUndo(null);
              setUnmet([]);
              announce('Previous questions restored.');
            }}
          >
            Undo
          </button>
        </p>
      )}
      {readOnly ? (
        <ol className="set-list set-list--static qs-static" aria-label="Questions in interview order">
          {selected.map((q, i) => (
            <li key={q.id} className="set-row">
              <span className="set-row__pos" aria-hidden="true">
                {i + 1}
              </span>
              <div className="set-row__body">
                <button type="button" className="set-row__text" onClick={() => setDetail(q)} aria-haspopup="dialog">
                  <span className="visually-hidden">Question {i + 1}: </span>
                  {q.text}
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <>
          {editing && (
            <div id={`${idPrefix}-editor`}>
              <SetEditor
                questions={selected}
                bank={bank}
                categories={value.categories}
                budgetText={budgetText}
                budgetError={budget.error}
                onBudget={(t) => {
                  setBudgetText(t);
                  const b = parseBudget(t);
                  if (b.value !== null) onChange({ ...value, budget: b.value });
                }}
                onMoveTo={(from, to) => {
                  setIds(moveTo(value.ids, from, to));
                  announce(`Question moved to position ${Math.max(1, Math.min(value.ids.length, to + 1))} of ${value.ids.length}.`);
                }}
                onRemove={(index) => {
                  setIds(value.ids.filter((_, i) => i !== index));
                  announce('Question removed.');
                }}
                onToggle={(id) => setIds(toggleSelected(value.ids, id))}
                onOpen={setDetail}
                quotas={quotas}
                onQuotas={setQuotas}
                drawFrom={drawFrom}
                onDrawFrom={setDrawFrom}
                onRedraw={() => shuffle('New questions drawn with this mix.')}
                busy={!bank}
                onDone={() => {
                  setEditing(false);
                  requestAnimationFrame(() => document.getElementById(`${idPrefix}-edit`)?.focus());
                }}
              />
            </div>
          )}
          <div id={`${idPrefix}-weights`} hidden={!weightsOpen} className="qs-weights">
            {weightsOpen && (
              <>
                <div className="spread">
                  <p className="small muted ni-weights-intro">
                    A higher weight counts a category more in the score. If a must-have category averages below 2, the advisory band is capped. <DocLink req="FLOW-6" label="category weights and must-have" />
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!changedCats.length}
                    onClick={() => {
                      setWeightText({});
                      onChange({ ...value, categories: value.categories.map((c) => ({ ...c, weight: defaults.get(c.id)?.weight ?? c.weight, mustHave: defaults.get(c.id)?.mustHave ?? c.mustHave })) });
                    }}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <CategoryTable
                  rows={value.categories.map((c) => ({ category: c, count: 0, defaultWeight: defaults.get(c.id)?.weight ?? null, weightText: weightText[c.id] ?? String(c.weight), weightError: parseWeight(weightText[c.id] ?? String(c.weight)).error }))}
                  selectedTotal={0}
                  showCoverage={false}
                  onWeight={onWeight}
                  onMustHave={(id, mustHave) => onChange({ ...value, categories: value.categories.map((c) => (c.id === id ? { ...c, mustHave } : c)) })}
                />
              </>
            )}
          </div>
        </>
      )}
      <QuestionDetailDialog
        question={detail}
        categoryName={detail ? (value.categories.find((c) => c.id === detail.categoryId)?.name ?? '') : ''}
        onClose={() => setDetail(null)}
        extraFooter={
          detail && !readOnly ? (
            <Button variant={value.ids.includes(detail.id) ? 'default' : 'primary'} icon={value.ids.includes(detail.id) ? 'x' : 'plus'} onClick={() => setIds(toggleSelected(value.ids, detail.id))}>
              {value.ids.includes(detail.id) ? 'Remove from these questions' : 'Add to these questions'}
            </Button>
          ) : null
        }
      />
    </section>
  );
}
