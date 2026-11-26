// Browser client for the local AI helper (docs/11, AI-1, AI-3). Same-origin only (CSP connect-src 'self').
// Never logs: request and response bodies contain candidate data (PRIV-3).
import {
  AI_CLIENT_HEADER,
  AI_CLIENT_HEADER_VALUE,
  AI_SECOND_OPINION_PATH,
  AI_STATUS_PATH,
  type SecondOpinionRequest,
  type SecondOpinionResponse,
} from '../domain/ai/types';

/** Error codes the helper returns (server/lib/claude.mjs ERROR_CODES) plus client-side ones. */
export type AiErrorCode =
  | 'cli_missing'
  | 'not_signed_in'
  | 'timeout'
  | 'invalid_output'
  | 'model_refused'
  | 'model_unavailable'
  | 'rate_limited'
  | 'cli_error'
  | 'too_large'
  | 'bad_request'
  | 'busy'
  | 'forbidden'
  | 'unsupported_media_type'
  | 'not_found'
  | 'method_not_allowed'
  // client side
  | 'helper_unavailable'
  | 'offline'
  | 'aborted'
  | 'bad_response';

/** Messages safe to show: they never contain transcript or model text. */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  cli_missing: 'Claude Code (the claude command-line tool) was not found on this computer. Install it and sign in, then restart the app with npm start.',
  not_signed_in: 'Claude Code is not signed in on this computer. Open a terminal, run claude and sign in, then try again.',
  timeout: 'The AI took too long and was stopped. Try again, or try a shorter transcript.',
  invalid_output: 'The AI reply was not in the expected format, so it was discarded. Try again.',
  model_refused: 'The AI declined to give a second opinion on this transcript.',
  model_unavailable: 'The AI model chosen for the helper is not available to this Claude Code sign-in. Check AI_MODEL.',
  rate_limited: 'The Claude subscription on this computer has reached a usage or rate limit. Try again later.',
  cli_error: 'Claude Code reported an error. Try again.',
  too_large: 'The transcript and questions are too large to send.',
  bad_request: 'The helper rejected the request. Reload the app and try again.',
  busy: 'An AI second opinion is already running. Wait for it to finish.',
  forbidden: 'The helper refused the request. Open the app at the address npm start printed (http://localhost:…).',
  unsupported_media_type: 'The helper rejected the request. Reload the app and try again.',
  not_found: 'The AI helper is not running. Start the app with npm start on this computer.',
  method_not_allowed: 'The helper rejected the request. Reload the app and try again.',
  helper_unavailable: 'The AI helper is not running. Start the app with npm start on this computer to use the AI second opinion.',
  offline: 'The AI helper could not be reached. Check that npm start is still running.',
  aborted: 'The AI second opinion was cancelled.',
  bad_response: 'The AI helper sent an unexpected reply.',
};

export class AiClientError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status when the helper answered. */
  readonly status: number | null;
  constructor(code: AiErrorCode, status: number | null = null) {
    super(AI_ERROR_MESSAGES[code]);
    this.name = 'AiClientError';
    this.code = code;
    this.status = status;
  }
}

export type AiStatus =
  | {
      state: 'ready';
      cliVersion: string | null;
      /** Model set with AI_MODEL, or null for Claude Code's default. */
      model: string | null;
      busy: boolean;
    }
  | {
      state: 'unavailable';
      /** helper_unavailable: no helper (static hosting, `npm run dev` without it, offline). */
      reason: 'helper_unavailable' | 'cli_missing' | 'not_signed_in' | 'error';
      message: string;
      cliVersion: string | null;
    };

export interface AiClientOptions {
  signal?: AbortSignal;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const SERVICE_NAME = 'interview-assistant-ai';
const headers = () => ({ [AI_CLIENT_HEADER]: AI_CLIENT_HEADER_VALUE, Accept: 'application/json' });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(res: Response): Promise<unknown> {
  if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

const unavailable = (reason: Extract<AiStatus, { state: 'unavailable' }>['reason'], message: string, cliVersion: string | null = null): AiStatus => ({
  state: 'unavailable',
  reason,
  message,
  cliVersion,
});

/**
 * AI-1: whether the AI second opinion can run here. Never throws (except when `signal` aborts):
 * with no helper (static hosting, offline, 404, HTML instead of JSON) it resolves to
 * { state: 'unavailable', reason: 'helper_unavailable' }. The browser may still log the failed
 * request itself; the app adds nothing to the console.
 */
export async function getAiStatus(options: AiClientOptions = {}): Promise<AiStatus> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(AI_STATUS_PATH, { method: 'GET', headers: headers(), cache: 'no-store', credentials: 'same-origin', signal: options.signal });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    return unavailable('helper_unavailable', AI_ERROR_MESSAGES.helper_unavailable);
  }
  const body = await readJson(res);
  if (!res.ok || !isObject(body) || body.service !== SERVICE_NAME) {
    return unavailable('helper_unavailable', AI_ERROR_MESSAGES.helper_unavailable);
  }
  const cli = isObject(body.cli) ? body.cli : {};
  const cliVersion = typeof cli.version === 'string' ? cli.version : null;
  if (body.available === true) {
    return { state: 'ready', cliVersion, model: typeof body.model === 'string' ? body.model : null, busy: body.busy === true };
  }
  const code = isObject(body.error) ? body.error.code : null;
  if (code === 'cli_missing') return unavailable('cli_missing', AI_ERROR_MESSAGES.cli_missing, cliVersion);
  if (code === 'not_signed_in') return unavailable('not_signed_in', AI_ERROR_MESSAGES.not_signed_in, cliVersion);
  return unavailable('error', AI_ERROR_MESSAGES.cli_error, cliVersion);
}

/** AI-1: response header the local helper puts on the app's own files (server/lib/static.mjs). */
export const HELPER_MARKER_HEADER = 'X-Interview-Assistant-Helper';
export const HELPER_MARKER_VALUE = 'interview-assistant-ai';

/**
 * AI-1: like getAiStatus, but first checks quietly whether the app is served by the local helper:
 * a HEAD request for the app's own page, which exists on any host, must carry the helper's marker
 * header. On a static copy of the app (or `vite preview`) there is no marker, so no request is made
 * to the missing API endpoint and the browser logs nothing. Offline, nothing is requested at all.
 * `skipMarker` (the Vite dev server, which forwards /api to the helper) goes straight to the API.
 */
export async function probeAiStatus(options: AiClientOptions & { skipMarker?: boolean } = {}): Promise<AiStatus> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return unavailable('helper_unavailable', AI_ERROR_MESSAGES.offline);
  if (!options.skipMarker) {
    const doFetch = options.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch('./', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: options.signal });
    } catch (e) {
      if (options.signal?.aborted) throw e;
      return unavailable('helper_unavailable', AI_ERROR_MESSAGES.helper_unavailable);
    }
    if (res.headers.get(HELPER_MARKER_HEADER) !== HELPER_MARKER_VALUE) return unavailable('helper_unavailable', AI_ERROR_MESSAGES.helper_unavailable);
  }
  return getAiStatus(options);
}

const KNOWN_CODES = new Set(Object.keys(AI_ERROR_MESSAGES));

/**
 * AI-3: runs the second opinion (call only after the person has confirmed the disclosure from
 * describePayload). Resolves to the helper's reply; `output` is unvalidated and must go through
 * createSecondOpinion / validateSecondOpinionOutput. Throws AiClientError with a safe message.
 */
export async function requestSecondOpinion(payload: SecondOpinionRequest, options: AiClientOptions = {}): Promise<SecondOpinionResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(AI_SECOND_OPINION_PATH, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) throw new AiClientError('aborted');
    throw new AiClientError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'helper_unavailable');
  }
  let body: unknown;
  try {
    body = await readJson(res);
  } catch {
    body = undefined;
  }
  if (options.signal?.aborted) throw new AiClientError('aborted');
  if (!res.ok) {
    const code = isObject(body) && isObject(body.error) && typeof body.error.code === 'string' && KNOWN_CODES.has(body.error.code) ? (body.error.code as AiErrorCode) : null;
    if (code) throw new AiClientError(code, res.status);
    throw new AiClientError(res.status === 404 || res.status === 405 ? 'helper_unavailable' : 'bad_response', res.status);
  }
  if (!isObject(body) || body.ok !== true || typeof body.model !== 'string' || !('output' in body)) {
    throw new AiClientError('bad_response', res.status);
  }
  return { ok: true, model: body.model, durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0, output: body.output };
}
