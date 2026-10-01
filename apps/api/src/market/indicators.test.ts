import { describe, expect, it } from 'vitest';
import { atr, breakoutUp, ema, rsiDivergence, rsiSeries, volumeRatio, type Bar } from './indicators.ts';

const bar = (close: number, extra: Partial<Bar> = {}): Bar => ({
  date: '2026-01-01',
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  ...extra,
});

describe('ema', () => {
  it('equals the value for a constant series and needs at least `period` values', () => {
    expect(ema([5, 5, 5, 5], 3)).toBe(5);
    expect(ema([1, 2], 3)).toBeUndefined();
  });

  it('matches a hand-computed EMA(3)', () => {
    // seed SMA(1,2,3)=2; k=0.5; then 4 -> 3, 5 -> 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
  });
});

describe('rsiSeries', () => {
  it('is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    const up = Array.from({ length: 20 }, (_, i) => i);
    expect(rsiSeries(up).at(-1)).toBe(100);
    expect(rsiSeries([...up].reverse()).at(-1)).toBe(0);
  });

  it('stays undefined until there is enough history', () => {
    expect(rsiSeries([1, 2, 3], 14).every((v) => v === undefined)).toBe(true);
  });

  it('oscillates around 50 for equal alternating gains and losses (Wilder smoothing)', () => {
    const zigzag = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 10 : 11));
    const last = rsiSeries(zigzag, 14).at(-1) ?? 0;
    expect(last).toBeGreaterThan(45);
    expect(last).toBeLessThan(55);
  });
});

describe('atr', () => {
  it('equals the constant true range of identical bars', () => {
    expect(atr(Array.from({ length: 20 }, () => bar(100)))).toBeCloseTo(2, 10);
  });

  it('uses gaps against the previous close', () => {
    const bars = [...Array.from({ length: 15 }, () => bar(100)), bar(110, { high: 111, low: 109 })];
    expect(atr(bars)).toBeGreaterThan(2);
    expect(atr(bars.slice(0, 10))).toBeUndefined();
  });
});

describe('volumeRatio', () => {
  it('compares the latest volume with the prior 20-bar average', () => {
    const bars = [...Array.from({ length: 20 }, () => bar(100, { volume: 100 })), bar(100, { volume: 250 })];
    expect(volumeRatio(bars)).toBe(2.5);
    expect(volumeRatio(bars.slice(0, 10))).toBeUndefined();
  });
});

describe('rsiDivergence', () => {
  it('is undefined without two full windows of history', () => {
    expect(rsiDivergence([1, 2, 3])).toBeUndefined();
  });

  it('reports NONE for a steady uptrend (higher highs with non-falling RSI)', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(rsiDivergence(up)).toBe('NONE');
  });

  it('reports BEARISH when price makes a higher high on weaker momentum', () => {
    // Strong rally, pullback, then a slow grind to a marginal new high.
    const rally = Array.from({ length: 28 }, (_, i) => 100 + i * 2); // to 154
    const pullback = Array.from({ length: 10 }, (_, i) => 154 - i * 2); // to 136
    const grind = Array.from({ length: 18 }, (_, i) => 136 + i * 1.2); // to ~156.4 (> 154)
    expect(rsiDivergence([...rally, ...pullback, ...grind])).toBe('BEARISH');
  });
});

describe('breakoutUp', () => {
  it('is true only when the latest close clears the prior range high', () => {
    const range = Array.from({ length: 30 }, () => bar(100));
    expect(breakoutUp([...range, bar(102)], 30)).toBe(true);
    expect(breakoutUp([...range, bar(101)], 30)).toBe(false);
    expect(breakoutUp(range.slice(0, 10), 30)).toBeUndefined();
  });
});
