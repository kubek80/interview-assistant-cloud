// One query cache for the whole app (TanStack Query). Conventions every screen follows:
//   - query keys start with the live-update topic they belong to: ['bank', …], ['users', …],
//     ['audit', …] (step 2: ['round', id, …]). A live event for a topic invalidates every query
//     under it (live.tsx), so open screens refresh within a moment of a change anywhere.
//   - reads retry network and server errors a few times with back-off, never 4xx.
//   - writes are plain async functions (bank.ts, users.ts) that call the API and then invalidate
//     their topic. For HOST-6 (step 2) mutations can switch to useMutation with `networkMode:
//     'offlineFirst'`, optimistic `onMutate` and retry; the cache and keys here already fit that.
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './http';

const retryable = (err: unknown) => !(err instanceof ApiError) || err.code === 'network' || err.status >= 500;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => retryable(err) && count < 3,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

/** Hooks return undefined while loading and null for "not found", as the local app's hooks did. */
export function orNull<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
}
