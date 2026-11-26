import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';

export interface MenuItem {
  /** Visible label; also the accessible name. */
  label: string;
  icon?: IconName;
  /** Shortcut hint shown at the end of the item (KEY-1), e.g. "C". */
  shortcut?: string;
  /** Extra line under the label, e.g. who the interviewers are. */
  detail?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

interface MenuButtonProps {
  label: string;
  items: MenuItem[];
  icon?: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end';
  className?: string;
  /** Words added to the button's accessible name only, e.g. " for Ana Diaz" after "More". */
  srLabel?: string;
}

/**
 * A11Y-1: the WAI-ARIA menu button pattern. Enter, Space or Down opens the menu on its first item
 * (Up on the last); Up/Down/Home/End move; Enter or Space chooses; Esc closes and returns focus to
 * the button; Tab or a click outside closes it. Keys pressed in the menu never reach the page's
 * single-key shortcuts.
 */
export function MenuButton({ label, items, icon = 'chevron-down', variant = 'default', size = 'md', align = 'end', className, srLabel }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<'first' | 'last' | null>(null);

  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  const focusAt = (i: number) => {
    const all = menuItems();
    if (!all.length) return;
    all[(i + all.length) % all.length].focus();
  };

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    if (pendingFocus.current) {
      const all = menuItems();
      (pendingFocus.current === 'last' ? all[all.length - 1] : all[0])?.focus();
      pendingFocus.current = null;
    }
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, close]);

  const openAt = (where: 'first' | 'last') => {
    pendingFocus.current = where;
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openAt(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = menuItems();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    // Keep the page's single-key shortcuts (KEY-1) out of the menu.
    e.stopPropagation();
    if (e.key === 'ArrowDown') focusAt(i + 1);
    else if (e.key === 'ArrowUp') focusAt(i - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(all.length - 1);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
      return;
    } else if (e.key.length === 1) {
      // Type-ahead: the next item starting with that letter.
      const k = e.key.toLowerCase();
      const start = i < 0 ? 0 : i + 1;
      const hit = [...all.slice(start), ...all.slice(0, start)].find((el) => el.textContent?.trim().toLowerCase().startsWith(k));
      hit?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={wrapRef} className={['menu-button', className].filter(Boolean).join(' ')}>
      <button
        ref={buttonRef}
        type="button"
        id={`${id}-button`}
        className={buttonClass(variant, size)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onButtonKey}
      >
        {label}
        {srLabel && <span className="visually-hidden">{srLabel}</span>}
        <Icon name={icon} />
      </button>
      {open && (
        <ul ref={menuRef} id={`${id}-menu`} role="menu" aria-labelledby={`${id}-button`} className={`menu menu--${align}`} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <li
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              aria-keyshortcuts={item.shortcut}
              className="menu__item"
              onClick={() => {
                if (item.disabled) return;
                close(true);
                item.onSelect();
              }}
            >
              {item.icon && <Icon name={item.icon} />}
              <span className="menu__label">
                {item.label}
                {item.detail && <span className="menu__detail">{item.detail}</span>}
              </span>
              {item.shortcut && (
                <kbd className="kbd menu__kbd" aria-hidden="true">
                  {item.shortcut}
                </kbd>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
