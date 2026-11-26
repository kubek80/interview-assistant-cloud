import { describe, expect, it, vi } from 'vitest';
import type { SecondOpinionRequest } from '../domain/ai/types';
import { AiClientError, getAiStatus, probeAiStatus, requestSecondOpinion } from './client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const payload: SecondOpinionRequest = { version: 1, questions: [], transcript: { text: 'Candidate: hi', speakers: ['Candidate'] } };

describe('AI-1 probeAiStatus', () => {
  it('AI-1 OV-1: without the helper marker on the app page it never calls the API (no 404 to log), and with it reads the status', async () => {
    const statics = vi.fn(async (url: string) => (url === './' ? new Response(null, { status: 200 }) : new Response('Not found', { status: 404 })));
    expect(await probeAiStatus({ fetch: statics as unknown as typeof fetch })).toMatchObject({ state: 'unavailable', reason: 'helper_unavailable' });
    expect(statics.mock.calls.map((c) => c[0])).toEqual(['./']);
    expect((statics.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('HEAD');

    const helper = vi.fn(async (url: string) =>
      url === './'
        ? new Response(null, { status: 200, headers: { 'X-Interview-Assistant-Helper': 'interview-assistant-ai' } })
        : json(200, { service: 'interview-assistant-ai', available: true, model: 'sonnet', busy: false, cli: { found: true, version: '2.1.0', signedIn: true } }),
    );
    expect(await probeAiStatus({ fetch: helper as unknown as typeof fetch })).toEqual({ state: 'ready', cliVersion: '2.1.0', model: 'sonnet', busy: false });
    expect(helper.mock.calls.map((c) => c[0])).toEqual(['./', 'api/ai/status']);

    // The dev server forwards /api to the helper: it skips the marker check.
    const dev = vi.fn(async () => json(200, { service: 'interview-assistant-ai', available: true, model: null, busy: false, cli: { found: true, version: '2.1.0' } }));
    expect(await probeAiStatus({ fetch: dev as unknown as typeof fetch, skipMarker: true })).toMatchObject({ state: 'ready' });
    expect(dev.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['api/ai/status']);
  });
});

describe('AI-1 getAiStatus', () => {
  it('AI-1: reports ready with the CLI version and configured model, sending the app header same-origin', async () => {
    const fetch = vi.fn(async () => json(200, { service: 'interview-assistant-ai', available: true, model: null, busy: false, cli: { found: true, version: '2.1.331', signedIn: true } }));
    expect(await getAiStatus({ fetch })).toEqual({ state: 'ready', cliVersion: '2.1.331', model: null, busy: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/ai/status');
    expect(init.headers).toMatchObject({ 'X-Interview-Assistant': '1' });
    expect(init.cache).toBe('no-store');
  });

  it('AI-1: resolves to unavailable (no throw, no console output) without a helper: network error, 404, HTML', async () => {
    const spy = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    for (const fetch of [
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      vi.fn(async () => new Response('Not found', { status: 404 })),
      vi.fn(async () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
      vi.fn(async () => json(200, { something: 'else' })),
    ]) {
      expect(await getAiStatus({ fetch })).toMatchObject({ state: 'unavailable', reason: 'helper_unavailable', message: expect.stringMatching(/npm start/) });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('AI-1: explains a missing or signed-out CLI', async () => {
    const missing = vi.fn(async () => json(200, { service: 'interview-assistant-ai', available: false, cli: { found: false, version: null }, error: { code: 'cli_missing', message: 'x' } }));
    expect(await getAiStatus({ fetch: missing })).toMatchObject({ state: 'unavailable', reason: 'cli_missing' });
    const out = vi.fn(async () => json(200, { service: 'interview-assistant-ai', available: false, cli: { found: true, version: '2.1.0' }, error: { code: 'not_signed_in', message: 'x' } }));
    expect(await getAiStatus({ fetch: out })).toMatchObject({ state: 'unavailable', reason: 'not_signed_in', cliVersion: '2.1.0', message: expect.stringMatching(/sign in/) });
  });
});

describe('AI-3 requestSecondOpinion', () => {
  it('AI-3: posts the payload as JSON with the app header and returns the reply', async () => {
    const fetch = vi.fn(async () => json(200, { ok: true, model: 'claude-x', durationMs: 42, output: { questions: [] } }));
    expect(await requestSecondOpinion(payload, { fetch })).toEqual({ ok: true, model: 'claude-x', durationMs: 42, output: { questions: [] } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/ai/second-opinion');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(payload));
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Interview-Assistant': '1' });
  });

  it('AI-1: maps helper error codes to messages that are safe to show', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [503, 'not_signed_in', /sign in/],
      [503, 'cli_missing', /not found/],
      [504, 'timeout', /too long/],
      [502, 'invalid_output', /discarded/],
      [502, 'model_refused', /declined/],
      [429, 'rate_limited', /limit/],
      [413, 'too_large', /too large/],
      [409, 'busy', /already running/],
    ];
    for (const [status, code, message] of cases) {
      const fetch = vi.fn(async () => json(status, { ok: false, error: { code, message: 'helper text <b>not shown</b>' } }));
      const err = await requestSecondOpinion(payload, { fetch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiClientError);
      expect((err as AiClientError).code).toBe(code);
      expect((err as AiClientError).status).toBe(status);
      expect((err as AiClientError).message).toMatch(message);
      expect((err as AiClientError).message).not.toContain('helper text');
    }
  });

  it('AI-1: no helper, unknown replies and cancellation', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(requestSecondOpinion(payload, { fetch: down })).rejects.toMatchObject({ code: 'helper_unavailable' });
    const notFound = vi.fn(async () => new Response('<html>', { status: 404, headers: { 'Content-Type': 'text/html' } }));
    await expect(requestSecondOpinion(payload, { fetch: notFound })).rejects.toMatchObject({ code: 'helper_unavailable' });
    const weird = vi.fn(async () => json(200, { ok: true }));
    await expect(requestSecondOpinion(payload, { fetch: weird })).rejects.toMatchObject({ code: 'bad_response' });
    const unknownCode = vi.fn(async () => json(500, { ok: false, error: { code: 'exploded' } }));
    await expect(requestSecondOpinion(payload, { fetch: unknownCode })).rejects.toMatchObject({ code: 'bad_response' });
    const controller = new AbortController();
    const slow = vi.fn(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(requestSecondOpinion(payload, { fetch: slow, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});
