import { describe, expect, it } from 'vitest';
import { Source, SourceId } from './source.ts';

const retrievedAt = '2026-09-30T10:00:00.000Z';

describe('SourceId', () => {
  it.each(['nse:quote:tatasteel:2026-09-30', 'fixture.fin_1', 'a'])('accepts %j', (id) => {
    expect(SourceId.safeParse(id).success).toBe(true);
  });

  it.each(['a/../../etc', 'https://evil.com/x', 'a..b', 'Upper', '', ':leading', 'x'.repeat(129)])(
    'rejects %j',
    (id) => {
      expect(SourceId.safeParse(id).success).toBe(false);
    },
  );
});

describe('Source.url', () => {
  it.each(['https://www.nseindia.com/get-quotes/equity?symbol=TATASTEEL', 'https://example.com'])(
    'accepts %s',
    (url) => {
      expect(Source.safeParse({ id: 's', provider: 'p', url, retrievedAt }).success).toBe(true);
    },
  );

  it.each([
    ['plain http', 'http://example.com/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['embedded credentials', 'https://user:pw@example.com/x'],
    ['bare hostname', 'https:evil'],
    ['over 2048 chars', `https://example.com/${'x'.repeat(2048)}`],
  ])('rejects %s', (_label, url) => {
    expect(Source.safeParse({ id: 's', provider: 'p', url, retrievedAt }).success).toBe(false);
  });
});
