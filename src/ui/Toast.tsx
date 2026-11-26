import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { IconButton } from './Button';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  /** Shows a transient message (errors stay until dismissed). Never pass candidate data you would not show on screen. */
  toast: (message: string, tone?: ToastTone) => void;
  /** Screen-reader-only announcement, e.g. a timer turning amber (A11Y-4). */
  announce: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {}, announce: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-3), { id, message, tone }]);
      if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const announce = useCallback((message: string) => {
    // Clear first so repeating the same message is announced again.
    setAnnouncement('');
    setTimeout(() => setAnnouncement(message), 50);
  }, []);

  const api = useMemo(() => ({ toast, announce }), [toast, announce]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region no-print" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            <Icon name={t.tone === 'success' ? 'check' : t.tone === 'info' ? 'info' : 'alert'} />
            <span className="toast__msg">{t.message}</span>
            <IconButton icon="x" label="Dismiss" size="sm" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
