import { useMemo, useState } from 'react';
import { usePlans, useSessions, useTracks } from '../../db';
import { formatCandidateKey } from '../../domain/plan';
import type { InterviewPlan } from '../../domain/types';
import { Button, Dialog, formatDate } from '../../ui';
import { useImportPlan } from '../dashboard/planFiles';

/**
 * FLOW-9: "Use the same questions as…": pick the question set of an earlier interview (or import a
 * set shared by the panel), so this interview's results are comparable with it.
 */
export function ReuseDialog({ open, onClose, onChoose, current }: { open: boolean; onClose: () => void; onChoose: (plan: InterviewPlan) => void; current?: string | null }) {
  return (
    <Dialog open={open} onClose={onClose} title="Use the same questions as…" wide>
      {open && <ReuseChoices onClose={onClose} onChoose={onChoose} current={current} />}
    </Dialog>
  );
}

function ReuseChoices({ onClose, onChoose, current }: { onClose: () => void; onChoose: (plan: InterviewPlan) => void; current?: string | null }) {
  const plans = usePlans();
  const sessions = useSessions();
  const tracks = useTracks();
  const [chosen, setChosen] = useState<string | null>(current ?? null);
  const [needChoice, setNeedChoice] = useState(false);
  const importer = useImportPlan((id) => setChosen(id));
  const trackName = useMemo(() => new Map((tracks ?? []).map((t) => [t.id, t.name])), [tracks]);
  const sets = useMemo(() => (plans ?? []).filter((p) => p.locked), [plans]);
  const usedFor = (planId: string) =>
    (sessions ?? [])
      .filter((s) => s.planId === planId)
      .map((s) => formatCandidateKey(s.candidate));
  const plan = sets.find((p) => p.id === chosen);

  return (
    <div className="stack">
      <p className="small muted">Interviews with the same questions can be compared side by side.</p>
      {plans === undefined ? (
        <p className="muted">Loading…</p>
      ) : sets.length === 0 ? (
        <p className="muted">No earlier interviews on this device yet. You can import a question set file shared by your panel.</p>
      ) : (
        <fieldset>
          <legend className="visually-hidden">Question sets</legend>
          <ul className="reuse-list" role="list">
            {sets.map((p) => {
              const used = usedFor(p.id);
              return (
                <li key={p.id}>
                  <label className={`reuse-item${chosen === p.id ? ' reuse-item--chosen' : ''}`}>
                    <input type="radio" name="reuse" value={p.id} checked={chosen === p.id} onChange={() => setChosen(p.id)} />
                    <span>
                      <span className="reuse-item__name">{p.name}</span>
                      <span className="reuse-item__meta">
                        {trackName.get(p.trackId) ?? p.trackId} · {p.questions.length} questions · {formatDate(p.lockedAt ?? p.createdAt)}
                        {used.length > 0 ? ` · used for ${used.slice(0, 4).join(', ')}${used.length > 4 ? ` and ${used.length - 4} more` : ''}` : ' · imported, not used yet'}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      {needChoice && !plan && (
        <p className="field__error" role="alert">
          Choose a question set first.
        </p>
      )}
      {importer.errorAlert}
      <div className="pc-dialog-actions">
        <span className="grow">{importer.trigger}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => (plan ? onChoose(plan) : setNeedChoice(true))}>
          Use these questions
        </Button>
      </div>
    </div>
  );
}
