// Runs the Claude Code CLI (`claude -p`) for the AI second opinion (AI-1, AI-4).
// Never through a shell: spawn() with an argument array; the prompt goes on stdin.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export const ERROR_CODES = Object.freeze({
  cli_missing: 503,
  not_signed_in: 503,
  timeout: 504,
  invalid_output: 502,
  model_refused: 502,
  model_unavailable: 502,
  rate_limited: 429,
  cli_error: 502,
  too_large: 413,
  bad_request: 400,
  busy: 409,
  forbidden: 403,
  unsupported_media_type: 415,
  not_found: 404,
  method_not_allowed: 405,
});

export class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    this.status = ERROR_CODES[code] ?? 500;
  }
}

/** Finds the CLI: CLAUDE_BIN (absolute or on PATH) or `claude` on PATH. Returns null if not found. */
export function resolveClaudeBin(bin = 'claude', env = process.env) {
  const isWin = process.platform === 'win32';
  const candidates = isWin && !/\.(exe|cmd|bat)$/i.test(bin) ? [`${bin}.exe`, bin] : [bin];
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return candidates.find(isFile) ?? null;
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates) {
      const p = join(dir, c);
      if (existsSync(p) && isFile(p)) return p;
    }
  }
  return null;
}

/**
 * Runs a command with an argument array and optional stdin; collects bounded output.
 * Resolves { code, signal, stdout, stderr, timedOut, aborted }; rejects only on spawn failure.
 */
export function runProcess(file, args, { input, timeoutMs, env, cwd, signal, maxOutputBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      reject(new HelperError('cli_missing', 'The claude command found is a .cmd script, which cannot be run safely without a shell. Install the native Claude Code (claude.exe) or set CLAUDE_BIN to it.'));
      return;
    }
    // A .js/.mjs CLAUDE_BIN (such as the test fake) runs with this Node, on every platform.
    if (/\.(mjs|cjs|js)$/i.test(file)) {
      args = [file, ...args];
      file = process.execPath;
    }
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    const kill = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref?.();
    };
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : null;
    const onAbort = () => ((aborted = true), kill());
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b) => {
      outBytes += b.length;
      if (outBytes <= maxOutputBytes) out.push(b);
      else kill();
    });
    child.stderr.on('data', (b) => {
      errBytes += b.length;
      if (errBytes <= 64 * 1024) err.push(b);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, aborted, outBytes });
    });
    child.stdin.on('error', () => {}); // EPIPE if the child exits early; the exit code tells the story
    child.stdin.end(input ?? '');
  });
}

/** `claude --version` → "2.1.331" (or the raw first line); null when the CLI cannot be run. */
export async function getClaudeVersion(bin, env) {
  try {
    const r = await runProcess(bin, ['--version'], { timeoutMs: 15_000, env });
    if (r.code !== 0) return null;
    const m = /(\d+\.\d+\.\d+)/.exec(r.stdout);
    return m ? m[1] : r.stdout.split('\n')[0].trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

/** `claude auth status` → true / false, or null when this CLI version cannot tell. No model call. */
export async function getSignedIn(bin, env) {
  try {
    const r = await runProcess(bin, ['auth', 'status'], { timeoutMs: 15_000, env });
    const json = parseJsonLoose(r.stdout);
    if (json && typeof json.loggedIn === 'boolean') return json.loggedIn;
    if (/not logged in|logged out/i.test(r.stdout + r.stderr)) return false;
    return null;
  } catch {
    return null;
  }
}

function parseJsonLoose(s) {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const lines = t.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
    return null;
  }
}

const AUTH_RE = /not logged in|log ?in|\/login|authenticat|unauthori[sz]ed|invalid api key|oauth|credential|token (has )?expired/i;
const LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|overloaded/i;
const SIZE_RE = /prompt is too long|too long|context (window|length)|request too large/i;

/** The model that did the work, from the CLI's result envelope (`modelUsage` keys). */
export function modelFromEnvelope(env) {
  const usage = env && typeof env.modelUsage === 'object' && env.modelUsage ? env.modelUsage : {};
  let best = null;
  let bestOut = -1;
  for (const [name, u] of Object.entries(usage)) {
    const outTokens = Number(u?.outputTokens ?? 0);
    if (outTokens > bestOut) {
      best = name;
      bestOut = outTokens;
    }
  }
  return best;
}

/**
 * Maps a finished `claude -p --output-format json` run onto { model, output } or a HelperError.
 * Envelope (checked against CLI 2.1.x): { type: "result", subtype: "success" | "error_...",
 * is_error, api_error_status, result, structured_output, stop_reason, terminal_reason, modelUsage }.
 */
export function interpretRun(run) {
  if (run.timedOut) return new HelperError('timeout', 'The AI took too long and was stopped.');
  const env = parseJsonLoose(run.stdout);
  if (!env || env.type !== 'result') {
    if (AUTH_RE.test(run.stderr)) return new HelperError('not_signed_in', 'Claude Code is not signed in on this computer. Run `claude` in a terminal and sign in, then try again.');
    return new HelperError('cli_error', `Claude Code stopped without a result (exit code ${run.code ?? run.signal}).`);
  }
  if (env.is_error) {
    const status = Number(env.api_error_status) || 0;
    const msg = typeof env.result === 'string' ? env.result : '';
    if (status === 401 || status === 403 || AUTH_RE.test(msg)) return new HelperError('not_signed_in', 'Claude Code is not signed in on this computer (or its sign-in has expired). Run `claude` in a terminal and sign in, then try again.');
    if (status === 429 || LIMIT_RE.test(msg)) return new HelperError('rate_limited', 'The Claude subscription on this computer has reached a usage or rate limit. Try again later.');
    if (status === 404 && /model/i.test(msg)) return new HelperError('model_unavailable', 'The configured model is not available to this Claude Code sign-in. Check AI_MODEL.');
    if (status === 413 || SIZE_RE.test(msg)) return new HelperError('too_large', 'The transcript and questions are too long for the model.');
    return new HelperError('cli_error', `Claude Code reported an error${status ? ` (HTTP ${status})` : ''}.`);
  }
  if (env.stop_reason === 'refusal' || env.terminal_reason === 'refusal') return new HelperError('model_refused', 'The model declined to give a second opinion on this transcript.');
  if (env.subtype !== 'success') return new HelperError('invalid_output', 'The model did not return a result in the expected format.');
  const output = env.structured_output;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return new HelperError('invalid_output', 'The model did not return a result in the expected format.');
  return { model: modelFromEnvelope(env), output };
}

/** CLI arguments for one second-opinion run. */
export function buildClaudeArgs({ systemPrompt, schema, model }) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', systemPrompt,
    '--tools', '', // AI-4: no built-in tools (no files, no shell, no web)
    '--strict-mcp-config', // no MCP servers (none are passed with --mcp-config)
    '--setting-sources', '', // ignore user, project and local settings
    '--no-session-persistence',
    '--disable-slash-commands',
    ...(model ? ['--model', model] : []),
  ];
}

/**
 * Runs one second opinion. Works in a fresh empty temporary directory so no project files,
 * CLAUDE.md or settings from the app's folder can influence the model.
 */
export async function runSecondOpinion({ bin, env, model, systemPrompt, schema, prompt, timeoutMs, signal }) {
  const cwd = await mkdtemp(join(tmpdir(), 'ia-ai-'));
  try {
    let run;
    try {
      run = await runProcess(bin, buildClaudeArgs({ systemPrompt, schema, model }), { input: prompt, timeoutMs, env, cwd, signal });
    } catch (e) {
      if (e instanceof HelperError) throw e;
      if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) throw new HelperError('cli_missing', 'The claude command-line tool was not found on this computer.');
      throw new HelperError('cli_error', 'Claude Code could not be started.');
    }
    if (run.aborted) throw new HelperError('cli_error', 'The request was cancelled.');
    const result = interpretRun(run);
    if (result instanceof HelperError) throw result;
    return { model: result.model ?? model ?? 'unknown', output: result.output, outBytes: run.outBytes };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
