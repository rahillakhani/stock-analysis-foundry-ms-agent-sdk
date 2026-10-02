import { describe, expect, it } from 'vitest';
import { liveQuote } from '../test/fixtures.ts';
import { applyQuote, chartTime, toCandles } from './candles.ts';

// 09:15 IST on 1 Oct 2026 as a wall-clock timestamp (what the chart's UTC axis will print).
const NSE_0915 = Date.UTC(2026, 9, 1, 9, 15) / 1000;

describe('chartTime', () => {
  it.each([
    ['NSE intraday bucket in IST', '2026-10-01T03:47:30.000Z', '5m', 'NSE', NSE_0915],
    [
      'NYSE intraday in New York time (EDT)',
      '2026-10-01T13:30:00.000Z',
      '5m',
      'NYSE',
      Date.UTC(2026, 9, 1, 9, 30) / 1000,
    ],
    ['NSE daily session date', '2026-09-30T20:00:00.000Z', '1d', 'NSE', '2026-10-01'],
    ['NASDAQ daily session date', '2026-10-01T02:00:00.000Z', '1d', 'NASDAQ', '2026-09-30'],
  ] as const)('%s', (_label, iso, interval, exchange, expected) => {
    expect(chartTime(iso, interval, exchange)).toBe(expected);
  });
});

describe('toCandles', () => {
  it('keeps the later bar when two fall in one bucket', () => {
    const bar = { open: 1, high: 2, low: 1, close: 2, volume: 1 };
    const candles = toCandles(
      [
        { ...bar, time: '2026-10-01T03:45:00.000Z' },
        { ...bar, time: '2026-10-01T03:46:00.000Z', close: 1.5 },
      ],
      '5m',
      'NSE',
    );
    expect(candles).toEqual([{ time: NSE_0915, open: 1, high: 2, low: 1, close: 1.5 }]);
  });
});

describe('applyQuote', () => {
  const last = { time: NSE_0915, open: 150, high: 152, low: 149, close: 151 };

  it('moves the close of the current candle and widens its range', () => {
    expect(applyQuote(last, liveQuote(153, '2026-10-01T03:47:00.000Z'), '5m', 'NSE')).toEqual({
      ...last,
      high: 153,
      close: 153,
    });
  });

  it('opens the next candle when the quote is in a new bucket', () => {
    expect(applyQuote(last, liveQuote(148, '2026-10-01T03:51:00.000Z'), '5m', 'NSE')).toEqual({
      time: NSE_0915 + 300,
      open: 148,
      high: 148,
      low: 148,
      close: 148,
    });
  });

  it('ignores a quote older than the last candle, or no candles at all', () => {
    expect(applyQuote(last, liveQuote(148, '2026-10-01T03:40:00.000Z'), '5m', 'NSE')).toBeUndefined();
    expect(applyQuote(undefined, liveQuote(), '5m', 'NSE')).toBeUndefined();
  });

  it('updates the daily candle of the same session', () => {
    const daily = { ...last, time: '2026-10-01' };
    expect(applyQuote(daily, liveQuote(140), '1d', 'NSE')).toEqual({ ...daily, low: 140, close: 140 });
  });
});
