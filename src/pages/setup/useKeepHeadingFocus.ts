import { useEffect } from 'react';

/**
 * A11Y-2: Setup first renders a loading heading, then swaps in the editor or locked view with its
 * own h1. If the layout had already focused the loading heading, that focus is lost with it; put
 * it back on the new screen heading.
 */
export function useKeepHeadingFocus(): void {
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const h1 = document.querySelector<HTMLElement>('main h1');
    if (!h1) return;
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }, []);
}
