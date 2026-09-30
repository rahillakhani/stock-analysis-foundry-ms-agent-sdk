import { describe, expect, it } from 'vitest';
import { captureLogger } from './test-support/captureLogger.ts';

describe('createLogger', () => {
  it('redacts credentials in request and response headers (defense in depth for ad-hoc logs)', () => {
    const { logger, raw } = captureLogger();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer token-abc', cookie: 'session=xyz', 'x-api-key': 'key-123' } },
        res: { headers: { 'set-cookie': 'session=xyz' } },
      },
      'request',
    );

    expect(raw()).not.toMatch(/token-abc|session=xyz|key-123/);
    expect(raw().match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it('tags every line with the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello');
    expect(lines()[0]).toMatchObject({ service: 'api', msg: 'hello' });
  });
});
