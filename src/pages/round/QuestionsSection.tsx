import { useEffect, useRef, useState } from 'react';
import { RepoError, saveRoundQuestionSet } from '../../db';
import type { QuestionSetDetail, RoundDetail } from '../../shared/api';
import { shortFingerprint } from '../../domain/plan';
import { Alert, Button, ConfirmDialog, DocLink, Icon, useToast } from '../../ui';
import { QuestionSetPanel, draftOf, sameDraft, type SetDraft } from './QuestionSetPanel';

const toInput = (d: SetDraft) => ({ questionIds: d.ids, categories: d.categories.map((c) => ({ id: c.id, weight: c.weight, mustHave: c.mustHave })), timeBudgetMin: d.budget });

/**
 * ROUND-3, FLOW-8, FLOW-9: the round's question set. Until the first interview that uses it is
 * planned, changes are saved as they are made. Once it is fixed, changes are kept as a draft and
 * saved, on request, as a new set for future interviews, with a plain warning that candidates on
 * different sets cannot be compared directly.
 */
export function QuestionsSection({ round, set }: { round: RoundDetail; set: QuestionSetDetail }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<SetDraft>(() => draftOf(set));
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [confirm, setConfirm] = useState(false);
  const base = useRef({ id: set.id, version: set.version });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SetDraft | null>(null);
  const editable = round.canPlan;

  // Someone else changed the set (live update), or a save came back: follow the server when we have nothing unsaved.
  useEffect(() => {
    base.current = { id: set.id, version: set.version };
    if (!pending.current) setDraft(draftOf(set));
  }, [set]);

  const save = async () => {
    const d = pending.current;
    if (!d) return;
    pending.current = null;
    setStatus('saving');
    try {
      const r = await saveRoundQuestionSet(round.id, { ...toInput(d), baseSetId: base.current.id, baseVersion: base.current.version });
      base.current = { id: r.set.id, version: r.set.version };
      setStatus(pending.current ? 'saving' : 'saved');
    } catch (err) {
      setStatus('error');
      toast(err instanceof RepoError ? err.message : 'The questions could not be saved.', 'error');
    }
  };

  const onChange = (next: SetDraft) => {
    setDraft(next);
    if (set.fixed) return; // kept as a draft until "Save for future interviews"
    pending.current = next;
    setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 500);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    void save();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changedFixed = set.fixed && !sameDraft(draft, draftOf(set));
  const saveNewSet = async () => {
    setConfirm(false);
    setStatus('saving');
    try {
      await saveRoundQuestionSet(round.id, { ...toInput(draft), baseSetId: set.id, baseVersion: set.version });
      setStatus('saved');
      toast('Saved as a new question set. Interviews planned from now on use it.', 'success');
    } catch (err) {
      setStatus('error');
      toast(err instanceof RepoError ? err.message : 'The questions could not be saved.', 'error');
    }
  };

  return (
    <div className="stack">
      {set.fixed ? (
        <Alert tone="info" title={`These questions are fixed: ${set.interviews} interview${set.interviews === 1 ? '' : 's'} use${set.interviews === 1 ? 's' : ''} them.`}>
          <p>
            Every candidate asked these questions can be compared with the others. {editable ? 'Changing them makes a new set for interviews planned from now on; candidates on different sets cannot be compared directly.' : ''}{' '}
            <DocLink req="FLOW-9" label="comparing candidates" />
          </p>
        </Alert>
      ) : (
        editable && (
          <p className="small muted">
            <Icon name="info" /> Every interview in this round uses these questions, so the candidates can be compared. Changes are saved as you make them; the questions are fixed when the first interview is planned.
          </p>
        )
      )}
      <div className="card qs-card">
        <QuestionSetPanel
          trackId={set.trackId}
          value={draft}
          snapshot={set.questions}
          onChange={onChange}
          readOnly={!editable}
          title="The round’s questions"
          idPrefix="round-set"
          note={
            <p className="small muted qs-code" data-testid="set-code">
              Comparison code <span className="mono">{shortFingerprint(set.fingerprint)}</span>
              {set.fixed ? ' · fixed' : ''}
              {!set.fixed && editable && (
                <span role="status" className="qs-status">
                  {' · '}
                  {status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved' : 'Saved'}
                </span>
              )}
            </p>
          }
        />
        {changedFixed && (
          <div className="ni-footer qs-footer">
            <Button variant="primary" onClick={() => setConfirm(true)} disabled={status === 'saving'}>
              Save as a new set for future interviews
            </Button>
            <Button variant="ghost" onClick={() => setDraft(draftOf(set))}>
              Discard changes
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirm} title="Use new questions from now on?" confirmLabel="Save new set" onCancel={() => setConfirm(false)} onConfirm={saveNewSet}>
        <p>
          The {set.interviews} interview{set.interviews === 1 ? '' : 's'} already planned keep{set.interviews === 1 ? 's' : ''} the current questions. Interviews planned from now on use the new ones. Candidates on different sets are marked as not directly comparable.
        </p>
      </ConfirmDialog>
    </div>
  );
}
