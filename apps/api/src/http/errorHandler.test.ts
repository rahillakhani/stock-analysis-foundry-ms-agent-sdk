import express from 'express';
import type { Logger } from 'pino';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test-support/captureLogger.ts';
import { errorHandler, notFoundHandler } from './errorHandler.ts';
import { AppError } from './errors.ts';
import { requestContext } from './requestContext.ts';

/** A minimal app wired with the real middleware plus routes that fail in specific ways. */
function appWithFailingRoutes(logger: Logger = pino({ level: 'silent' })) {
  const app = express();
  app.use(requestContext(logger));
  app.get('/throws', () => {
    throw new Error('db connection failed: password=hunter2');
  });
  app.get('/rejects', () => Promise.reject(new Error('async failure with internal detail')));
  app.get('/app-error', () => {
    throw new AppError(409, 'Analysis already running for NSE:TATASTEEL.');
  });
  app.get('/throws-non-error', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising a non-Error throw on purpose
    throw 'plain string';
  });
  app.get('/sdk-lookalike', () => {
    // Shape of an upstream SDK error (e.g. an OpenAI APIError): server-side failure, not the client's fault.
    throw Object.assign(new Error('Incorrect API key provided'), { status: 401, type: 'invalid_request_error' });
  });
  app.get('/items/:id', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/partial', (_req, res) => {
    res.status(200).write('partial');
    throw new Error('failed mid-stream');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  const app = appWithFailingRoutes();

  it.each(['/throws', '/rejects', '/throws-non-error', '/sdk-lookalike'])(
    'maps unexpected failures on %s to a generic 500 without internals',
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred.',
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/hunter2|internal detail|plain string|API key|\bat \w+ \(/);
    },
  );

  it('uses the status and detail of an AppError', async () => {
    const res = await request(app).get('/app-error');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      title: 'Conflict',
      status: 409,
      detail: 'Analysis already running for NSE:TATASTEEL.',
      instance: '/app-error',
    });
  });

  it('maps an undecodable path parameter to 400, not 500', async () => {
    const res = await request(app).get('/items/%E0%A4%A');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 400, detail: 'Request URL contains invalid percent-encoding.' });
  });

  it('includes the request id so clients can report it', async () => {
    const res = await request(app).get('/throws').set('X-Request-Id', 'support-me');
    expect(res.body).toMatchObject({ requestId: 'support-me' });
  });

  it('logs through the request logger when the response has already started', async () => {
    const { logger, lines } = captureLogger();
    // The socket is aborted mid-response, so the client side may reject; only the server log matters here.
    await request(appWithFailingRoutes(logger))
      .get('/partial')
      .set('X-Request-Id', 'mid-stream')
      .catch(() => undefined);

    expect(lines()).toContainEqual(
      expect.objectContaining({
        msg: 'request failed after response started',
        req: expect.objectContaining({ id: 'mid-stream' }) as unknown,
      }),
    );
  });
});
