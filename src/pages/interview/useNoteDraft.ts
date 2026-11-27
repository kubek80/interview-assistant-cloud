import { useCallback, useEffect, useRef, useState } from 'react';
import { changeRecord } from '../../db';

/**
 * FLOW-15, RES-1, HOST-6: the "add a note" field saves while you type. The first keystrokes create a
 * note (with an id chosen here, stamped with the elapsed interview time); later keystrokes update it.
 * Enter (or "Add note") finishes it and clears the field. Every change goes through the outbox, so
 * it shows at once, is sent in order, and survives a lost connection or a reload.
 *
 * The text being typed lives only in this hook's state: refetches caused by other people's changes
 * never touch it, so the field keeps its focus and caret (LIVE-3).
 */
export function useNoteDraft(userId: string, recordId: string, questionId: string, elapsedSec: () => number, by = '') {
  const [text, setText] = useState('');
  /** Id of the note being typed (hidden from the list while it is the draft). */
  const [draftId, setDraftId] = useState<string | null>(null);
  const entry = useRef<{ questionId: string; id: string } | null>(null);
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** PANEL-3: who is making the note being typed ('' = not marked). */
  const byRef = useRef(by);
  const elapsedRef = useRef(elapsedSec);
  elapsedRef.current = elapsedSec;

  /** Save `value` as the draft note of `qid` (create, update or remove it). */
  const save = useCallback(
    (qid: string, value: string) => {
      const e = entry.current?.questionId === qid ? entry.current : null;
      if (!e) {
        if (!value.trim()) return;
        const id = crypto.randomUUID();
        changeRecord(userId, recordId, [{ t: 'note.add', id, q: qid, atSec: Math.max(0, Math.floor(elapsedRef.current())), text: value, by: byRef.current || null }]);
        entry.current = { questionId: qid, id };
        setDraftId(id);
      } else if (!value.trim()) {
        changeRecord(userId, recordId, [{ t: 'note.del', id: e.id }]);
        entry.current = null;
        setDraftId(null);
      } else {
        changeRecord(userId, recordId, [{ t: 'note.edit', id: e.id, text: value }]);
      }
    },
    [userId, recordId],
  );

  /** Finish the current note (trimmed) and start a fresh one. */
  const finish = useCallback(
    (qid: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const value = latest.current.trim();
      latest.current = '';
      setText('');
      const e = entry.current?.questionId === qid ? entry.current : null;
      if (e) changeRecord(userId, recordId, [value ? { t: 'note.edit', id: e.id, text: value, by: byRef.current || null } : { t: 'note.del', id: e.id }]);
      else if (value) changeRecord(userId, recordId, [{ t: 'note.add', id: crypto.randomUUID(), q: qid, atSec: Math.max(0, Math.floor(elapsedRef.current())), text: value, by: byRef.current || null }]);
      entry.current = null;
      setDraftId(null);
    },
    [userId, recordId],
  );

  const change = useCallback(
    (value: string) => {
      setText(value);
      latest.current = value;
      if (timer.current) clearTimeout(timer.current);
      // Create the note promptly so its time is close to when typing began; batch later edits.
      const delay = entry.current?.questionId === questionId ? 400 : 150;
      timer.current = setTimeout(() => {
        timer.current = null;
        save(questionId, latest.current);
      }, delay);
    },
    [questionId, save],
  );

  // PANEL-3: choosing who is making the note also marks the note already being typed.
  useEffect(() => {
    if (byRef.current === by) return;
    byRef.current = by;
    const e = entry.current;
    if (e && e.questionId === questionId) changeRecord(userId, recordId, [{ t: 'note.edit', id: e.id, text: latest.current, by: by || null }]);
  }, [by, userId, recordId, questionId]);

  // Leaving the question (or the screen) finishes the note for the question it belongs to.
  useEffect(() => {
    return () => {
      finish(questionId);
    };
  }, [questionId, finish]);

  // Save a pending keystroke batch when the page is hidden or unloaded (the outbox keeps it).
  useEffect(() => {
    const flush = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      save(questionId, latest.current);
    };
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [questionId, save]);

  const removeEntry = useCallback((id: string) => changeRecord(userId, recordId, [{ t: 'note.del', id }]), [userId, recordId]);
  const updateEntry = useCallback((id: string, value: string) => changeRecord(userId, recordId, [{ t: 'note.edit', id, text: value }]), [userId, recordId]);

  return {
    text,
    change,
    finish: () => finish(questionId),
    /** Id of the note of this question being typed, to hide it from the list. */
    draftId: entry.current?.questionId === questionId ? draftId : null,
    /** There is text in the field (LIVE-2: the panel moving on does not pull me away from it). */
    typing: () => latest.current.trim().length > 0,
    removeEntry,
    updateEntry,
  };
}
