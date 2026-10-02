import { describe, expect, it } from 'vitest';
import { AnalysedStocks, LiveQuote, MarketMovers, PriceBar, PriceChart } from './api.ts';

const T = '2026-10-01T09:45:00.000Z';
const mover = {
  instrumentKey: 'NSE:INFY',
  symbol: 'INFY',
  name: 'Infosys',
  price: 1035,
  change: 40.9,
  changePct: 4.11,
};

describe('market contracts', () => {
  it('accepts movers, chart, quote, and analysed stocks', () => {
    expect(
      MarketMovers.safeParse({ universe: 'NIFTY 50', marketState: 'CLOSED', asOf: T, gainers: [mover], losers: [] })
        .success,
    ).toBe(true);
    expect(
      PriceChart.safeParse({
        instrumentKey: 'NSE:INFY',
        currency: 'INR',
        interval: '1d',
        bars: [{ time: T, open: 10, high: 12, low: 9, close: 11, volume: 5 }],
      }).success,
    ).toBe(true);
    expect(
      LiveQuote.safeParse({
        instrumentKey: 'NASDAQ:MMYT',
        currency: 'USD',
        price: 47.76,
        change: -0.2,
        changePct: -0.42,
        marketState: 'REGULAR',
        time: T,
      }).success,
    ).toBe(true);
    expect(
      AnalysedStocks.safeParse({
        stocks: [
          {
            instrumentKey: 'NSE:MRF',
            name: 'MRF Limited',
            exchange: 'NSE',
            lastAnalysedAt: T,
            indicator: 'DONT_BUY',
            confidenceScore: 40.9,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['high below close', { time: T, open: 10, high: 10.5, low: 9, close: 11, volume: 1 }],
    ['low above open', { time: T, open: 10, high: 12, low: 10.5, close: 11, volume: 1 }],
    ['negative volume', { time: T, open: 10, high: 12, low: 9, close: 11, volume: -1 }],
  ])('rejects a bar with %s', (_label, bar) => {
    expect(PriceBar.safeParse(bar).success).toBe(false);
  });

  it('caps movers at 10 per side', () => {
    expect(
      MarketMovers.safeParse({
        universe: 'NIFTY 50',
        marketState: 'REGULAR',
        asOf: T,
        gainers: Array(11).fill(mover),
        losers: [],
      }).success,
    ).toBe(false);
  });
});
