// One error shape for every API response (src/shared/api.ts ApiErrorBody). Messages are plain
// sentences safe to show to the person; stack traces, SQL and internal details never leave the server.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../../src/shared/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: string[] | Record<string, string>,
  ) {
    super(message);
  }
}

export const notSignedIn = () => new ApiError(401, 'not_signed_in', 'Sign in to continue.');
export const forbidden = () => new ApiError(403, 'forbidden', 'You do not have permission to do that.');
export const notFound = (what = 'That') => new ApiError(404, 'not_found', `${what} was not found.`);
export const invalid = (message: string, details?: string[] | Record<string, string>) => new ApiError(400, 'invalid', message, details);
export const conflict = (message: string, details?: string[]) => new ApiError(409, 'conflict', message, details);

/** Zod problems as `{ "field.path": "message" }`, worded for people. */
export function zodDetails(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function errorBody(code: ApiErrorCode, message: string, details?: ApiErrorBody['error']['details'], requestId?: string): ApiErrorBody {
  return { error: { code, message, ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) } };
}

/** Fastify error handler: known errors keep their code; everything else is a plain 500. */
export function handleError(err: FastifyError | ApiError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
  }
  const fe = err as FastifyError;
  const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
  if (status === 413 || fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.status(413).send(errorBody('too_large', 'That is too large to send.'));
  if (status === 415 || fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.status(415).send(errorBody('unsupported', 'Send JSON.'));
  if (fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fe.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || (fe as { type?: string }).type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return reply.status(400).send(errorBody('invalid', 'The request body is not valid JSON.'));
  }
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === '23503') return reply.status(409).send(errorBody('conflict', 'This is still in use elsewhere, so it cannot be changed or removed.'));
  if (pgCode === '23505') return reply.status(409).send(errorBody('conflict', 'That already exists.'));
  if (pgCode === '40001' || pgCode === '40P01') return reply.status(409).send(errorBody('conflict', 'Someone else changed this at the same moment. Try again.'));
  if (status >= 400 && status < 500) return reply.status(status).send(errorBody(status === 404 ? 'not_found' : 'invalid', status === 404 ? 'That was not found.' : 'The request was not accepted.'));
  // HOST-7: log the error class and message, never request bodies; respond without details.
  req.log.error({ err: { type: err.name, message: err.message, code: (err as { code?: string }).code } }, 'request failed');
  return reply.status(500).send(errorBody('internal', 'Something went wrong on the server. Try again; if it keeps happening, tell an administrator.', undefined, req.id));
}
