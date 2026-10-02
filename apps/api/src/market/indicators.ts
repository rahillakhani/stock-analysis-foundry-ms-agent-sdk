// Technical indicators computed from daily OHLCV bars, so every technical metric is deterministic and reproducible
// from the stored price history (no vendor-computed values). Bars are oldest first.

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Exponential moving average seeded with the simple average of the first `period` values (standard method). */
export function ema(values: readonly number[], period: number): number | undefined {
  if (values.length < period || period < 1) return undefined;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (const v of values.slice(period)) value = v * k + value * (1 - k);
  return value;
}

/** Wilder's RSI series (aligned so result[i] is RSI after values[i]; undefined until enough data). */
export function rsiSeries(values: readonly number[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = values.map(() => undefined);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  const rsi = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = rsi();
  for (let i = period + 1; i < values.length; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = rsi();
  }
  return out;
}

/** Wilder's average true range of the latest bar. */
export function atr(bars: readonly Bar[], period = 14): number | undefined {
  if (bars.length <= period) return undefined;
  const trueRanges = bars.slice(1).map((bar, i) => {
    const prevClose = bars[i]?.close ?? bar.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });
  let value = trueRanges.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (const tr of trueRanges.slice(period)) value = (value * (period - 1) + tr) / period;
  return value;
}

/** Latest bar's volume divided by the average of the `period` bars before it. */
export function volumeRatio(bars: readonly Bar[], period = 20): number | undefined {
  if (bars.length <= period) return undefined;
  const prior = bars.slice(-period - 1, -1);
  const average = prior.reduce((sum, bar) => sum + bar.volume, 0) / period;
  const latest = bars[bars.length - 1];
  // Zero volume (e.g. index quotes) means volume isn't reported, not that nothing traded.
  return average > 0 && latest && latest.volume > 0 ? latest.volume / average : undefined;
}

export interface DivergenceOptions {
  /** Bars searched for the two most recent swing pivots. */
  lookback: number;
  /** A pivot must be the extreme of `pivotWidth` bars on each side (so the newest `pivotWidth` bars can't pivot). */
  pivotWidth: number;
  /** Minimum bars between the two pivots compared. */
  minSeparation: number;
  /** Minimum RSI disagreement, in points, to count as divergence. */
  minRsiGap: number;
  /** BEARISH needs momentum to have been strong at the first high (RSI >= this); BULLISH mirrors it (<= 100 - this). */
  extremeRsi: number;
}

/**
 * Tuned on seeded random walks (no real divergence): about 0.4% (no drift) / 1.9% (+0.2%/day drift) false BEARISH
 * signals, versus 10–23% for a naive two-window max/min comparison. The first high must be overbought (RSI >= 70).
 */
export const DIVERGENCE_DEFAULTS: DivergenceOptions = {
  lookback: 30,
  pivotWidth: 3,
  minSeparation: 5,
  minRsiGap: 8,
  extremeRsi: 70,
};

function pivots(closes: readonly number[], from: number, width: number, kind: 'high' | 'low'): number[] {
  const out: number[] = [];
  for (let i = Math.max(from, width); i < closes.length - width; i++) {
    const window = closes.slice(i - width, i + width + 1);
    const value = closes[i] ?? NaN;
    if (value === (kind === 'high' ? Math.max(...window) : Math.min(...window))) out.push(i);
  }
  return out;
}

/**
 * Classic swing-pivot RSI divergence: compare the two most recent confirmed swing highs (lows) within `lookback`
 * bars. BEARISH when price makes a higher high while RSI makes a lower high by at least `minRsiGap` points after
 * strong momentum; BULLISH mirrors it on swing lows; otherwise NONE. Undefined without enough history.
 */
export function rsiDivergence(
  closes: readonly number[],
  options: DivergenceOptions = DIVERGENCE_DEFAULTS,
  period = 14,
): 'BEARISH' | 'BULLISH' | 'NONE' | undefined {
  const { lookback, pivotWidth, minSeparation, minRsiGap, extremeRsi } = options;
  if (closes.length < lookback + period + pivotWidth) return undefined;
  const rsi = rsiSeries(closes, period);
  const from = closes.length - lookback;
  const lastPair = (indices: number[]): [number, number] | undefined => {
    for (let b = indices.length - 1; b > 0; b--) {
      for (let a = b - 1; a >= 0; a--) {
        const first = indices[a];
        const second = indices[b];
        if (first !== undefined && second !== undefined && second - first >= minSeparation) return [first, second];
      }
    }
    return undefined;
  };
  const at = (series: readonly (number | undefined)[], i: number) => series[i] ?? NaN;

  const highs = lastPair(pivots(closes, from, pivotWidth, 'high'));
  if (highs) {
    const [a, b] = highs;
    if (at(closes, b) > at(closes, a) && at(rsi, a) >= extremeRsi && at(rsi, b) <= at(rsi, a) - minRsiGap) {
      return 'BEARISH';
    }
  }
  const lows = lastPair(pivots(closes, from, pivotWidth, 'low'));
  if (lows) {
    const [a, b] = lows;
    if (at(closes, b) < at(closes, a) && at(rsi, a) <= 100 - extremeRsi && at(rsi, b) >= at(rsi, a) + minRsiGap) {
      return 'BULLISH';
    }
  }
  return 'NONE';
}

/**
 * Breakout from a consolidation: the preceding `rangeBars` bars traded in a narrow band (high-to-low range at most
 * `maxRangePct` of the low) and the latest close is above that band's high. A wide prior range is not a
 * consolidation, so it is not a breakout.
 */
export function breakoutUp(bars: readonly Bar[], rangeBars: number, maxRangePct = 12): boolean | undefined {
  if (bars.length <= rangeBars) return undefined;
  const range = bars.slice(-rangeBars - 1, -1);
  const latest = bars[bars.length - 1];
  if (!latest) return undefined;
  const high = Math.max(...range.map((bar) => bar.high));
  const low = Math.min(...range.map((bar) => bar.low));
  const consolidated = low > 0 && ((high - low) / low) * 100 <= maxRangePct;
  return consolidated && latest.close > high;
}
