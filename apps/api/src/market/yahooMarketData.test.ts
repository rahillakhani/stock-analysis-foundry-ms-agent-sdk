import { describe, expect, it, vi } from 'vitest';
import { MarketDataError, YahooMarketData, type YahooClient } from './yahooMarketData.ts';

function client(overrides: Partial<YahooClient> = {}): YahooClient {
  return {
    search: vi.fn(() => Promise.resolve({ quotes: [], news: [] })),
    quote: vi.fn(() => Promise.resolve({})),
    chart: vi.fn(() => Promise.resolve({ quotes: [] })),
    fundamentalsTimeSeries: vi.fn(() => Promise.resolve([])),
    quoteSummary: vi.fn(() => Promise.resolve({})),
    ...overrides,
  };
}

const httpError = (code: number) =>
  Object.assign(new Error('<html>very long error page…</html>'), { name: 'HTTPError', code });

describe('YahooMarketData parsing', () => {
  it('normalizes search hits and skips malformed or nameless ones', async () => {
    const yahoo = new YahooMarketData({
      client: client({
        search: () =>
          Promise.resolve({
            quotes: [
              { symbol: 'MRF.NS', exchange: 'NSI', quoteType: 'EQUITY', longname: 'MRF Limited' },
              { symbol: 'X', exchange: 'NSI', quoteType: 'EQUITY' },
              { index: 'news-only' },
            ],
            news: [],
          }),
      }),
    });
    expect(await yahoo.search('mrf')).toEqual([
      { vendorSymbol: 'MRF.NS', exchangeCode: 'NSI', quoteType: 'EQUITY', name: 'MRF Limited' },
    ]);
  });

  it('skips null holiday bars and accepts string or number dates', async () => {
    const yahoo = new YahooMarketData({
      client: client({
        chart: () =>
          Promise.resolve({
            quotes: [
              { date: '2026-09-29T03:45:00.000Z', open: 10, high: 11, low: 9, close: 10, volume: 100 },
              {
                date: new Date('2026-09-30T03:45:00.000Z'),
                open: null,
                high: null,
                low: null,
                close: null,
                volume: null,
              },
              { date: Date.parse('2026-10-01T03:45:00.000Z'), open: 11, high: 12, low: 10, close: 11, volume: 200 },
            ],
          }),
      }),
    });
    const bars = await yahoo.dailyBars('MRF.NS', new Date('2026-01-01'));
    expect(bars.map((b) => b.date)).toEqual(['2026-09-29T03:45:00.000Z', '2026-10-01T03:45:00.000Z']);
  });

  it('maps live quote fields and normalizes extended-hours market states', async () => {
    const raw = (symbol: string, marketState: string) => ({
      symbol,
      exchange: 'NSI',
      quoteType: 'EQUITY',
      longName: `${symbol} Ltd`,
      currency: 'INR',
      regularMarketPrice: 105,
      regularMarketChange: 5,
      regularMarketChangePercent: 5,
      regularMarketPreviousClose: 100,
      marketState,
    });
    const quote = vi.fn((symbols: string | string[]) =>
      Promise.resolve(
        Array.isArray(symbols)
          ? [raw('A.NS', 'POSTPOST'), raw('B.NS', 'PREPRE'), { symbol: 'NAMELESS' }, raw('C.NS', 'CLOSED')]
          : raw('A.NS', 'REGULAR'),
      ),
    );
    const yahoo = new YahooMarketData({ client: client({ quote }) });

    expect(await yahoo.quote('A.NS')).toMatchObject({
      change: 5,
      changePct: 5,
      previousClose: 100,
      marketState: 'REGULAR',
    });
    const batch = await yahoo.quotes(['C.NS', 'A.NS', 'B.NS', 'A.NS']);
    expect(batch.map((q) => [q.vendorSymbol, q.marketState])).toEqual([
      ['A.NS', 'POST'],
      ['B.NS', 'PRE'],
      ['C.NS', 'CLOSED'],
    ]);
    // One batched request with de-duplicated symbols, served from cache regardless of order.
    await yahoo.quotes(['B.NS', 'C.NS', 'A.NS']);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(quote).toHaveBeenLastCalledWith(['A.NS', 'B.NS', 'C.NS'], {}, expect.anything());
    expect(await yahoo.quotes([])).toEqual([]);
  });

  it('requests 5-minute bars for intraday charts and keeps the open price', async () => {
    const chart = vi.fn(() =>
      Promise.resolve({
        quotes: [
          { date: '2026-10-01T03:45:00.000Z', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
          { date: '2026-10-01T03:50:00.000Z', open: 10.5, high: null, low: null, close: null, volume: null },
        ],
      }),
    );
    const yahoo = new YahooMarketData({ client: client({ chart }) });
    const from = new Date('2026-10-01T00:00:00.000Z');
    expect(await yahoo.intradayBars('MRF.NS', from)).toEqual([
      { date: '2026-10-01T03:45:00.000Z', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    ]);
    expect(chart).toHaveBeenCalledWith('MRF.NS', { period1: from, interval: '5m' }, expect.anything());
  });

  it('drops a negative P/E and a P/S whose currencies differ (e.g. an ADR)', async () => {
    const adr = new YahooMarketData({
      client: client({
        quoteSummary: () =>
          Promise.resolve({
            summaryDetail: { trailingPE: -5, priceToSalesTrailing12Months: 0.04, currency: 'USD' },
            financialData: { financialCurrency: 'INR' },
          }),
      }),
    });
    expect(await adr.valuation('HDB')).toEqual({ trailingPe: undefined, priceToSales: undefined });

    const domestic = new YahooMarketData({
      client: client({
        quoteSummary: () =>
          Promise.resolve({
            summaryDetail: { trailingPE: 21.7, priceToSalesTrailing12Months: 1.64, currency: 'INR' },
            financialData: { financialCurrency: 'INR' },
          }),
      }),
    });
    expect(await domestic.valuation('MRF.NS')).toEqual({ trailingPe: 21.7, priceToSales: 1.64 });
  });
});

describe('YahooMarketData caching and cancellation', () => {
  it('serves repeat calls from cache within the TTL and refetches after it', async () => {
    let now = 0;
    const quote = vi.fn(() =>
      Promise.resolve({ symbol: 'MMYT', exchange: 'NMS', quoteType: 'EQUITY', longName: 'MakeMyTrip Limited' }),
    );
    const yahoo = new YahooMarketData({ client: client({ quote }), now: () => now });
    await yahoo.quote('MMYT');
    await yahoo.quote('MMYT');
    expect(quote).toHaveBeenCalledTimes(1);
    now = 61_000;
    await yahoo.quote('MMYT');
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const quote = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({
      symbol: 'MMYT',
      exchange: 'NMS',
      quoteType: 'EQUITY',
      longName: 'MakeMyTrip Limited',
    });
    const yahoo = new YahooMarketData({ client: client({ quote }) });
    await expect(yahoo.quote('MMYT')).rejects.toBeInstanceOf(MarketDataError);
    await expect(yahoo.quote('MMYT')).resolves.toMatchObject({ vendorSymbol: 'MMYT' });
  });

  it("lets one caller cancel without failing another caller's shared request", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const quote = vi.fn(() => new Promise((r) => (resolve = r)));
    const yahoo = new YahooMarketData({ client: client({ quote }) });
    const cancelled = new AbortController();
    const first = yahoo.quote('MMYT', cancelled.signal);
    const second = yahoo.quote('MMYT', new AbortController().signal);
    cancelled.abort(new Error('user left'));
    resolve({ symbol: 'MMYT', exchange: 'NMS', quoteType: 'EQUITY', longName: 'MakeMyTrip Limited' });

    await expect(first).rejects.toThrow('user left');
    await expect(second).resolves.toMatchObject({ vendorSymbol: 'MMYT' });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('passes its own deadline signal to the network call', async () => {
    const quote = vi.fn((_s: string, _o: object, moduleOptions: object) => {
      const { signal } = (moduleOptions as { fetchOptions: { signal: AbortSignal } }).fetchOptions;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));
    });
    const yahoo = new YahooMarketData({ client: client({ quote }), requestTimeoutMs: 20 });
    const error = await yahoo.quote('MMYT').catch((err: unknown) => err);
    expect(error).toMatchObject({ name: 'MarketDataError', retryable: true });
  });
});

describe('YahooMarketData error classification', () => {
  it.each([
    [429, true],
    [503, true],
    [404, false],
  ])('HTTP %s is retryable: %s, with a short message', async (code, retryable) => {
    const yahoo = new YahooMarketData({ client: client({ quote: () => Promise.reject(httpError(code)) }) });
    const error = (await yahoo.quote('X').catch((err: unknown) => err)) as MarketDataError;
    expect(error).toBeInstanceOf(MarketDataError);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toBe(`Yahoo Finance request failed (HTTP ${code})`);
  });

  it('treats network failures as retryable', async () => {
    const yahoo = new YahooMarketData({
      client: client({ quote: () => Promise.reject(new TypeError('fetch failed')) }),
    });
    await expect(yahoo.quote('X')).rejects.toMatchObject({ retryable: true });
  });
});
