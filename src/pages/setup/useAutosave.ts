import { useCallback, useRef, useState } from 'react';
import { RepoError, updatePlanDraft, type PlanDraftPatch } from '../../db';

export type SaveStatus = { state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string };

/**
 * RES-1: every draft edit is written to IndexedDB as it is made. Saves run one after another so a
 * quick sequence of edits is stored in order.
 */
export function useAutosave(planId: string) {
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });

  const save = useCallback(
    (patch: PlanDraftPatch) => {
      pending.current++;
      setStatus({ state: 'saving' });
      queue.current = queue.current.then(async () => {
        try {
          await updatePlanDraft(planId, patch);
          pending.current--;
          if (pending.current === 0) setStatus({ state: 'saved' });
        } catch (err) {
          pending.current--;
          setStatus({ state: 'error', message: err instanceof RepoError ? err.message : 'Your last change could not be saved.' });
        }
      });
      return queue.current;
    },
    [planId],
  );

  return { save, status, flush: () => queue.current, saving: () => pending.current > 0 };
}
