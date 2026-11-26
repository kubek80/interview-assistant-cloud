import { useCallback, useEffect, useRef, useState } from 'react';
import { addNote, addNoteEntry, deleteNote, editNote } from '../../db';

/**
 * FLOW-15 + RES-1: the "add a note" field saves while you type. The first keystrokes create a note
 * entry (stamped with the elapsed interview time, as addNote does); later keystrokes update it.
 * Pressing Enter (or "Add note") finishes the entry and clears the field. A reload, a question
 * change or closing the page therefore never loses a half-typed note: it is already an entry.
 *
 * All writes go through one promise chain so they apply in order.
 */
export function useNoteDraft(sessionId: string, questionId: string, onError: (err: unknown) => void, by = '') {
  const [text, setText] = useState('');
  /** Index of the entry being typed (hidden from the list while it is the draft). */
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const entry = useRef<{ questionId: string; index: number } | null>(null);
  const latest = useRef('');
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /** PANEL-3: who is making the note being typed ('' = not marked). */
  const byRef = useRef(by);

  const enqueue = useCallback((fn: () => Promise<void>) => {
    chain.current = chain.current.then(fn).catch((err) => onErrorRef.current(err));
    return chain.current;
  }, []);

  /** Save `value` as the draft entry of `qid` (create, update or remove it). */
  const save = useCallback(
    (qid: string, value: string) =>
      enqueue(async () => {
        const e = entry.current?.questionId === qid ? entry.current : null;
        if (!e) {
          if (!value.trim()) return;
          const index = await addNoteEntry(sessionId, qid, value, byRef.current || null);
          if (index != null) {
            entry.current = { questionId: qid, index };
            setDraftIndex(index);
          }
        } else if (!value.trim()) {
          await deleteNote(sessionId, qid, e.index);
          entry.current = null;
          setDraftIndex(null);
        } else {
          await editNote(sessionId, qid, e.index, value);
        }
      }),
    [enqueue, sessionId],
  );

  /** Finish the current entry (trimmed) and start a fresh one. */
  const finish = useCallback(
    (qid: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const value = latest.current.trim();
      latest.current = '';
      setText('');
      return enqueue(async () => {
        const e = entry.current?.questionId === qid ? entry.current : null;
        if (e) {
          if (value) await editNote(sessionId, qid, e.index, value, byRef.current || null);
          else await deleteNote(sessionId, qid, e.index);
        } else if (value) {
          await addNote(sessionId, qid, value, byRef.current || null);
        }
        entry.current = null;
        setDraftIndex(null);
      });
    },
    [enqueue, sessionId],
  );

  const change = useCallback(
    (value: string) => {
      setText(value);
      latest.current = value;
      if (timer.current) clearTimeout(timer.current);
      // Create the entry promptly so its timestamp is close to when typing began; batch later edits.
      const delay = entry.current?.questionId === questionId ? 400 : 150;
      timer.current = setTimeout(() => {
        timer.current = null;
        void save(questionId, latest.current);
      }, delay);
    },
    [questionId, save],
  );

  // PANEL-3: choosing who is making the note also marks the entry already being typed.
  useEffect(() => {
    if (byRef.current === by) return;
    byRef.current = by;
    const e = entry.current;
    if (e && e.questionId === questionId) void enqueue(() => editNote(sessionId, questionId, e.index, latest.current, by || null));
  }, [by, enqueue, sessionId, questionId]);

  // Leaving the question (or the screen) finishes the entry for the question it belongs to.
  useEffect(() => {
    return () => {
      void finish(questionId);
    };
  }, [questionId, finish]);

  // Flush a pending debounced save when the page is hidden or unloaded.
  useEffect(() => {
    const flush = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      void save(questionId, latest.current);
    };
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [questionId, save]);

  /** Delete another entry, keeping the draft's index in step. */
  const removeEntry = useCallback(
    (qid: string, index: number) =>
      enqueue(async () => {
        await deleteNote(sessionId, qid, index);
        const e = entry.current;
        if (e && e.questionId === qid && e.index > index) {
          entry.current = { ...e, index: e.index - 1 };
          setDraftIndex(e.index - 1);
        }
      }),
    [enqueue, sessionId],
  );

  const updateEntry = useCallback((qid: string, index: number, value: string) => enqueue(() => editNote(sessionId, qid, index, value)), [enqueue, sessionId]);

  return {
    text,
    change,
    finish: () => finish(questionId),
    /** Index of the live draft entry of this question, to hide it from the list. */
    draftIndex: entry.current?.questionId === questionId ? draftIndex : null,
    removeEntry,
    updateEntry,
  };
}
