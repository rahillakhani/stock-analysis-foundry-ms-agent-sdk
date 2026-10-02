import { LiveQuote, MarketMovers, PriceChart } from '@stock-analysis/shared';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { FIXTURE_INSTRUMENTS } from '../domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { InstrumentDirectory } from '../domain/instruments/instrumentDirectory.ts';
import { InstrumentResolver } from '../domain/instruments/resolveInstrument.ts';
import type { ConstituentList } from '../market/indexConstituents.ts';
import type { MarketDataSource } from '../market/marketData.ts';
import { MarketService } from '../services/marketService.ts';
import { FakeMarketData } from '../test-support/fakeMarket.ts';

const NOW = new Date('2026-10-01T10:00:00.000Z');
const silent = pino({ level: 'silent' });
const UNIVERSE: ConstituentList = {
  universe: 'NIFTY 50',
  constituents: Array.from({ length: 30 }, (_, i) => ({ symbol: `CO${i}`, name: `Company ${i} Ltd.` })),
};

function setup(market: MarketDataSource | null = new FakeMarketData(NOW)) {
  const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
  const directory = new InstrumentDirectory(new InstrumentResolver(master, () => NOW), market ?? undefined, silent);
  const service = new MarketService({
    market: market ?? undefined,
    constituents: { list: () => Promise.resolve(UNIVERSE) },
    directory,
    now: () => NOW,
    logger: silent,
  });
  return createApp({ logger: silent, market: service });
}

describe('GET /api/v1/market/movers', () => {
  it('returns the top 10 gainers and losers, ranked, with constituent names', async () => {
    const res = await request(setup()).get('/api/v1/market/movers');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = MarketMovers.parse(res.body);
    // The fake spreads day changes from -15% (CO0) to +14% (CO29); CO15 is unchanged and on neither list.
    expect(body.gainers.map((m) => m.symbol)).toEqual(Array.from({ length: 10 }, (_, i) => `CO${29 - i}`));
    expect(body.losers.map((m) => m.symbol)).toEqual(Array.from({ length: 10 }, (_, i) => `CO${i}`));
    expect(body.gainers[0]).toMatchObject({ instrumentKey: 'NSE:CO29', name: 'Company 29 Ltd.', changePct: 14 });
    expect(body).toMatchObject({ universe: 'NIFTY 50', marketState: 'REGULAR', asOf: NOW.toISOString() });
  });

  it('answers 503 without vendor detail when quotes fail', async () => {
    const market = new FakeMarketData(NOW);
    market.failQuote = true;
    const res = await request(setup(market)).get('/api/v1/market/movers');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.toContain('yahoo');
  });

  it('answers 503 when live market data is turned off', async () => {
    const res = await request(setup(null)).get('/api/v1/market/movers');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'MARKET_DATA_DISABLED' });
  });
});

describe('GET /api/v1/market/chart/:key', () => {
  it('returns a year of daily bars by default, never later than now', async () => {
    const res = await request(setup()).get('/api/v1/market/chart/NSE:TATASTEEL');
    expect(res.status).toBe(200);
    const body = PriceChart.parse(res.body);
    expect(body).toMatchObject({ instrumentKey: 'NSE:TATASTEEL', currency: 'INR', interval: '1d' });
    expect(body.bars.length).toBeGreaterThan(200);
    expect(body.bars.every((b) => b.time <= NOW.toISOString())).toBe(true);
  });

  it("returns only the latest session's 5-minute bars for a web-only US listing", async () => {
    const res = await request(setup()).get('/api/v1/market/chart/NASDAQ:MMYT').query({ interval: '5m' });
    expect(res.status).toBe(200);
    const body = PriceChart.parse(res.body);
    expect(body.currency).toBe('USD');
    const sessions = new Set(
      body.bars.map((b) => new Date(b.time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })),
    );
    expect(sessions.size).toBe(1);
  });

  it.each([
    ['an invalid interval', '/api/v1/market/chart/NSE:TATASTEEL?interval=1h', 400],
    ['a malformed key', '/api/v1/market/chart/not-a-key', 400],
    ['an unknown instrument', '/api/v1/market/chart/NSE:NOSUCH', 404],
    ['a futures contract', `/api/v1/market/chart/${encodeURIComponent('NSE:NIFTY:FUT:2026-10-27')}`, 404],
  ])('rejects %s', async (_label, path, status) => {
    expect((await request(setup()).get(path)).status).toBe(status);
  });

  it('explains that futures contracts have no chart', async () => {
    const res = await request(setup()).get(`/api/v1/market/chart/${encodeURIComponent('NSE:NIFTY:FUT:2026-10-27')}`);
    expect(res.body).toMatchObject({ status: 404, detail: 'Charts and quotes are not available for futures.' });
  });
});

describe('GET /api/v1/market/quote/:key', () => {
  it('returns the live price and day change', async () => {
    const res = await request(setup()).get('/api/v1/market/quote/NASDAQ:MMYT');
    expect(res.status).toBe(200);
    expect(LiveQuote.parse(res.body)).toEqual({
      instrumentKey: 'NASDAQ:MMYT',
      currency: 'USD',
      price: 47.76,
      change: 1.26,
      changePct: 2.7097,
      previousClose: 46.5,
      marketState: 'REGULAR',
      time: NOW.toISOString(),
    });
  });

  it('answers 503 when the vendor is down', async () => {
    const market = new FakeMarketData(NOW);
    market.failQuote = true;
    expect((await request(setup(market)).get('/api/v1/market/quote/NASDAQ:MMYT')).status).toBe(503);
  });
});
