// HOST-5 in the browser: one Server-Sent Events connection for the whole app, following the topics
// the mounted screens ask for with useLiveTopics(). Each event invalidates the queries under its
// topic; the cache refetches what is on screen. On every (re)connection the server sends `ready`
// and everything followed is refetched, which covers events missed while disconnected.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

type Status = 'connecting' | 'live' | 'offline';

interface LiveApi {
  add(topic: string): () => void;
  status: Status;
}

const LiveContext = createContext<LiveApi | null>(null);

export function LiveProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const queryClient = useQueryClient();
  const counts = useRef(new Map<string, number>());
  const [topics, setTopics] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('connecting');

  const api = useMemo<Omit<LiveApi, 'status'>>(
    () => ({
      add(topic) {
        const m = counts.current;
        m.set(topic, (m.get(topic) ?? 0) + 1);
        setTopics([...m.keys()].sort());
        return () => {
          const n = (m.get(topic) ?? 1) - 1;
          if (n <= 0) m.delete(topic);
          else m.set(topic, n);
          setTopics([...m.keys()].sort());
        };
      },
    }),
    [],
  );

  const key = topics.join('|');
  useEffect(() => {
    if (!enabled || !topics.length || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const refetch = (topic: string) => queryClient.invalidateQueries({ queryKey: [topic] });
    const open = () => {
      setStatus('connecting');
      source = new EventSource(`/api/live?${topics.map((t) => `topic=${encodeURIComponent(t)}`).join('&')}`);
      source.addEventListener('ready', () => {
        setStatus('live');
        topics.forEach(refetch);
      });
      source.addEventListener('change', (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent<string>).data) as { topic: string };
          if (ev.topic.startsWith('user:')) void queryClient.invalidateQueries({ queryKey: ['me'] });
          else void refetch(ev.topic.split(':')[0] === 'round' ? 'round' : ev.topic);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener('revoked', () => {
        source?.close();
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      });
      source.onerror = () => {
        if (closed) return;
        // EventSource retries by itself after a dropped connection; a refused one (401, 400) closes.
        if (source?.readyState === EventSource.CLOSED) {
          setStatus('offline');
          void queryClient.invalidateQueries({ queryKey: ['me'] });
          retry = setTimeout(open, 5000);
        } else setStatus('connecting');
      };
    };
    const t = setTimeout(open, 50); // let a burst of mounting screens settle on one connection
    return () => {
      closed = true;
      clearTimeout(t);
      if (retry) clearTimeout(retry);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, queryClient]);

  const value = useMemo(() => ({ ...api, status }), [api, status]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Keeps the given topics live while the calling component is mounted. */
export function useLiveTopics(...topics: string[]): void {
  const ctx = useContext(LiveContext);
  const key = topics.join('|');
  useEffect(() => {
    if (!ctx) return;
    const offs = topics.map((t) => ctx.add(t));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.add, key]);
}

export function useLiveStatus(): Status {
  return useContext(LiveContext)?.status ?? 'offline';
}
