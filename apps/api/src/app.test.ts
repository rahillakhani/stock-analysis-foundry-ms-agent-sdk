import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { captureLogger } from './test-support/captureLogger.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const app = createApp({ logger: pino({ level: 'silent' }) });

describe('createApp', () => {
  it('GET /healthz returns ok with a generated request id', async () => {
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('echoes a safe caller-supplied X-Request-Id', async () => {
    const res = await request(app).get('/healthz').set('X-Request-Id', 'client-trace-1');
    expect(res.headers['x-request-id']).toBe('client-trace-1');
  });

  it('replaces an unsafe caller-supplied X-Request-Id', async () => {
    const res = await request(app).get('/healthz').set('X-Request-Id', 'x'.repeat(200));
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns problem+json 404 for unknown routes, with the same id in header and body', async () => {
    const res = await request(app).get('/nope').set('X-Request-Id', 'req-404');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe('req-404');
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No route matches GET /nope.',
      instance: '/nope',
      requestId: 'req-404',
    });
  });

  it('does not echo the query string in problem responses', async () => {
    const res = await request(app).get('/nope?token=SECRETQ');
    expect(res.body).toMatchObject({ instance: '/nope' });
    expect(JSON.stringify(res.body)).not.toContain('SECRETQ');
  });

  it('returns 400 problem+json for malformed JSON without leaking parser internals', async () => {
    const res = await request(app).post('/healthz').set('Content-Type', 'application/json').send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 400, title: 'Bad Request', detail: 'Request body is not valid JSON.' });
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|at JSON\.parse|node_modules/);
  });

  it('returns 413 problem+json for bodies over the 100kb limit', async () => {
    const res = await request(app)
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(101 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ status: 413, detail: 'Request body is too large.' });
  });
});

describe('request logging', () => {
  it('logs id, method, path, and status only: no headers, query string, or client address', async () => {
    const { logger, lines, raw } = captureLogger();
    await request(createApp({ logger }))
      .get('/nope?token=SECRETQ')
      .set('X-Request-Id', 'log-check')
      .set('Authorization', 'Bearer AUTHSECRET')
      .set('Proxy-Authorization', 'Basic PROXYSECRET')
      .set('Cookie', 'session=COOKIESECRET')
      .set('X-Forwarded-For', '203.0.113.9');

    const completed = lines().find((line) => line.msg === 'request completed');
    expect(completed).toMatchObject({
      req: { id: 'log-check', method: 'GET', path: '/nope' },
      res: { statusCode: 404 },
    });
    expect(Object.keys(completed?.req as object).sort()).toEqual(['id', 'method', 'path']);
    expect(raw()).not.toMatch(/SECRETQ|AUTHSECRET|PROXYSECRET|COOKIESECRET|203\.0\.113\.9|remoteAddress|headers/);
  });

  it('does not log health checks', async () => {
    const { logger, lines } = captureLogger();
    await request(createApp({ logger })).get('/healthz');
    expect(lines()).toEqual([]);
  });
});
