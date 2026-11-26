import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Question } from '../../domain/types';
import { Icon } from '../../ui';
import { questionMeta } from './logic';

type FocusIntent = { id: string; which: 'up' | 'down' } | { removedAt: number };

/**
 * UX-3, FLOW-3: the selected questions in interview order, the main list of "Edit questions".
 * Reorder by dragging the grip (pointer: mouse, pen or touch) or with the move up / move down
 * buttons (keyboard, A11Y-1); remove; open a question to peek at its detail. Focus follows the
 * moved question, or goes to the next one after a removal.
 */
export function SelectedList({
  questions,
  categoryName,
  onMoveTo,
  onRemove,
  onOpen,
  emptyFocusId,
}: {
  questions: readonly Question[];
  categoryName: (id: string) => string;
  onMoveTo: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onOpen: (q: Question) => void;
  /** Where focus goes when the last question is removed. */
  emptyFocusId: string;
}) {
  const refs = useRef(new Map<string, HTMLElement>());
  const rows = useRef<Array<HTMLLIElement | null>>([]);
  const intent = useRef<FocusIntent | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number; pointerId: number } | null>(null);

  useLayoutEffect(() => {
    const i = intent.current;
    if (!i) return;
    intent.current = null;
    if ('id' in i) {
      const idx = questions.findIndex((q) => q.id === i.id);
      const which = i.which === 'up' && idx === 0 ? 'down' : i.which === 'down' && idx === questions.length - 1 ? 'up' : i.which;
      refs.current.get(`${i.id}:${which}`)?.focus();
    } else {
      const q = questions[Math.min(i.removedAt, questions.length - 1)];
      if (q) refs.current.get(`${q.id}:remove`)?.focus();
      else document.getElementById(emptyFocusId)?.focus();
    }
  }, [questions, emptyFocusId]);

  const setRef = (key: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  /** Index of the row under the pointer's vertical position. */
  const indexAt = (y: number): number => {
    for (let i = 0; i < questions.length; i++) {
      const el = rows.current[i];
      if (el && y < el.getBoundingClientRect().bottom) return i;
    }
    return questions.length - 1;
  };

  const onPointerDown = (i: number) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: i, over: i, pointerId: e.pointerId });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const over = indexAt(e.clientY);
    if (over !== drag.over) setDrag({ ...drag, over });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { from } = drag;
    const over = indexAt(e.clientY);
    setDrag(null);
    if (over !== from) onMoveTo(from, over);
  };

  return (
    <ol className={`set-list${drag ? ' set-list--dragging' : ''}`} aria-label="Questions in interview order">
      {questions.map((q, i) => {
        const dragging = drag?.from === i;
        const target = drag && drag.over === i && drag.from !== i ? (drag.over > drag.from ? 'after' : 'before') : null;
        return (
          <li
            key={q.id}
            ref={(el) => {
              rows.current[i] = el;
            }}
            className={['set-row', dragging && 'set-row--dragging', target && `set-row--drop-${target}`].filter(Boolean).join(' ')}
            data-question={q.number}
          >
            <span
              className="set-row__grip"
              aria-hidden="true"
              title="Drag to reorder"
              onPointerDown={onPointerDown(i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              <Icon name="grip" />
            </span>
            <span className="set-row__pos" aria-hidden="true">
              {i + 1}
            </span>
            <div className="set-row__body">
              <button type="button" className="set-row__text" onClick={() => onOpen(q)} aria-haspopup="dialog">
                <span className="visually-hidden">Question {i + 1}: </span>
                {q.text}
              </button>
              <p className="set-row__meta">{questionMeta(q, categoryName(q.categoryId))}</p>
            </div>
            <div className="set-row__actions">
              <button
                ref={setRef(`${q.id}:up`)}
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Move question ${i + 1} up`}
                title="Move up"
                disabled={i === 0}
                onClick={() => {
                  intent.current = { id: q.id, which: 'up' };
                  onMoveTo(i, i - 1);
                }}
              >
                <Icon name="arrow-up" />
              </button>
              <button
                ref={setRef(`${q.id}:down`)}
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Move question ${i + 1} down`}
                title="Move down"
                disabled={i === questions.length - 1}
                onClick={() => {
                  intent.current = { id: q.id, which: 'down' };
                  onMoveTo(i, i + 1);
                }}
              >
                <Icon name="arrow-down" />
              </button>
              <button
                ref={setRef(`${q.id}:remove`)}
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Remove question ${i + 1}`}
                title="Remove"
                onClick={() => {
                  intent.current = { removedAt: i };
                  onRemove(i);
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
