// Technical indicators computed from daily OHLCV bars, so every technical metric is deterministic and reproducible
// from the stored price history (no vendor-computed values). Bars are oldest first.

export interface Bar {
  date: string;
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
  return average > 0 && latest ? latest.volume / average : undefined;
}

/**
 * RSI divergence over two consecutive `lookback`-bar windows: BEARISH when price makes a higher high while RSI
 * makes a lower high; BULLISH when price makes a lower low while RSI makes a higher low; otherwise NONE.
 */
export function rsiDivergence(
  closes: readonly number[],
  lookback = 14,
  period = 14,
): 'BEARISH' | 'BULLISH' | 'NONE' | undefined {
  const rsi = rsiSeries(closes, period);
  if (closes.length < 2 * lookback + period) return undefined;
  const window = (end: number) => {
    const prices = closes.slice(end - lookback, end);
    const rsis = rsi.slice(end - lookback, end).filter((v): v is number => v !== undefined);
    return { highP: Math.max(...prices), lowP: Math.min(...prices), highR: Math.max(...rsis), lowR: Math.min(...rsis) };
  };
  const recent = window(closes.length);
  const prior = window(closes.length - lookback);
  if (recent.highP > prior.highP && recent.highR < prior.highR) return 'BEARISH';
  if (recent.lowP < prior.lowP && recent.lowR > prior.lowR) return 'BULLISH';
  return 'NONE';
}

/** Whether the latest close is above the highest high of the preceding `rangeBars` bars (a consolidation range). */
export function breakoutUp(bars: readonly Bar[], rangeBars: number): boolean | undefined {
  if (bars.length <= rangeBars) return undefined;
  const range = bars.slice(-rangeBars - 1, -1);
  const latest = bars[bars.length - 1];
  return latest ? latest.close > Math.max(...range.map((bar) => bar.high)) : undefined;
}
