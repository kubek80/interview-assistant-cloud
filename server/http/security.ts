// SEC-1 (hosted form), AUTH-5: response security headers and cross-site request forgery checks.
//
// Content Security Policy, sent as a header on every response: only the app's own scripts, styles,
// images, fonts and connections. Google sign-in is a server-side redirect (the browser navigates
// to Google and back), so no Google origin is needed in any directive: navigations are not
// governed by CSP, and the app never frames, scripts or fetches Google itself.
//
// CSRF: the session cookie is SameSite=Lax, so other sites cannot send it with POST, PUT, PATCH or
// DELETE. On top of that, every state-changing /api request must
//   1. carry the custom header `X-IA-Request: 1` — a cross-site page cannot add a custom header
//      without a CORS preflight, and this server answers no CORS preflight (no CORS at all); and
//   2. when the browser sends an Origin header (all modern browsers do on these requests), come
//      from the app's own origin (PUBLIC_URL); `Sec-Fetch-Site: cross-site` is refused too.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/shared/api';
import type { Config } from '../config';
import { ApiError } from './errors';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'none'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(config: Pick<Config, 'production' | 'secureCookies'>) {
  const headers: Record<string, string> = {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'origin-agent-cluster': '?1',
  };
  if (config.production && config.secureCookies) headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkCsrf(req: FastifyRequest, config: Pick<Config, 'publicOrigin'>): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) throw new ApiError(403, 'csrf', 'This request was refused. Reload the page and try again.');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== config.publicOrigin) throw new ApiError(403, 'csrf', 'This request was refused. Reload the page and try again.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'csrf', 'This request was refused. Reload the page and try again.');
}

export function applyHeaders(reply: FastifyReply, headers: Record<string, string>, api: boolean) {
  reply.headers(headers);
  if (api) reply.header('cache-control', 'no-store');
}
