import {
  timeZoneFor,
  type ChartInterval,
  type Exchange,
  type Instrument,
  type LiveQuote,
} from '@stock-analysis/shared';
import { Loader2, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMarketError, type ApiClient } from '../api/client.ts';
import { usePolled } from '../hooks/usePolled.ts';
import { applyQuote, toCandles, type Candle } from '../lib/candles.ts';
import { cn } from '../lib/cn.ts';
import { formatPercent, formatPrice, formatSignedPrice, MARKET_STATE_LABEL } from '../lib/format.ts';

/** The drawing surface. The default draws with lightweight-charts; tests inject a recorder (jsdom has no canvas). */
export interface CandleChart {
  setData(candles: Candle[]): void;
  update(candle: Candle): void;
  remove(): void;
}
export type CandleChartFactory = (container: HTMLElement, options: { intraday: boolean }) => Promise<CandleChart>;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** lightweight-charts (Apache-2.0, by TradingView), loaded on demand so it stays out of the main bundle. */
export const lightweightChartFactory: CandleChartFactory = async (container, { intraday }) => {
  const { CandlestickSeries, ColorType, createChart } = await import('lightweight-charts');
  const up = cssVar('--up');
  const down = cssVar('--down');
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: cssVar('--text-secondary'),
      attributionLogo: true,
    },
    grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), timeVisible: intraday, secondsVisible: false },
  });
  const series = chart.addSeries(CandlestickSeries, {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  });
  return {
    // The chart's Time type is a nominal number or a date string; Candle.time is exactly one of those.
    setData: (candles) => {
      series.setData(candles as Parameters<typeof series.setData>[0]);
      chart.timeScale().fitContent();
    },
    update: (candle) => series.update(candle as Parameters<typeof series.update>[0]),
    remove: () => chart.remove(),
  };
};

interface Props {
  api: ApiClient;
  instrument: Instrument;
  instrumentKey: string;
  chartFactory?: CandleChartFactory;
  quoteIntervalMs?: number;
}

const INTERVALS: { value: ChartInterval; label: string; description: string }[] = [
  { value: '5m', label: '1D', description: 'Latest session, 5-minute candles' },
  { value: '1d', label: '1Y', description: 'One year, daily candles' },
];
const QUOTE_INTERVAL_MS = 15_000;
/** Bars are re-read now and then so candles the live quote can't build (volume, true highs/lows) stay right. */
const BARS_INTERVAL_MS = 5 * 60_000;

/** Live ticker plus a candlestick chart of the instrument; the last candle follows the ticker. */
export function PriceChart({
  api,
  instrument,
  instrumentKey,
  chartFactory = lightweightChartFactory,
  quoteIntervalMs = QUOTE_INTERVAL_MS,
}: Props) {
  const [range, setRange] = useState<ChartInterval>('5m');
  const loadBars = useCallback(
    (signal: AbortSignal) => api.chart(instrumentKey, range, signal),
    [api, instrumentKey, range],
  );
  const loadQuote = useCallback((signal: AbortSignal) => api.quote(instrumentKey, signal), [api, instrumentKey]);
  const bars = usePolled(loadBars, BARS_INTERVAL_MS, `${instrumentKey}:${range}`);
  const quote = usePolled(loadQuote, quoteIntervalMs, instrumentKey);

  const container = useRef<HTMLDivElement>(null);
  const last = useRef<Candle | undefined>(undefined);
  const [chart, setChart] = useState<{ instance: CandleChart; owner: string } | undefined>();
  const [chartError, setChartError] = useState(false);
  const [drawAttempt, setDrawAttempt] = useState(0);
  const owner = `${instrumentKey}:${range}`;
  const intraday = range === '5m';
  const barsData = bars.data;
  const hasCandles = barsData !== undefined && barsData.bars.length > 0;
  // A chart created for another stock or range is never drawn on (its time axis differs).
  const instance = chart?.owner === owner ? chart.instance : undefined;

  // One chart per stock and range, created once there is something to draw.
  useEffect(() => {
    const element = container.current;
    if (!element || !hasCandles) return;
    let disposed = false;
    let created: CandleChart | undefined;
    chartFactory(element, { intraday }).then(
      (made) => {
        if (disposed) return made.remove();
        created = made;
        setChart({ instance: made, owner });
        setChartError(false);
      },
      () => {
        if (!disposed) setChartError(true);
      },
    );
    return () => {
      disposed = true;
      created?.remove();
      // Never draw on a removed chart (e.g. switching 1Y -> 1D before the 1Y bars arrive).
      setChart(undefined);
    };
  }, [chartFactory, intraday, hasCandles, owner, drawAttempt]);

  // Full redraw whenever fresh bars arrive.
  useEffect(() => {
    if (!instance || !barsData) return;
    const candles = toCandles(barsData.bars, range, instrument.exchange);
    instance.setData(candles);
    last.current = candles.at(-1);
  }, [instance, barsData, range, instrument.exchange]);

  // The live ticker moves the last candle (or opens the next one).
  const quoteData = quote.data;
  useEffect(() => {
    if (!instance || !quoteData) return;
    const candle = applyQuote(last.current, quoteData, range, instrument.exchange);
    if (!candle) return;
    instance.update(candle);
    last.current = candle;
  }, [instance, quoteData, range, instrument.exchange]);

  return (
    <section aria-label={`${instrument.name} price chart`} className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-ink-2">
            <span className="font-semibold text-ink">{instrument.symbol}</span>{' '}
            <span className="font-mono text-xs">{instrumentKey}</span>
          </p>
          <Ticker quote={quoteData} error={quote.error} loading={quote.loading} exchange={instrument.exchange} />
        </div>
        <div role="group" aria-label="Chart range" className="flex rounded-md border border-border p-0.5 text-sm">
          {INTERVALS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={range === option.value}
              title={option.description}
              onClick={() => setRange(option.value)}
              className={cn(
                'rounded px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-focus',
                range === option.value ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-2 hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative mt-3 h-64 sm:h-80">
        <div ref={container} data-testid="chart-canvas" className="absolute inset-0" />
        {bars.loading && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-2">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Loading chart…
          </p>
        )}
        {!bars.loading && !hasCandles && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-2">
            <p>{bars.error ? describeMarketError(bars.error) : 'No price history is available for this range.'}</p>
            {bars.error !== undefined && <RetryButton onClick={bars.reload} />}
          </div>
        )}
        {chartError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-ink-2">
            <p>The chart could not be drawn.</p>
            <RetryButton onClick={() => setDrawAttempt((n) => n + 1)} />
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Prices from Yahoo Finance, may be delayed. Informational only; the chart does not affect the decision.
      </p>
    </section>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border px-3 py-1 text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      Retry
    </button>
  );
}

function Ticker({
  quote,
  error,
  loading,
  exchange,
}: {
  quote: LiveQuote | undefined;
  error: unknown;
  loading: boolean;
  exchange: Exchange;
}) {
  if (!quote) {
    return <p className="mt-1 text-sm text-ink-2">{loading ? 'Loading price…' : describeMarketError(error)}</p>;
  }
  const direction = quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'unchanged';
  const Icon = { up: TrendingUp, down: TrendingDown, unchanged: Minus }[direction];
  return (
    <div className="mt-1">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-ink" data-testid="live-price">
          {formatPrice(quote.price, quote.currency === 'USD' ? 'USD' : 'INR')}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 text-sm font-medium tabular-nums',
            { up: 'text-up', down: 'text-down', unchanged: 'text-ink-2' }[direction],
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {formatSignedPrice(quote.change)} ({formatPercent(quote.changePct)})
          <span className="sr-only">{direction} today</span>
        </span>
      </p>
      <p className="text-xs text-ink-3">
        {MARKET_STATE_LABEL[quote.marketState]} · last trade{' '}
        {new Date(quote.time).toLocaleTimeString('en-IN', {
          timeZone: timeZoneFor(exchange),
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        })}
        {error !== undefined && ' · could not refresh'}
      </p>
    </div>
  );
}
