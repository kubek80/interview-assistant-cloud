import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Button, Icon, IconButton } from '../../ui';

let keySeq = 0;
const newKey = () => `li-${++keySeq}`;

export interface ListEditorProps {
  /** Legend of the group, e.g. "L · Key points". */
  legend: string;
  /** Singular noun for item labels and buttons, e.g. "key point". */
  noun: string;
  items: string[];
  onChange: (items: string[]) => void;
  error?: string | null;
  hint?: string;
  /** Id of the first input, so a field error can focus it. */
  firstInputId?: string;
}

/** Grows a text area to fit its text where the browser cannot do it in CSS (field-sizing: content). */
const NATIVE_GROW = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
function fitHeight(el: HTMLTextAreaElement | null) {
  if (!el || NATIVE_GROW) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

/**
 * BANK-9: edits a list of texts (key points, red flags, probes). Key points and red flags are
 * sentences (BANK-15), so each item is a text area that grows with its text and wraps; an item is
 * still one line of text (no line breaks). Add, remove and move items; Enter adds the next item;
 * pasting several lines creates several items; Backspace in an empty item removes it. Every control
 * is labelled and reachable by keyboard (A11Y-1, A11Y-2).
 */
export function ListEditor({ legend, noun, items, onChange, error, hint, firstInputId }: ListEditorProps) {
  const id = useId();
  const [keys, setKeys] = useState<string[]>(() => items.map(newKey));
  const inputs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [status, setStatus] = useState('');

  // Items replaced from outside (e.g. "insert the starting items") get fresh keys.
  const shownKeys = keys.length === items.length ? keys : items.map((_, i) => keys[i] ?? newKey());
  if (shownKeys !== keys) setKeys(shownKeys);

  useEffect(() => {
    if (focusIndex === null) return;
    const el = inputs.current[focusIndex];
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusIndex(null);
  }, [focusIndex, items.length]);

  // Without CSS field-sizing, fit every item's height to its text whenever the texts change.
  useEffect(() => {
    if (!NATIVE_GROW) inputs.current.forEach(fitHeight);
  }, [items]);

  const cap = noun.charAt(0).toUpperCase() + noun.slice(1);
  const update = (next: string[], nextKeys: string[], focus: number | null, say = '') => {
    setKeys(nextKeys);
    onChange(next);
    if (focus !== null) setFocusIndex(focus);
    if (say) setStatus(say);
  };
  const insertAt = (i: number, texts: string[]) => {
    const next = [...items.slice(0, i), ...texts, ...items.slice(i)];
    const nk = [...shownKeys.slice(0, i), ...texts.map(newKey), ...shownKeys.slice(i)];
    update(next, nk, i + texts.length - 1, texts.length > 1 ? `${texts.length} ${noun}s added.` : '');
  };
  const removeAt = (i: number) => {
    const next = items.filter((_, j) => j !== i);
    const nk = shownKeys.filter((_, j) => j !== i);
    update(next.length ? next : [''], next.length ? nk : [newKey()], Math.max(0, i - 1), `${cap} ${i + 1} removed.`);
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    const nk = [...shownKeys];
    [next[i], next[j]] = [next[j], next[i]];
    [nk[i], nk[j]] = [nk[j], nk[i]];
    update(next, nk, null, `${cap} moved to position ${j + 1} of ${items.length}.`);
    // Keep focus on the same button of the moved item when it still exists.
    requestAnimationFrame(() => document.getElementById(`${id}-${by < 0 ? 'up' : 'down'}-${nk[j]}`)?.focus() ?? document.getElementById(`${id}-${by < 0 ? 'down' : 'up'}-${nk[j]}`)?.focus());
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      insertAt(i + 1, ['']);
    } else if (e.key === 'Backspace' && items[i] === '' && items.length > 1) {
      e.preventDefault();
      removeAt(i);
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      move(i, 1);
    }
  };

  const onPaste = (i: number) => (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const lines = text
      .split(/\r\n|\r|\n/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    if (!lines.length) return;
    const el = e.currentTarget;
    const before = items[i].slice(0, el.selectionStart ?? items[i].length);
    const after = items[i].slice(el.selectionEnd ?? items[i].length);
    const merged = [...lines];
    merged[0] = before + merged[0];
    merged[merged.length - 1] += after;
    const replaced = merged.map((s) => s.trim()).filter(Boolean);
    const next = [...items.slice(0, i), ...replaced, ...items.slice(i + 1)];
    const nk = [...shownKeys.slice(0, i), shownKeys[i], ...replaced.slice(1).map(newKey), ...shownKeys.slice(i + 1)];
    update(next, nk, i + replaced.length - 1, `${replaced.length} ${noun}s from the pasted lines.`);
  };

  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <fieldset className="list-editor" aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}>
      <legend className="field__label">
        {legend}
        <span className="field__required" aria-hidden="true">
          *
        </span>
      </legend>
      {hint && (
        <div id={hintId} className="field__hint">
          {hint}
        </div>
      )}
      <ol className="list-editor__items">
        {items.map((text, i) => {
          const k = shownKeys[i];
          const inputId = i === 0 && firstInputId ? firstInputId : `${id}-in-${k}`;
          return (
            <li key={k} className="list-editor__item">
              <span className="list-editor__n" aria-hidden="true">
                {i + 1}
              </span>
              <label htmlFor={inputId} className="visually-hidden">
                {cap} {i + 1}
              </label>
              <textarea
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                id={inputId}
                rows={1}
                className="textarea list-editor__input"
                value={text}
                // One item is one line of text: a line break typed or dropped in becomes a space.
                onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value.replace(/\r\n|\r|\n/g, ' ') : x)))}
                onKeyDown={onKeyDown(i)}
                onPaste={onPaste(i)}
                aria-invalid={error && !text.trim() && items.every((x) => !x.trim()) ? true : undefined}
                aria-describedby={errorId}
                autoComplete="off"
                enterKeyHint="next"
              />
              <span className="list-editor__actions">
                <IconButton id={`${id}-up-${k}`} icon="arrow-up" size="sm" label={`Move ${noun} ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0} />
                <IconButton id={`${id}-down-${k}`} icon="arrow-down" size="sm" label={`Move ${noun} ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === items.length - 1} />
                <IconButton icon="trash" size="sm" label={`Remove ${noun} ${i + 1}`} onClick={() => removeAt(i)} />
              </span>
            </li>
          );
        })}
      </ol>
      <div className="cluster">
        <Button size="sm" icon="plus" onClick={() => insertAt(items.length, [''])}>
          Add {noun}
        </Button>
        <span className="small muted">Enter adds the next one; pasting several lines adds one per line.</span>
      </div>
      {error && (
        <div id={errorId} className="field__error">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">
        {status}
      </span>
    </fieldset>
  );
}
