import { describe, expect, it } from 'vitest';
import { atr, breakoutUp, ema, rsiDivergence, rsiSeries, volumeRatio, type Bar } from './indicators.ts';

const bar = (close: number, extra: Partial<Bar> = {}): Bar => ({
  date: '2026-01-01',
  open: close,
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

  it('treats zero volume (not reported, e.g. indices) as unavailable', () => {
    const bars = [...Array.from({ length: 20 }, () => bar(100, { volume: 100 })), bar(100, { volume: 0 })];
    expect(volumeRatio(bars)).toBeUndefined();
  });
});

describe('rsiDivergence (swing pivots)', () => {
  // Rally to an overbought peak, pull back, grind to a marginally higher high on weaker momentum, then turn down.
  const bearishSetup = [
    ...Array.from({ length: 40 }, (_, i) => 100 + i * 2),
    ...Array.from({ length: 8 }, (_, i) => 175 - i * 3),
    ...Array.from({ length: 12 }, (_, i) => 156 + i * 2),
    180,
    178,
    176,
    175,
    173,
    172,
  ];

  it('detects a bearish divergence and its mirror image as bullish', () => {
    expect(rsiDivergence(bearishSetup)).toBe('BEARISH');
    expect(rsiDivergence(bearishSetup.map((p) => 300 - p))).toBe('BULLISH');
  });

  it('needs the second high to be confirmed by later bars', () => {
    expect(rsiDivergence(bearishSetup.slice(0, -4))).toBe('NONE');
  });

  it('is undefined without enough history and NONE for a steady uptrend', () => {
    expect(rsiDivergence([1, 2, 3])).toBeUndefined();
    expect(rsiDivergence(Array.from({ length: 80 }, (_, i) => 100 + i))).toBe('NONE');
  });

  it('rarely fires on random walks that contain no real divergence (it is a veto)', () => {
    const rng = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const walks = 400;
    let bearish = 0;
    for (let k = 0; k < walks; k++) {
      const random = rng(1000 + k);
      let price = 100;
      const closes = Array.from({ length: 290 }, () => {
        const gaussian = Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
        price *= Math.exp(0.002 + 0.015 * gaussian);
        return price;
      });
      if (rsiDivergence(closes) === 'BEARISH') bearish++;
    }
    expect(bearish / walks).toBeLessThan(0.04);
  });
});

describe('breakoutUp', () => {
  it('is true only when the latest close clears the high of a narrow prior range', () => {
    const range = Array.from({ length: 30 }, () => bar(100));
    expect(breakoutUp([...range, bar(102)], 30)).toBe(true);
    expect(breakoutUp([...range, bar(101)], 30)).toBe(false);
    expect(breakoutUp(range.slice(0, 10), 30)).toBeUndefined();
  });

  it('is not a breakout when the prior range was wide (no consolidation)', () => {
    const trending = Array.from({ length: 30 }, (_, i) => bar(100 + i * 2));
    expect(breakoutUp([...trending, bar(200)], 30)).toBe(false);
  });
});
