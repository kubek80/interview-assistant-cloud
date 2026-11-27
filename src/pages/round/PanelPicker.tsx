import type { RoundMember } from '../../shared/api';

/**
 * ROUND-4, PANEL-1: who is on an interview's panel, chosen from the round's team with one click each.
 * The signed-in person is marked "(you)". Checkboxes in a fieldset (A11Y-2), shown as chips.
 */
export function PanelPicker({
  team,
  value,
  onChange,
  meId,
  idPrefix,
  legend = 'Interviewers',
  error,
}: {
  team: readonly Pick<RoundMember, 'id' | 'name' | 'active'>[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  meId: string;
  idPrefix: string;
  legend?: string;
  error?: string | null;
}) {
  const people = team.filter((m) => m.active || value.includes(m.id));
  return (
    <fieldset className="panel-pick" aria-describedby={error ? `${idPrefix}-panel-error` : undefined}>
      <legend className="field__label">{legend}</legend>
      <ul className="panel-pick__list" role="list">
        {people.map((m) => {
          const on = value.includes(m.id);
          return (
            <li key={m.id}>
              <label className={`chip${on ? ' chip--on' : ''}`}>
                <input
                  type="checkbox"
                  id={`${idPrefix}-panel-${m.id}`}
                  checked={on}
                  onChange={() => onChange(on ? value.filter((x) => x !== m.id) : [...value, m.id])}
                />
                <span>
                  {m.name}
                  {m.id === meId && <span className="muted"> (you)</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {error && (
        <p id={`${idPrefix}-panel-error`} className="field__error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
