import {
  currencyFor,
  instrumentKey,
  type ChartInterval,
  type Instrument,
  type LiveQuote,
  type MarketMovers,
  type MarketState,
  type Mover,
  type PriceBar,
  type PriceChart,
} from '@stock-analysis/shared';
import type { Logger } from 'pino';
import {
  InstrumentLookupUnavailableError,
  type InstrumentDirectory,
} from '../domain/instruments/instrumentDirectory.ts';
import { AppError } from '../http/errors.ts';
import { exchangeDate } from '../market/exchangeTime.ts';
import type { ConstituentList } from '../market/indexConstituents.ts';
import type { Bar } from '../market/indicators.ts';
import type { MarketDataSource, MarketQuote } from '../market/marketData.ts';
import { yahooSymbolFor } from '../market/symbols.ts';

export interface MarketServiceDeps {
  /** Undefined when live market data is disabled (RESEARCH_PROVIDER=fixture): every call answers 503. */
  market: MarketDataSource | undefined;
  constituents: { list(): Promise<ConstituentList> };
  directory: InstrumentDirectory;
  now: () => Date;
  logger: Logger;
}

const DAY_MS = 86_400_000;
const MOVERS_PER_SIDE = 10;
const DAILY_CHART_DAYS = 365;
/** Enough calendar days to reach the last session across a long weekend plus a holiday. */
const INTRADAY_LOOKBACK_DAYS = 6;
const MAX_CHART_BARS = 2_000;
/** UI calls must answer promptly even if the vendor hangs. */
const MARKET_TIMEOUT_MS = 6_000;
const marketSignal = () => AbortSignal.timeout(MARKET_TIMEOUT_MS);

const DISABLED = () =>
  new AppError(503, 'Live market data is turned off on this server.', { extensions: { code: 'MARKET_DATA_DISABLED' } });
const UNAVAILABLE = (cause?: unknown) =>
  new AppError(503, 'Market data is temporarily unavailable. Please try again shortly.', {
    cause,
    extensions: { code: 'MARKET_DATA_UNAVAILABLE' },
  });

/**
 * Read-only market data for the UI: index movers, price charts, and the live ticker. Vendor prices are delayed and
 * informational; nothing here feeds the decision engine (research fetches its own data).
 */
export class MarketService {
  readonly #deps: MarketServiceDeps;

  constructor(deps: MarketServiceDeps) {
    this.#deps = deps;
  }

  /** Top gainers and losers of the NIFTY 50 for the latest session (fewer than 10 a side on a one-way day). */
  async movers(): Promise<MarketMovers> {
    const market = this.#market();
    const { universe, constituents } = await this.#deps.constituents.list();
    const bySymbol = new Map(constituents.map((c) => [yahooSymbolFor('NSE', c.symbol), c]));
    const quotes = await this.#call(() => market.quotes([...bySymbol.keys()], marketSignal()));

    const ranked = quotes.flatMap((quote) => {
      const constituent = bySymbol.get(quote.vendorSymbol);
      const move = constituent && priceMove(quote);
      if (!move) return [];
      const mover: Mover = {
        instrumentKey: `NSE:${constituent.symbol}`,
        symbol: constituent.symbol,
        name: constituent.name,
        ...move,
      };
      return [{ mover, quote }];
    });
    if (ranked.length === 0) throw UNAVAILABLE();

    const byChange = (a: Mover, b: Mover) => b.changePct - a.changePct || a.symbol.localeCompare(b.symbol);
    const movers = ranked.map((r) => r.mover);
    const times = ranked.flatMap((r) => (r.quote.time ? [r.quote.time.getTime()] : []));
    return {
      universe,
      marketState: prevailingState(ranked.map((r) => r.quote.marketState)),
      asOf: new Date(times.length > 0 ? Math.max(...times) : this.#deps.now().getTime()).toISOString(),
      gainers: movers
        .filter((m) => m.changePct > 0)
        .sort(byChange)
        .slice(0, MOVERS_PER_SIDE),
      losers: movers
        .filter((m) => m.changePct < 0)
        .sort((a, b) => a.changePct - b.changePct || a.symbol.localeCompare(b.symbol))
        .slice(0, MOVERS_PER_SIDE),
    };
  }

  /** 1d: a year of daily bars. 5m: the latest session's 5-minute bars (today's, or the last session's when closed). */
  async chart(key: string, interval: ChartInterval): Promise<PriceChart> {
    const market = this.#market();
    const instrument = await this.#instrument(key);
    const symbol = yahooSymbolFor(instrument.exchange, instrument.symbol);
    const now = this.#deps.now();

    let bars: Bar[];
    if (interval === '1d') {
      const from = new Date(now.getTime() - DAILY_CHART_DAYS * DAY_MS);
      bars = await this.#call(() => market.dailyBars(symbol, from, marketSignal()));
    } else {
      const from = new Date(now.getTime() - INTRADAY_LOOKBACK_DAYS * DAY_MS);
      const all = await this.#call(() => market.intradayBars(symbol, from, marketSignal()));
      const last = all.at(-1);
      const session = last && exchangeDate(new Date(last.date), instrument.exchange);
      bars = all.filter((bar) => exchangeDate(new Date(bar.date), instrument.exchange) === session);
    }

    return {
      instrumentKey: instrumentKey(instrument),
      currency: currencyFor(instrument.exchange),
      interval,
      bars: bars
        .filter((bar) => bar.date <= now.toISOString())
        .flatMap(toPriceBar)
        .slice(-MAX_CHART_BARS),
    };
  }

  /** The live ticker: latest (vendor-delayed) price and the day's change. */
  async quote(key: string): Promise<LiveQuote> {
    const market = this.#market();
    const instrument = await this.#instrument(key);
    const quote = await this.#call(() =>
      market.quote(yahooSymbolFor(instrument.exchange, instrument.symbol), marketSignal()),
    );
    const move = quote && priceMove(quote);
    if (!quote || !move) throw UNAVAILABLE();
    return {
      instrumentKey: instrumentKey(instrument),
      currency: currencyFor(instrument.exchange),
      price: move.price,
      change: move.change,
      changePct: move.changePct,
      ...(quote.previousClose !== undefined && quote.previousClose > 0 ? { previousClose: quote.previousClose } : {}),
      marketState: quote.marketState ?? 'CLOSED',
      time: (quote.time ?? this.#deps.now()).toISOString(),
    };
  }

  #market(): MarketDataSource {
    if (!this.#deps.market) throw DISABLED();
    return this.#deps.market;
  }

  async #instrument(key: string): Promise<Instrument> {
    let instrument: Instrument | undefined;
    try {
      instrument = await this.#deps.directory.byKey(key, marketSignal());
    } catch (err) {
      if (err instanceof InstrumentLookupUnavailableError) throw UNAVAILABLE(err);
      throw err;
    }
    if (!instrument) throw new AppError(404, `Unknown instrument ${key}.`);
    if (instrument.assetType === 'FUTURE') throw new AppError(404, 'Charts and quotes are not available for futures.');
    return instrument;
  }

  /** Vendor failures become a client-safe 503; the detail goes to the log only. */
  async #call<T>(fetchData: () => Promise<T>): Promise<T> {
    try {
      return await fetchData();
    } catch (err) {
      this.#deps.logger.warn(
        { error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown error' },
        'market data request failed',
      );
      throw UNAVAILABLE(err);
    }
  }
}

/** Price and day change, deriving the change from the previous close when the vendor omits it. */
export function priceMove(quote: MarketQuote): { price: number; change: number; changePct: number } | undefined {
  const { price, previousClose } = quote;
  if (price === undefined || price <= 0) return undefined;
  const hasPrevious = previousClose !== undefined && previousClose > 0;
  const change = quote.change ?? (hasPrevious ? price - previousClose : undefined);
  const changePct = quote.changePct ?? (hasPrevious ? ((price - previousClose) / previousClose) * 100 : undefined);
  return change === undefined || changePct === undefined ? undefined : { price, change, changePct };
}

/** The state most quotes report (an index's constituents share a session); CLOSED when none say. */
function prevailingState(states: (MarketState | undefined)[]): MarketState {
  const counts = new Map<MarketState, number>();
  for (const state of states) if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
  let best: MarketState = 'CLOSED';
  for (const [state, count] of counts) if (count > (counts.get(best) ?? 0)) best = state;
  return best;
}

/**
 * Vendor bar -> contract bar. Intraday vendor bars occasionally report an open or close a tick outside the
 * high/low; the range is widened to include them rather than dropping the bar. Non-positive prices are dropped.
 */
function toPriceBar(bar: Bar): PriceBar[] {
  const { open, high, low, close, volume } = bar;
  if (!(open > 0 && high > 0 && low > 0 && close > 0) || volume < 0) return [];
  return [
    {
      time: bar.date,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
    },
  ];
}
