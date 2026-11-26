import { describe, expect, it } from 'vitest';
import { isTextEntry, normaliseKey, shouldHandleHotkey } from './hotkeys';

const ev = (key: string, target: unknown = { tagName: 'BODY' }, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  target: target as EventTarget,
  ...mods,
});

describe('shortcuts', () => {
  it('KEY-2: shortcuts never fire while typing in a text field', () => {
    expect(shouldHandleHotkey(ev('n', { tagName: 'TEXTAREA' }))).toBe(false);
    expect(shouldHandleHotkey(ev('1', { tagName: 'INPUT', type: 'text' }))).toBe(false);
    expect(shouldHandleHotkey(ev('1', { tagName: 'INPUT', type: 'search' }))).toBe(false);
    expect(shouldHandleHotkey(ev('f', { tagName: 'DIV', isContentEditable: true }))).toBe(false);
    expect(shouldHandleHotkey(ev('s', { tagName: 'SELECT' }))).toBe(false);
  });

  it('KEY-2: shortcuts still fire from checkboxes and buttons (e.g. after ticking a key point)', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(shouldHandleHotkey(ev('3', { tagName: 'INPUT', type: 'checkbox' }))).toBe(true);
    expect(shouldHandleHotkey(ev('n', { tagName: 'BUTTON' }))).toBe(true);
  });

  it('KEY-2: shortcuts never fire with Ctrl, Alt or Cmd held; Shift is allowed for "?"', () => {
    expect(shouldHandleHotkey(ev('c', undefined, { ctrlKey: true }))).toBe(false);
    expect(shouldHandleHotkey(ev('c', undefined, { metaKey: true }))).toBe(false);
    expect(shouldHandleHotkey(ev('n', undefined, { altKey: true }))).toBe(false);
    expect(shouldHandleHotkey(ev('?'))).toBe(true);
  });

  it('KEY-1: Esc can be allowed inside the notes field to leave it', () => {
    expect(shouldHandleHotkey(ev('Escape', { tagName: 'TEXTAREA' }), ['Escape'])).toBe(true);
    expect(shouldHandleHotkey(ev('n', { tagName: 'TEXTAREA' }), ['Escape'])).toBe(false);
  });

  it('KEY-1: letter keys match regardless of case', () => {
    expect(normaliseKey('N')).toBe('n');
    expect(normaliseKey('Escape')).toBe('Escape');
  });
});
