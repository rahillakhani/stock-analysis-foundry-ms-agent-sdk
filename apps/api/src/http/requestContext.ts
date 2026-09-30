import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuses a caller-supplied request id only if it is short and log-safe; otherwise generates one. */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Shape pino-http passes to the `req` serializer (pino-std-serializers). Only the fields we keep are typed. */
interface SerializedRequest {
  id?: unknown;
  method?: unknown;
  url?: unknown;
}

/**
 * Allowlist, not denylist: request logs carry id, method, and path only. Headers (credentials, proxy auth), the
 * query string (may hold tokens), and client address (PII) are never logged.
 */
function serializeRequest(req: SerializedRequest) {
  const url = typeof req.url === 'string' ? req.url : '';
  const queryStart = url.indexOf('?');
  return { id: req.id, method: req.method, path: queryStart === -1 ? url : url.slice(0, queryStart) };
}

function serializeResponse(res: { statusCode?: unknown }) {
  return { statusCode: res.statusCode };
}

/** Assigns `req.id`, echoes it as `X-Request-Id`, and attaches a request-scoped `req.log`. */
export function requestContext(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: { req: serializeRequest, res: serializeResponse },
    autoLogging: { ignore: (req) => req.url === '/healthz' },
  });
}
