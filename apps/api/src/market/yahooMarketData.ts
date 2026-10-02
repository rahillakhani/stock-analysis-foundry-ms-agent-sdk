import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import type { Bar } from './indicators.ts';
import type {
  MarketDataSource,
  MarketQuote,
  MarketSearchHit,
  NewsItem,
  StatementRow,
  Valuation,
  VendorMarketState,
} from './marketData.ts';

// Yahoo Finance via the unofficial `yahoo-finance2` client. Yahoo publishes no official API and its terms restrict
// use to personal, non-commercial purposes; replace with a licensed vendor (implementation-plan Phase 12) before any
// commercial use. Responses are re-validated with narrow Zod schemas so a vendor schema change degrades to
// "data unavailable" instead of corrupting a decision. Note: on HTTP errors the library itself writes the request
// URL (which contains the search text, never credentials) to stderr; that write is not configurable.

/** A vendor call failed. `retryable` marks throttling, server errors, timeouts, and network failures. */
export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.retryable = retryable;
  }
}

/** The subset of the yahoo-finance2 client this adapter uses (injectable for offline tests). */
export interface YahooClient {
  search(query: string, options: object, moduleOptions: object): Promise<{ quotes: unknown[]; news: unknown[] }>;
  /** A single symbol returns one quote; an array returns an array (one batched request). */
  quote(symbol: string | string[], options: object, moduleOptions: object): Promise<unknown>;
  chart(symbol: string, options: object, moduleOptions: object): Promise<{ quotes: unknown[] }>;
  fundamentalsTimeSeries(symbol: string, options: object, moduleOptions: object): Promise<unknown[]>;
  quoteSummary(symbol: string, options: object, moduleOptions: object): Promise<Record<string, unknown>>;
}

interface LogSink {
  warn: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

export interface YahooMarketDataOptions {
  now?: () => number;
  /** Per-request deadline enforced on the network call itself (independent of any caller). */
  requestTimeoutMs?: number;
  /** Simultaneous requests for this instance. Use separate instances to isolate interactive search from research. */
  concurrency?: number;
  logger?: LogSink;
  client?: YahooClient;
}

const finiteNumber = z.number().refine(Number.isFinite);
const optionalNumber = finiteNumber.optional().catch(undefined);
const dateLike = z.union([z.date(), z.number(), z.string()]).transform((v) => new Date(v));

const SearchHitSchema = z.object({
  symbol: z.string().min(1).max(32),
  exchange: z.string().min(1).max(16),
  quoteType: z.string().min(1).max(32),
  longname: z.string().optional(),
  shortname: z.string().optional(),
});

const QuoteSchema = z.object({
  symbol: z.string().min(1).max(32),
  exchange: z.string().min(1).max(16),
  quoteType: z.string().min(1).max(32),
  longName: z.string().optional(),
  shortName: z.string().optional(),
  currency: z.string().optional(),
  regularMarketPrice: optionalNumber,
  regularMarketTime: dateLike.optional().catch(undefined),
  regularMarketChange: optionalNumber,
  regularMarketChangePercent: optionalNumber,
  regularMarketPreviousClose: optionalNumber,
  marketState: z.string().optional().catch(undefined),
});

/** Yahoo reports PREPRE/POSTPOST etc. for extended phases; normalize to our four states. */
function marketStateOf(raw: string | undefined): VendorMarketState | undefined {
  if (!raw) return undefined;
  if (raw === 'REGULAR') return 'REGULAR';
  if (raw.startsWith('PRE')) return 'PRE';
  if (raw.startsWith('POST')) return 'POST';
  return 'CLOSED';
}

function toQuote(q: z.infer<typeof QuoteSchema>): MarketQuote | undefined {
  const name = q.longName ?? q.shortName;
  if (!name) return undefined;
  return {
    vendorSymbol: q.symbol,
    exchangeCode: q.exchange,
    quoteType: q.quoteType,
    name,
    currency: q.currency,
    price: q.regularMarketPrice,
    time: q.regularMarketTime,
    change: q.regularMarketChange,
    changePct: q.regularMarketChangePercent,
    previousClose: q.regularMarketPreviousClose,
    marketState: marketStateOf(q.marketState),
  };
}

const BarSchema = z.object({
  date: dateLike,
  open: finiteNumber.nullable(),
  high: finiteNumber.nullable(),
  low: finiteNumber.nullable(),
  close: finiteNumber.nullable(),
  volume: finiteNumber.nullable(),
});

const StatementSchema = z.object({
  date: dateLike,
  totalRevenue: optionalNumber,
  netIncome: optionalNumber,
  netIncomeCommonStockholders: optionalNumber,
  operatingIncome: optionalNumber,
  EBIT: optionalNumber,
  stockholdersEquity: optionalNumber,
  commonStockEquity: optionalNumber,
  totalDebt: optionalNumber,
  investedCapital: optionalNumber,
});

const NewsSchema = z.object({ title: z.string().min(1), providerPublishTime: dateLike });

const ValuationSchema = z.object({
  summaryDetail: z
    .object({
      trailingPE: optionalNumber,
      priceToSalesTrailing12Months: optionalNumber,
      currency: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  financialData: z.object({ financialCurrency: z.string().optional() }).optional().catch(undefined),
});

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

const MINUTE = 60_000;
const TTL = {
  search: 10 * MINUTE,
  // Short, so the live ticker stays current while repeated polls share one request.
  quote: 15_000,
  bars: 5 * MINUTE,
  statements: 12 * 60 * MINUTE,
  valuation: 30 * MINUTE,
  news: 10 * MINUTE,
};
const MAX_CACHE_ENTRIES = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const toIsoDate = (value: Date) => value.toISOString().slice(0, 10);
const defined = <T>(value: T | undefined): value is T => value !== undefined;

/** Settles with `promise` unless the caller's signal aborts first; the shared request itself keeps running. */
function forCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Classifies a vendor/network failure; the message is kept short (Yahoo error bodies can be whole HTML pages). */
function toMarketDataError(err: unknown): MarketDataError {
  if (err instanceof MarketDataError) return err;
  const status = typeof err === 'object' && err !== null && 'code' in err ? Number(err.code) : undefined;
  const name = err instanceof Error ? err.name : 'Error';
  const retryable =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    err instanceof TypeError ||
    (status !== undefined && (status === 429 || status >= 500));
  const summary = status !== undefined && Number.isFinite(status) ? `HTTP ${status}` : name;
  return new MarketDataError(`Yahoo Finance request failed (${summary})`, retryable, { cause: err });
}

export class YahooMarketData implements MarketDataSource {
  readonly name = 'yahoo-finance';
  readonly #client: YahooClient;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: YahooMarketDataOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const log = options.logger;
    this.#client =
      options.client ??
      new YahooFinance({
        suppressNotices: ['yahooSurvey'],
        versionCheck: false,
        queue: { concurrency: options.concurrency ?? 4 },
        validation: { logErrors: false },
        logger: {
          info: (...args: unknown[]) =>
            log?.debug({ args: args.map(String).join(' ').slice(0, 300) }, 'yahoo-finance2'),
          debug: (...args: unknown[]) =>
            log?.debug({ args: args.map(String).join(' ').slice(0, 300) }, 'yahoo-finance2'),
          warn: (...args: unknown[]) => log?.warn({ args: args.map(String).join(' ').slice(0, 300) }, 'yahoo-finance2'),
          error: (...args: unknown[]) =>
            log?.warn({ args: args.map(String).join(' ').slice(0, 300) }, 'yahoo-finance2'),
          dir: () => undefined,
        },
      });
  }

  pageUrl(vendorSymbol: string): string {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(vendorSymbol)}`;
  }

  search(query: string, signal?: AbortSignal): Promise<MarketSearchHit[]> {
    return this.#cached(`search:${query.toLowerCase()}`, TTL.search, signal, async (opts) => {
      const result = await this.#client.search(query, { quotesCount: 10, newsCount: 0 }, opts);
      return result.quotes.flatMap((raw): MarketSearchHit[] => {
        const hit = SearchHitSchema.safeParse(raw);
        const name = hit.success ? (hit.data.longname ?? hit.data.shortname) : undefined;
        return hit.success && name
          ? [{ vendorSymbol: hit.data.symbol, exchangeCode: hit.data.exchange, quoteType: hit.data.quoteType, name }]
          : [];
      });
    });
  }

  quote(vendorSymbol: string, signal?: AbortSignal): Promise<MarketQuote | undefined> {
    return this.#cached(`quote:${vendorSymbol}`, TTL.quote, signal, async (opts) => {
      const parsed = QuoteSchema.safeParse(await this.#client.quote(vendorSymbol, {}, opts));
      return parsed.success ? toQuote(parsed.data) : undefined;
    });
  }

  quotes(vendorSymbols: readonly string[], signal?: AbortSignal): Promise<MarketQuote[]> {
    const symbols = [...new Set(vendorSymbols)].sort();
    if (symbols.length === 0) return Promise.resolve([]);
    return this.#cached(`quotes:${symbols.join(',')}`, TTL.quote, signal, async (opts) => {
      const raw = await this.#client.quote(symbols, {}, opts);
      return (Array.isArray(raw) ? (raw as unknown[]) : [raw]).flatMap((item): MarketQuote[] => {
        const parsed = QuoteSchema.safeParse(item);
        const quote = parsed.success ? toQuote(parsed.data) : undefined;
        return quote ? [quote] : [];
      });
    });
  }

  dailyBars(vendorSymbol: string, from: Date, signal?: AbortSignal): Promise<Bar[]> {
    return this.#bars(vendorSymbol, from, '1d', TTL.bars, signal);
  }

  intradayBars(vendorSymbol: string, from: Date, signal?: AbortSignal): Promise<Bar[]> {
    return this.#bars(vendorSymbol, from, '5m', TTL.quote, signal);
  }

  #bars(vendorSymbol: string, from: Date, interval: '1d' | '5m', ttl: number, signal?: AbortSignal): Promise<Bar[]> {
    return this.#cached(`bars:${interval}:${vendorSymbol}:${from.toISOString()}`, ttl, signal, async (opts) => {
      const chart = await this.#client.chart(vendorSymbol, { period1: from, interval }, opts);
      return chart.quotes.flatMap((raw): Bar[] => {
        const bar = BarSchema.safeParse(raw);
        if (!bar.success) return [];
        const { date, open, high, low, close, volume } = bar.data;
        // Yahoo emits null-filled rows for holidays and not-yet-traded intervals; skip incomplete bars.
        if (open === null || high === null || low === null || close === null || volume === null) return [];
        return [{ date: date.toISOString(), open, high, low, close, volume }];
      });
    });
  }

  statements(
    vendorSymbol: string,
    period: 'annual' | 'quarterly',
    from: Date,
    signal?: AbortSignal,
  ): Promise<StatementRow[]> {
    return this.#cached(
      `statements:${vendorSymbol}:${period}:${toIsoDate(from)}`,
      TTL.statements,
      signal,
      async (opts) => {
        const rows = await this.#client.fundamentalsTimeSeries(
          vendorSymbol,
          { period1: from, type: period, module: 'all' },
          opts,
        );
        return rows
          .flatMap((raw): StatementRow[] => {
            const row = StatementSchema.safeParse(raw);
            if (!row.success) return [];
            const r = row.data;
            return [
              {
                periodEnd: toIsoDate(r.date),
                totalRevenue: r.totalRevenue,
                netIncome: r.netIncome ?? r.netIncomeCommonStockholders,
                operatingIncome: r.operatingIncome,
                ebit: r.EBIT,
                stockholdersEquity: r.stockholdersEquity ?? r.commonStockEquity,
                totalDebt: r.totalDebt,
                investedCapital: r.investedCapital,
              },
            ];
          })
          .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
      },
    );
  }

  valuation(vendorSymbol: string, signal?: AbortSignal): Promise<Valuation> {
    return this.#cached(`valuation:${vendorSymbol}`, TTL.valuation, signal, async (opts) => {
      const summary = ValuationSchema.parse(
        await this.#client.quoteSummary(vendorSymbol, { modules: ['summaryDetail', 'financialData'] }, opts),
      );
      const detail = summary.summaryDetail;
      const tradingCurrency = detail?.currency;
      const reportingCurrency = summary.financialData?.financialCurrency;
      // P/S mixes market cap (trading currency) with revenue (reporting currency): meaningless when they differ,
      // e.g. an ADR quoted in USD for a company reporting in INR.
      const sameCurrency = tradingCurrency !== undefined && tradingCurrency === reportingCurrency;
      const pe = detail?.trailingPE;
      const ps = detail?.priceToSalesTrailing12Months;
      return {
        // A negative P/E (loss-making company) is not a meaningful valuation multiple.
        trailingPe: pe !== undefined && pe > 0 ? pe : undefined,
        priceToSales: sameCurrency && ps !== undefined && ps >= 0 ? ps : undefined,
      };
    });
  }

  news(vendorSymbol: string, signal?: AbortSignal): Promise<NewsItem[]> {
    return this.#cached(`news:${vendorSymbol}`, TTL.news, signal, async (opts) => {
      const result = await this.#client.search(vendorSymbol, { quotesCount: 0, newsCount: 10 }, opts);
      return result.news
        .map((raw) => {
          const item = NewsSchema.safeParse(raw);
          return item.success ? { title: item.data.title, publishedAt: item.data.providerPublishTime } : undefined;
        })
        .filter(defined);
    });
  }

  /**
   * Shares one in-flight request per key across callers and memoizes successes for `ttl` ms. The request runs under
   * its own deadline, so one caller cancelling never fails another caller of the same key; each caller only stops
   * waiting. Failures are evicted (only if the entry is still the one that failed). Bounded size, oldest first.
   */
  #cached<T>(
    key: string,
    ttl: number,
    signal: AbortSignal | undefined,
    load: (moduleOptions: { fetchOptions: { signal: AbortSignal } }) => Promise<T>,
  ): Promise<T> {
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.expires > now) return forCaller(hit.value as Promise<T>, signal);

    const value = load({ fetchOptions: { signal: AbortSignal.timeout(this.#timeoutMs) } }).catch((err: unknown) => {
      throw toMarketDataError(err);
    });
    const entry: CacheEntry = { expires: now + ttl, value };
    this.#cache.set(key, entry);
    value.catch(() => {
      if (this.#cache.get(key) === entry) this.#cache.delete(key);
    });
    if (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return forCaller(value, signal);
  }
}
