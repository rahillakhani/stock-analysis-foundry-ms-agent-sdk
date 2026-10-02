import { describe, expect, it, vi } from 'vitest';
import { IndexConstituents, parseConstituentsCsv, type FetchLike } from './indexConstituents.ts';

const HEADER = 'Company Name,Industry,Symbol,Series,ISIN Code';
const csv = (count: number, extra: string[] = []) =>
  [
    HEADER,
    ...Array.from({ length: count }, (_, i) => `Company ${i} Ltd.,Services,CO${i},EQ,INE000A0100${i}`),
    ...extra,
  ].join('\r\n');
const respond = (body: string, status = 200): FetchLike =>
  vi.fn(() => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(body) }));

describe('parseConstituentsCsv', () => {
  it('reads symbols and names by header, skipping non-EQ series and invalid symbols', () => {
    const parsed = parseConstituentsCsv(csv(45, ['M&M Ltd.,Auto,M&M,EQ,X', 'Odd,X,lower,EQ,X', 'Be Ltd.,X,BECO,BE,X']));
    expect(parsed).toHaveLength(46);
    expect(parsed?.[0]).toEqual({ symbol: 'CO0', name: 'Company 0 Ltd.' });
    expect(parsed?.at(-1)).toEqual({ symbol: 'M&M', name: 'M&M Ltd.' });
  });

  it.each([
    ['a truncated list', csv(10)],
    ['an unexpected header', 'Name,Ticker\nA,B'],
    ['an HTML error page', '<html>blocked</html>'],
  ])('rejects %s', (_label, body) => {
    expect(parseConstituentsCsv(body)).toBeUndefined();
  });
});

describe('IndexConstituents', () => {
  it('caches the official list and shares one download between concurrent callers', async () => {
    let now = 0;
    const fetch = respond(csv(50));
    const index = new IndexConstituents({ fetch, now: () => now, ttlMs: 1_000 });

    const [a, b] = await Promise.all([index.list(), index.list()]);
    expect(a).toBe(b);
    expect(a.universe).toBe('NIFTY 50');
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 1_001;
    await index.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to the labelled snapshot when the file is unavailable, and reports why', async () => {
    const onFallback = vi.fn();
    const index = new IndexConstituents({ fetch: respond('', 403), onFallback });
    const list = await index.list();
    expect(list.universe).toBe('NIFTY 50 (snapshot)');
    expect(list.constituents.map((c) => c.symbol)).toEqual(expect.arrayContaining(['RELIANCE', 'M&M', 'BAJAJ-AUTO']));
    expect(list.constituents).toHaveLength(50);
    expect(onFallback).toHaveBeenCalledWith('HTTP 403');
  });

  it('keeps the last good list when a refresh fails, and does not retry on every call', async () => {
    let now = 0;
    let fail = false;
    const fetch: FetchLike = vi.fn(() =>
      fail
        ? Promise.reject(new TypeError('fetch failed'))
        : respond(csv(50))('', { signal: AbortSignal.abort(), headers: {} }),
    );
    const index = new IndexConstituents({ fetch, now: () => now, ttlMs: 1_000 });
    await index.list();

    fail = true;
    now = 2_000;
    expect((await index.list()).universe).toBe('NIFTY 50');
    await index.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
