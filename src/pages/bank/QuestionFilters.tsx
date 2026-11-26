import { Button, Checkbox, Field, Select, TextInput } from '../../ui';
import { DIFFICULTY_LABEL, DIFFICULTY_TAG, TYPE_LABEL, TYPE_TAG } from '../../domain/rubric';
import { DIFFICULTIES, QUESTION_TYPES, type Category } from '../../domain/types';
import { EMPTY_FILTERS, activeFilterCount, toggleIn, type FilterState } from './filters';

export interface QuestionFiltersProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
  categories: readonly Category[];
  /** Unique prefix for control ids (two filter panels never share a page, but be safe). */
  idPrefix: string;
  /** Bank screen only (BANK-2): offer "include retired questions". */
  allowRetired?: boolean;
  /** Lay out in one row on wide screens (bank) or stacked (setup sidebar). */
  layout?: 'row' | 'stacked';
}

/** FLOW-2, BANK-2: filter by category, difficulty and type, and search the text. */
export function QuestionFilters({ value, onChange, categories, idPrefix, allowRetired, layout = 'row' }: QuestionFiltersProps) {
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  const active = activeFilterCount(value);
  return (
    <div className={`q-filters q-filters--${layout}`} role="group" aria-label="Filter questions">
      <div className="q-filters__fields">
        <Field label="Search text" className="q-filters__search">
          <TextInput
            id={`${idPrefix}-search`}
            type="search"
            value={value.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Words in the question, key points or probes"
            autoComplete="off"
          />
        </Field>
        <Field label="Category">
          <Select
            id={`${idPrefix}-category`}
            value={value.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
            placeholder="All categories"
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
      </div>
      <div className="q-filters__groups">
        <fieldset className="q-filters__group">
          <legend>Difficulty</legend>
          <div className="cluster">
            {DIFFICULTIES.map((d) => (
              <Checkbox
                key={d}
                className="pc-chip"
                checked={value.difficulties.includes(d)}
                onChange={() => set({ difficulties: toggleIn(value.difficulties, d, DIFFICULTIES) })}
                label={
                  <>
                    <span className="tag" aria-hidden="true">
                      {DIFFICULTY_TAG[d]}
                    </span>{' '}
                    {DIFFICULTY_LABEL[d]}
                  </>
                }
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="q-filters__group">
          <legend>Type</legend>
          <div className="cluster">
            {QUESTION_TYPES.map((t) => (
              <Checkbox
                key={t}
                className="pc-chip"
                checked={value.types.includes(t)}
                onChange={() => set({ types: toggleIn(value.types, t, QUESTION_TYPES) })}
                label={
                  <>
                    <span className="tag" aria-hidden="true">
                      {TYPE_TAG[t]}
                    </span>{' '}
                    {TYPE_LABEL[t]}
                  </>
                }
              />
            ))}
          </div>
        </fieldset>
        {allowRetired && (
          <div className="q-filters__group q-filters__group--end">
            <Checkbox checked={value.includeRetired} onChange={(e) => set({ includeRetired: e.target.checked })} label="Include retired questions" />
          </div>
        )}
      </div>
      {active > 0 && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon="x"
            onClick={() => {
              onChange({ ...EMPTY_FILTERS });
              // The button disappears once nothing is filtered; keep focus somewhere sensible (A11Y-1).
              document.getElementById(`${idPrefix}-search`)?.focus();
            }}
          >
            Clear filters ({active})
          </Button>
        </div>
      )}
    </div>
  );
}
