// The local helper (docs/11, AI-1 and AI-4): serves the built app and the AI second-opinion API
// from one origin on 127.0.0.1, so the app's CSP (connect-src 'self') needs no change.
//
// Privacy (PRIV-3): request bodies, prompts, model output and CLI stderr are never logged. The log
// has one line per API request: method, path, status, error code, sizes and duration.
import { createServer } from 'node:http';
import { HelperError, getClaudeVersion, getSignedIn, resolveClaudeBin, runSecondOpinion } from './lib/claude.mjs';
import { LIMITS, RequestError, SYSTEM_PROMPT, buildOutputSchema, checkOutput, renderPrompt, validateRequest } from './lib/contract.mjs';
import { baseHeaders, createStaticHandler } from './lib/static.mjs';

export const SERVICE_NAME = 'interview-assistant-ai';
export const CLIENT_HEADER = 'x-interview-assistant';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {object} config
 * @param {string} config.distDir       Built app to serve.
 * @param {string} [config.claudeBin]   CLI to run (default "claude" on PATH; CLAUDE_BIN).
 * @param {string|null} [config.model]  Model name or alias for --model (AI_MODEL); null = CLI default.
 * @param {number} [config.timeoutMs]   Per-run timeout (AI_TIMEOUT_MS).
 * @param {NodeJS.ProcessEnv} [config.env] Environment for the CLI (default process.env).
 * @param {(line: string) => void} [config.log] Log sink (default console.log). Receives no content.
 */
export function createHelperServer(config) {
  const env = config.env ?? process.env;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = config.model || null;
  const log = config.log ?? ((line) => console.log(line));
  const serveStatic = createStaticHandler(config.distDir);
  let busy = false;

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, new HelperError('cli_error', 'Unexpected error in the helper.'));
      else res.destroy();
    });
  });
  // A long model call must not be cut by Node's default request timeout.
  server.requestTimeout = timeoutMs + 60_000;
  server.headersTimeout = 30_000;

  const port = () => {
    const a = server.address();
    return a && typeof a === 'object' ? a.port : 0;
  };
  const allowedHosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://helper.invalid');
    const pathname = url.pathname;
    const isApi = pathname === '/api' || pathname.startsWith('/api/');

    // AI-4, DNS rebinding: only http://127.0.0.1:<port> or http://localhost:<port>.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts().includes(host)) {
      return finish(isApi, req, res, started, pathname, sendError(res, new HelperError('forbidden', 'This helper only answers requests for localhost.')));
    }
    if (!isApi) {
      await serveStatic(req, res, pathname);
      return;
    }

    // AI-4: only the app itself. A browser sends Origin on cross-origin requests and on every POST.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      return finish(true, req, res, started, pathname, sendError(res, new HelperError('forbidden', 'Requests from other sites are not accepted.')));
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return finish(true, req, res, started, pathname, sendError(res, new HelperError('forbidden', 'Requests from other sites are not accepted.')));
    }
    // The custom header makes every cross-site request a CORS preflight, which is never approved
    // (no CORS headers are ever sent), so other sites cannot reach the API even with "simple" requests.
    if (req.headers[CLIENT_HEADER] !== '1') {
      return finish(true, req, res, started, pathname, sendError(res, new HelperError('forbidden', 'Missing the app header.')));
    }

    if (pathname === '/api/ai/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return finish(true, req, res, started, pathname, sendError(res, new HelperError('method_not_allowed', 'Use GET.'), { Allow: 'GET, HEAD' }));
      return finish(true, req, res, started, pathname, sendJson(res, 200, await status()));
    }
    if (pathname === '/api/ai/second-opinion') {
      if (req.method !== 'POST') return finish(true, req, res, started, pathname, sendError(res, new HelperError('method_not_allowed', 'Use POST.'), { Allow: 'POST' }));
      return finish(true, req, res, started, pathname, await secondOpinion(req, res));
    }
    return finish(true, req, res, started, pathname, sendError(res, new HelperError('not_found', 'No such endpoint.')));
  }

  function finish(isApi, req, res, started, pathname, result) {
    if (isApi) {
      const { status, code, inBytes = 0, outBytes = 0 } = result ?? {};
      log(`[ai-helper] ${req.method} ${pathname} ${status}${code ? ` ${code}` : ''} in=${inBytes}B out=${outBytes}B ${Date.now() - started}ms`);
    }
    return result;
  }

  async function status() {
    const bin = resolveClaudeBin(config.claudeBin || 'claude', env);
    const base = { service: SERVICE_NAME, model: model ?? null, busy };
    if (!bin) return { ...base, available: false, cli: { found: false, version: null, signedIn: null }, error: { code: 'cli_missing', message: 'The claude command-line tool (Claude Code) was not found on this computer.' } };
    const [version, signedIn] = await Promise.all([getClaudeVersion(bin, env), getSignedIn(bin, env)]);
    if (!version) return { ...base, available: false, cli: { found: true, version: null, signedIn }, error: { code: 'cli_missing', message: 'The claude command-line tool was found but could not be run.' } };
    if (signedIn === false) return { ...base, available: false, cli: { found: true, version, signedIn }, error: { code: 'not_signed_in', message: 'Claude Code is not signed in on this computer. Run `claude` in a terminal and sign in.' } };
    return { ...base, available: true, cli: { found: true, version, signedIn } };
  }

  async function secondOpinion(req, res) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return sendError(res, new HelperError('unsupported_media_type', 'Send JSON (Content-Type: application/json).'));
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > LIMITS.maxRequestBytes) {
      req.resume();
      return sendError(res, new HelperError('too_large', 'The request is too large.'), { Connection: 'close' });
    }
    let raw;
    try {
      raw = await readBody(req, LIMITS.maxRequestBytes);
    } catch (e) {
      return sendError(res, e instanceof HelperError ? e : new HelperError('bad_request', 'The request could not be read.'), { Connection: 'close' });
    }
    const inBytes = raw.length;
    let request;
    try {
      request = validateRequest(JSON.parse(raw.toString('utf8')));
    } catch (e) {
      const message = e instanceof RequestError ? e.message : 'The request is not valid JSON.';
      return { ...sendError(res, new HelperError('bad_request', message)), inBytes };
    }
    if (busy) return { ...sendError(res, new HelperError('busy', 'An AI second opinion is already running. Wait for it to finish.')), inBytes };
    const bin = resolveClaudeBin(config.claudeBin || 'claude', env);
    if (!bin) return { ...sendError(res, new HelperError('cli_missing', 'The claude command-line tool (Claude Code) was not found on this computer.')), inBytes };

    busy = true;
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    const started = Date.now();
    try {
      const result = await runSecondOpinion({
        bin,
        env,
        model,
        systemPrompt: SYSTEM_PROMPT,
        schema: buildOutputSchema(request.questions.map((q) => q.id)),
        prompt: renderPrompt(request),
        timeoutMs,
        signal: abort.signal,
      });
      if (checkOutput(result.output, request)) throw new HelperError('invalid_output', 'The model did not return a result in the expected format.');
      return { ...sendJson(res, 200, { ok: true, model: result.model, durationMs: Date.now() - started, output: result.output }), inBytes };
    } catch (e) {
      return { ...sendError(res, e instanceof HelperError ? e : new HelperError('cli_error', 'Claude Code could not complete the request.')), inBytes };
    } finally {
      busy = false;
      res.off('close', onClose);
    }
  }

  return server;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HelperError('too_large', 'The request is too large.'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', (e) => !failed && reject(e));
  });
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  if (!res.headersSent && !res.destroyed) {
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...extra });
    res.end(text);
  }
  return { status, outBytes: Buffer.byteLength(text), code: body?.error?.code };
}

function sendError(res, err, extra = {}) {
  return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } }, extra);
}
