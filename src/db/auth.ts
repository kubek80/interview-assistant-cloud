// Who is signed in (AUTH-1…AUTH-6). The session itself is an HttpOnly cookie the page never sees.
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './http';
import { queryClient, throwIfFatal } from './queryClient';
import type { AuthOptions, DevUser, Me } from '../shared/api';

/** The signed-in person; null when nobody is signed in; undefined while loading. */
export function useMe(): Me | null | undefined {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<Me>('/api/me').catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }),
    staleTime: 60_000,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500 && err.status > 0) && n < 3,
  });
  throwIfFatal(q);
  return q.data;
}

export const hasPermission = (me: Me | null | undefined, permission: string) => !!me?.permissions.includes(permission);

export function useAuthOptions(): AuthOptions | undefined {
  return useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<AuthOptions>('/api/auth/options'), staleTime: Infinity }).data;
}

/** The address that starts Google sign-in; `returnTo` is the app screen to come back to. */
export function googleSignInHref(returnTo: string): string {
  return `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export function useDevUsers(enabled: boolean): DevUser[] | undefined {
  return useQuery({ queryKey: ['dev-users'], queryFn: () => api.get<DevUser[]>('/api/auth/dev/users'), enabled }).data;
}

export async function devSignIn(email: string, returnTo: string): Promise<string> {
  const r = await api.post<{ returnTo: string }>('/api/auth/dev/sign-in', { email, returnTo });
  queryClient.clear();
  return r.returnTo;
}

export async function signOut(): Promise<void> {
  await api.post('/api/auth/sign-out');
  queryClient.clear();
  queryClient.setQueryData(['me'], null);
}
