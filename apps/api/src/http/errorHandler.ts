import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, statusTitle, type ProblemDetails } from './errors.ts';

/**
 * Client errors we recognize from express.json() (body-parser via http-errors). Matching on the exact `type` keeps
 * look-alike errors (e.g. SDK errors carrying `status` + `type`) from being reported as the client's fault.
 */
const BODY_PARSER_DETAILS: Record<string, string> = {
  'entity.parse.failed': 'Request body is not valid JSON.',
  'entity.too.large': 'Request body is too large.',
  'entity.verify.failed': 'Request body failed verification.',
  'encoding.unsupported': 'Request body encoding is not supported.',
  'charset.unsupported': 'Request body charset is not supported.',
  'request.aborted': 'Request was aborted by the client.',
  'request.size.invalid': 'Request body size did not match Content-Length.',
  'stream.encoding.set': 'Request body could not be read.',
  'parameters.too.many': 'Request has too many parameters.',
};

function clientErrorFrom(err: unknown): { status: number; detail: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, type } = err as { status?: unknown; type?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined;

  if (typeof type === 'string' && Object.hasOwn(BODY_PARSER_DETAILS, type)) {
    return { status, detail: BODY_PARSER_DETAILS[type] ?? 'The request could not be processed.' };
  }
  // The router marks undecodable path parameters (e.g. `/p/%E0%A4%A`) as URIError with status 400.
  if (err instanceof URIError && status === 400) {
    return { status, detail: 'Request URL contains invalid percent-encoding.' };
  }
  return undefined;
}

function toStatusAndDetail(err: unknown): { status: number; detail: string } {
  if (err instanceof AppError) return { status: err.status, detail: err.detail };
  return clientErrorFrom(err) ?? { status: 500, detail: 'An unexpected error occurred.' };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `No route matches ${req.method} ${req.path}.`));
};

/**
 * Single place where errors become HTTP responses. Clients get problem+json with a generic detail for anything that
 * is not an AppError or a recognized client error; stack traces and internal messages go to the log only.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    // Too late for a problem response; log through pino (request id, redaction) and let Express abort the socket.
    req.log.error({ err }, 'request failed after response started');
    next(err);
    return;
  }

  const { status, detail } = toStatusAndDetail(err);
  if (status >= 500) {
    req.log.error({ err }, 'request failed');
  } else {
    req.log.info({ status, detail }, 'request rejected');
  }

  const body: ProblemDetails = {
    type: 'about:blank',
    title: statusTitle(status),
    status,
    detail,
    instance: req.path,
    requestId: typeof req.id === 'string' ? req.id : 'unknown',
  };
  res.status(status).type('application/problem+json').json(body);
};
