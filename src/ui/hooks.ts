import { useEffect, useState } from 'react';

/** Current time (epoch ms), refreshed every `intervalMs` while enabled. For timers (RES-2: derive, don't count). */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** RES-3: browser online state. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Sets document.title as "<title> · Interview Assistant". Never pass candidate data (PRIV-3). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Interview Assistant` : 'Interview Assistant';
  }, [title]);
}
