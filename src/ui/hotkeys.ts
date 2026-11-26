import { useEffect, useRef } from 'react';

export interface HotkeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True when the element is somewhere the user types text (KEY-2). */
export function isTextEntry(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const e = el as { tagName?: string; type?: string; isContentEditable?: boolean };
  const tag = e.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((e.type ?? 'text').toLowerCase());
  return !!e.isContentEditable;
}

/** Normalises a KeyboardEvent key: single characters lower-cased ("N" → "n"), named keys unchanged. */
export function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * KEY-2: shortcuts never fire while typing in a text field or when Ctrl, Alt or Cmd is held.
 * Shift is allowed (it is needed for "?"). Keys in `allowInText` (e.g. "Escape") still fire in text fields.
 */
export function shouldHandleHotkey(e: HotkeyEventLike, allowInText: readonly string[] = []): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || e.isComposing) return false;
  if (isTextEntry(e.target) && !allowInText.includes(normaliseKey(e.key))) return false;
  return true;
}

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

export interface HotkeyOptions {
  enabled?: boolean;
  /** Keys that should also fire inside text fields, e.g. ["Escape"] to leave the notes field. */
  allowInText?: string[];
}

/**
 * Registers page-level shortcuts (KEY-1). Keys are matched after normaliseKey: use "1", "n", "/", "?",
 * "Escape". Shortcuts are suppressed while a modal dialog is open (the dialog owns the keyboard).
 */
export function useHotkeys(map: HotkeyMap, { enabled = true, allowInText = [] }: HotkeyOptions = {}): void {
  const mapRef = useRef(map);
  mapRef.current = map;
  const allowKey = allowInText.join('|');

  useEffect(() => {
    if (!enabled) return;
    const allow = allowKey ? allowKey.split('|') : [];
    const onKeyDown = (e: KeyboardEvent) => {
      const handler = mapRef.current[normaliseKey(e.key)];
      if (!handler || !shouldHandleHotkey(e, allow)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, allowKey]);
}
