// The browser's only way to the server: a small typed JSON client for /api. Every request is
// same-origin, sends the session cookie (HttpOnly; scripts never see it) and, when it changes data,
// the anti-forgery header the server requires (AUTH-5). Errors become ApiError with the server's
// code and a message that is safe to show.
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ApiErrorBody, type ApiErrorCode } from '../shared/api';

export class ApiError extends Error {
  /** Problems as a list (field problems are flattened), for the screens' alert lists. */
  readonly details: string[];
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message: string,
    /** Field problems by field name, when the server gave them. */
    readonly fields: Record<string, string> = {},
    details: string[] = [],
  ) {
    super(message);
    this.details = details.length ? details : Object.values(fields);
  }
}

/** The local app's name for repository errors; screens written for it keep working. */
export { ApiError as RepoError };

let onSignedOut: (() => void) | null = null;
/** Called when any request finds the session gone (signed out elsewhere, deactivated, expired). */
export function setSignedOutHandler(fn: (() => void) | null): void {
  onSignedOut = fn;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function request<T>(method: Method, path: string, body?: unknown, init: { signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(method !== 'GET' ? { [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as ApiErrorBody | null)?.error;
    if (res.status === 401) onSignedOut?.();
    const details = e?.details;
    throw new ApiError(
      res.status,
      e?.code ?? (res.status >= 500 ? 'internal' : 'invalid'),
      e?.message ?? (res.status >= 500 ? 'Something went wrong on the server. Try again.' : 'The request was not accepted.'),
      details && !Array.isArray(details) ? details : {},
      Array.isArray(details) ? details : [],
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, init?: { signal?: AbortSignal }) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Builds a query string from defined values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
