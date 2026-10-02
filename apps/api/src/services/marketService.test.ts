import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FIXTURE_INSTRUMENTS } from '../domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { InstrumentDirectory } from '../domain/instruments/instrumentDirectory.ts';
import { InstrumentResolver } from '../domain/instruments/resolveInstrument.ts';
import type { Bar } from '../market/indicators.ts';
import type { MarketQuote, MarketSearchHit } from '../market/marketData.ts';
import { FakeMarketData } from '../test-support/fakeMarket.ts';
import { MarketService } from './marketService.ts';

const NOW = new Date('2026-10-01T10:00:00.000Z');
const silent = pino({ level: 'silent' });

class StubMarket extends FakeMarketData {
  stubQuotes: MarketQuote[] = [];
  stubBars: Bar[] = [];
  override quotes(): Promise<MarketQuote[]> {
    return Promise.resolve(this.stubQuotes);
  }
  override dailyBars(): Promise<Bar[]> {
    return Promise.resolve(this.stubBars);
  }
}

function service(market: StubMarket, symbols = ['AAA', 'BBB', 'CCC']) {
  const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
  return new MarketService({
    market,
    constituents: {
      list: () =>
        Promise.resolve({
          universe: 'NIFTY 50 (snapshot)',
          constituents: symbols.map((symbol) => ({ symbol, name: `${symbol} Ltd.` })),
        }),
    },
    directory: new InstrumentDirectory(new InstrumentResolver(master, () => NOW), market, silent),
    now: () => NOW,
    logger: silent,
  });
}

const quote = (vendorSymbol: string, fields: Partial<Omit<MarketQuote, keyof MarketSearchHit>>): MarketQuote => ({
  vendorSymbol,
  exchangeCode: 'NSI',
  quoteType: 'EQUITY',
  name: vendorSymbol,
  currency: 'INR',
  price: undefined,
  time: undefined,
  ...fields,
});

describe('MarketService.movers', () => {
  it('derives the change from the previous close and skips quotes without a usable price', async () => {
    const market = new StubMarket(NOW);
    market.stubQuotes = [
      quote('AAA.NS', { price: 110, previousClose: 100, marketState: 'POST', time: new Date('2026-10-01T10:00:00Z') }),
      quote('BBB.NS', { price: 0, change: 1, changePct: 1 }),
      quote('CCC.NS', { price: 95, change: -5, changePct: -5, marketState: 'POST' }),
      quote('ZZZ.NS', { price: 50, change: 5, changePct: 10 }),
    ];
    const movers = await service(market).movers();
    expect(movers.gainers).toEqual([
      { instrumentKey: 'NSE:AAA', symbol: 'AAA', name: 'AAA Ltd.', price: 110, change: 10, changePct: 10 },
    ]);
    expect(movers.losers.map((m) => m.symbol)).toEqual(['CCC']);
    expect(movers).toMatchObject({ universe: 'NIFTY 50 (snapshot)', marketState: 'POST' });
  });

  it('shows no losers on a day when everything rose', async () => {
    const market = new StubMarket(NOW);
    market.stubQuotes = [quote('AAA.NS', { price: 1, change: 0.1, changePct: 1 })];
    const movers = await service(market).movers();
    expect(movers.losers).toEqual([]);
    expect(movers.marketState).toBe('CLOSED');
  });

  it('is unavailable when no quote is usable', async () => {
    await expect(service(new StubMarket(NOW)).movers()).rejects.toMatchObject({ status: 503 });
  });
});

describe('MarketService.chart', () => {
  it('widens a bar whose open lies outside its high/low and drops non-positive bars', async () => {
    const market = new StubMarket(NOW);
    const date = '2026-09-30T03:45:00.000Z';
    market.stubBars = [
      { date, open: 10.6, high: 10.5, low: 9.5, close: 10, volume: 5 },
      { date, open: 0, high: 1, low: 0, close: 1, volume: 5 },
    ];
    const chart = await service(market).chart('NSE:TATASTEEL', '1d');
    expect(chart.bars).toEqual([{ time: date, open: 10.6, high: 10.6, low: 9.5, close: 10, volume: 5 }]);
  });
});
