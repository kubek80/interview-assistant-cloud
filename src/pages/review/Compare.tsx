import { useState, type ReactNode } from 'react';
import type { QuestionDraft } from '../../domain/bankEdit';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '../../domain/rubric';
import type { Category } from '../../domain/types';
import type { ProposalStatus } from '../../shared/api';
import { PROPOSAL_STATUS_LABELS } from '../../shared/api';
import { Badge, Button, type Tone } from '../../ui';
import type { IconName } from '../../ui';

type Side = Pick<QuestionDraft, 'text' | 'description' | 'categoryId' | 'difficulty' | 'type' | 'timeMin' | 'lookFor' | 'redFlags' | 'probes' | 'rubricOverride'>;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/** A list's items, each marked "Added" or "Removed" against the other side (text labels, not colour alone). */
function ListCell({ items, other, side }: { items: readonly string[]; other: readonly string[] | null; side: 'current' | 'proposed' }) {
  const otherSet = new Set((other ?? []).map(norm));
  if (!items.length) return <span className="muted">None</span>;
  return (
    <ul>
      {items.map((it, i) => {
        const differs = other !== null && !otherSet.has(norm(it));
        return (
          <li key={i} className={differs ? (side === 'proposed' ? 'rv-add' : 'rv-del') : undefined}>
            {differs && <span className="rv-mark">{side === 'proposed' ? 'Added' : 'Removed'}</span>}
            {it}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * REVIEW-5: the current wording beside the proposed wording, field by field. Changed fields are marked
 * with the word "Changed" (and a highlight); list items say "Added" or "Removed".
 */
export function ProposalComparison({
  current,
  proposed,
  categories,
  newCategoryName,
  currentLabel = 'Now',
}: {
  current: Side | null;
  proposed: Side;
  categories: readonly Category[];
  newCategoryName: string | null;
  currentLabel?: string;
}) {
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? (id ? id : newCategoryName ? `${newCategoryName} (new category)` : '–');
  const rubric = (s: Side) => (s.rubricOverride ? Object.entries(s.rubricOverride).map(([k, v]) => `${k}: ${v}`) : []);
  const rows: Array<{ label: string; a: ReactNode; b: ReactNode; changed: boolean }> = [];
  const text = (label: string, get: (s: Side) => string) => {
    const b = get(proposed);
    const a = current ? get(current) : null;
    rows.push({ label, a: a === null ? <span className="muted">–</span> : <span className="pre-wrap">{a}</span>, b: <span className="pre-wrap">{b}</span>, changed: a !== null && norm(a) !== norm(b) });
  };
  const list = (label: string, get: (s: Side) => readonly string[]) => {
    const b = get(proposed);
    const a = current ? get(current) : null;
    const changed = a !== null && JSON.stringify(a.map(norm)) !== JSON.stringify(b.map(norm));
    rows.push({ label, a: a === null ? <span className="muted">–</span> : <ListCell items={a} other={b} side="current" />, b: <ListCell items={b} other={a} side="proposed" />, changed });
  };
  text('Question', (s) => s.text);
  text('Description', (s) => s.description);
  text('Category', (s) => catName(s.categoryId));
  text('Type', (s) => TYPE_LABEL[s.type]);
  text('Difficulty', (s) => (s.type === 'behavioural' ? 'Core' : DIFFICULTY_LABEL[s.difficulty]));
  text('Time', (s) => `${s.timeMin} min`);
  list('Key points', (s) => s.lookFor);
  list('Red flags', (s) => s.redFlags);
  list('Probes', (s) => s.probes);
  list('Rubric texts', rubric);
  const changedCount = rows.filter((r) => r.changed).length;
  // Only what changed, by default; the rest is one click away.
  const [all, setAll] = useState(false);
  const focus = !!current && changedCount > 0 && !all;
  const shown = focus ? rows.filter((r) => r.changed) : rows;
  return (
    <div className="stack-sm">
    {current && changedCount > 0 && (
      <div className="cluster">
        <p className="small">
          {changedCount} of {rows.length} fields changed.
        </p>
        <Button size="sm" variant="ghost" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? 'Show only what changed' : `Show all fields (${rows.length - changedCount} unchanged)`}
        </Button>
      </div>
    )}
    <div className="table-wrap">
      <table className="table rv-compare">
        <caption className="visually-hidden">{current ? `${currentLabel} and proposed wording, ${changedCount} field${changedCount === 1 ? '' : 's'} changed` : 'The proposed question'}</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            {current && <th scope="col">{currentLabel}</th>}
            <th scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.label} className={r.changed ? 'rv-changed' : undefined}>
              <th scope="row">
                {r.label}
                {r.changed && (
                  <>
                    <br />
                    <span className="rv-mark">Changed</span>
                  </>
                )}
              </th>
              {current && <td data-label={currentLabel}>{r.a}</td>}
              <td data-label="Proposed">{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

const STATUS_STYLE: Record<ProposalStatus, { tone: Tone; icon: IconName }> = {
  open: { tone: 'info', icon: 'clock' },
  accepted: { tone: 'success', icon: 'check' },
  accepted_with_edits: { tone: 'success', icon: 'check' },
  declined: { tone: 'danger', icon: 'x' },
  withdrawn: { tone: 'neutral', icon: 'undo' },
};

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {PROPOSAL_STATUS_LABELS[status]}
    </Badge>
  );
}

export function OutOfDateBadge() {
  return (
    <Badge tone="warning" icon="alert">
      Out of date
    </Badge>
  );
}
