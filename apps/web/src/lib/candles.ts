import { timeZoneFor, type ChartInterval, type Exchange, type LiveQuote, type PriceBar } from '@stock-analysis/shared';

/**
 * A candle as the chart draws it. `time` is a YYYY-MM-DD session date for daily candles, or, for intraday candles,
 * seconds since the epoch shifted into the exchange's wall-clock time (the chart library renders timestamps as UTC,
 * so the shift makes its axis read in exchange time, e.g. 09:15 for the NSE open).
 */
export interface Candle {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const FIVE_MINUTES = 300;
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string) {
  let format = partsFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, format);
  }
  const parts = format.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0';
  const [year, month, day] = [get('year'), get('month'), get('day')];
  return {
    date: `${year}-${month}-${day}`,
    seconds: Date.UTC(+year, +month - 1, +day, +get('hour'), +get('minute'), +get('second')) / 1000,
  };
}

/** Times within one chart are all dates or all numbers; YYYY-MM-DD dates order lexicographically. */
function isAfter(a: Candle['time'], b: Candle['time']): boolean {
  return typeof a === 'number' && typeof b === 'number' ? a > b : String(a) > String(b);
}

/** The chart time of an instant: its session date (daily) or its 5-minute bucket in exchange time (intraday). */
export function chartTime(iso: string, interval: ChartInterval, exchange: Exchange): string | number {
  const local = wallClock(new Date(iso), timeZoneFor(exchange));
  return interval === '1d' ? local.date : Math.floor(local.seconds / FIVE_MINUTES) * FIVE_MINUTES;
}

export function toCandles(bars: readonly PriceBar[], interval: ChartInterval, exchange: Exchange): Candle[] {
  const candles: Candle[] = [];
  for (const bar of bars) {
    const candle = {
      time: chartTime(bar.time, interval, exchange),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    };
    // The chart needs strictly increasing times; a repeated bucket keeps the later bar.
    if (candles.at(-1)?.time === candle.time) candles[candles.length - 1] = candle;
    else candles.push(candle);
  }
  return candles;
}

/**
 * Applies a live quote to the chart: the quote's price becomes the close of its candle, widening the high/low.
 * Returns the candle to draw (an update of the last candle, or a new one when the quote opens a new bucket or
 * session), or undefined when the quote is older than the last candle.
 */
export function applyQuote(
  last: Candle | undefined,
  quote: LiveQuote,
  interval: ChartInterval,
  exchange: Exchange,
): Candle | undefined {
  if (!last) return undefined;
  const time = chartTime(quote.time, interval, exchange);
  const { price } = quote;
  if (time === last.time) {
    return { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
  }
  // A new candle only while the session is trading: after the close the vendor may stamp the final print (or the
  // current time) past the last bar, which would draw an invented flat candle.
  if (quote.marketState !== 'REGULAR') return undefined;
  return isAfter(time, last.time) ? { time, open: price, high: price, low: price, close: price } : undefined;
}
