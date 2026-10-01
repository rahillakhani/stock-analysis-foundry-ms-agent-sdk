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
} from './marketData.ts';

// Yahoo Finance via the unofficial `yahoo-finance2` client. Yahoo publishes no official API and its terms restrict
// use to personal, non-commercial purposes; replace with a licensed vendor (implementation-plan Phase 12) before any
// commercial use. Responses are re-validated with narrow Zod schemas so a vendor schema change degrades to
// "data unavailable" instead of corrupting a decision.

const finiteNumber = z.number().refine(Number.isFinite);
const optionalNumber = finiteNumber.optional().catch(undefined);

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
  regularMarketTime: z.date().optional().catch(undefined),
});

const BarSchema = z.object({
  date: z.date(),
  high: finiteNumber.nullable(),
  low: finiteNumber.nullable(),
  close: finiteNumber.nullable(),
  volume: finiteNumber.nullable(),
});

const StatementSchema = z.object({
  date: z.union([z.date(), z.number(), z.string()]),
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

const NewsSchema = z.object({
  title: z.string().min(1),
  providerPublishTime: z.date(),
});

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

const MINUTE = 60_000;
const TTL = {
  search: 10 * MINUTE,
  quote: MINUTE,
  bars: 5 * MINUTE,
  statements: 12 * 60 * MINUTE,
  valuation: 30 * MINUTE,
  news: 10 * MINUTE,
};
const MAX_CACHE_ENTRIES = 500;

const toIsoDate = (value: Date | number | string) => new Date(value).toISOString().slice(0, 10);
const defined = <T>(value: T | undefined): value is T => value !== undefined;

export class YahooMarketData implements MarketDataSource {
  readonly name = 'yahoo-finance';
  readonly #yf: InstanceType<typeof YahooFinance>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    this.#now = now;
  }

  pageUrl(vendorSymbol: string): string {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(vendorSymbol)}`;
  }

  search(query: string, signal?: AbortSignal): Promise<MarketSearchHit[]> {
    return this.#cached(`search:${query.toLowerCase()}`, TTL.search, async () => {
      const result = await this.#yf.search(query, { quotesCount: 10, newsCount: 0 }, { fetchOptions: { signal } });
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
    return this.#cached(`quote:${vendorSymbol}`, TTL.quote, async () => {
      const raw: unknown = await this.#yf.quote(vendorSymbol, {}, { fetchOptions: { signal } });
      const parsed = QuoteSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const q = parsed.data;
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
      };
    });
  }

  dailyBars(vendorSymbol: string, from: Date, signal?: AbortSignal): Promise<Bar[]> {
    return this.#cached(`bars:${vendorSymbol}:${toIsoDate(from)}`, TTL.bars, async () => {
      const chart = await this.#yf.chart(vendorSymbol, { period1: from, interval: '1d' }, { fetchOptions: { signal } });
      return chart.quotes.flatMap((raw): Bar[] => {
        const bar = BarSchema.safeParse(raw);
        if (!bar.success) return [];
        const { date, high, low, close, volume } = bar.data;
        // Yahoo emits null-filled rows for holidays; skip incomplete bars.
        if (high === null || low === null || close === null || volume === null) return [];
        return [{ date: date.toISOString(), high, low, close, volume }];
      });
    });
  }

  statements(
    vendorSymbol: string,
    period: 'annual' | 'quarterly',
    from: Date,
    signal?: AbortSignal,
  ): Promise<StatementRow[]> {
    return this.#cached(`statements:${vendorSymbol}:${period}:${toIsoDate(from)}`, TTL.statements, async () => {
      const rows: unknown[] = await this.#yf.fundamentalsTimeSeries(
        vendorSymbol,
        { period1: from, type: period, module: 'all' },
        { fetchOptions: { signal } },
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
    });
  }

  valuation(vendorSymbol: string, signal?: AbortSignal): Promise<Valuation> {
    return this.#cached(`valuation:${vendorSymbol}`, TTL.valuation, async () => {
      const summary = await this.#yf.quoteSummary(
        vendorSymbol,
        { modules: ['summaryDetail'] },
        { fetchOptions: { signal } },
      );
      const detail = z
        .object({ trailingPE: optionalNumber, priceToSalesTrailing12Months: optionalNumber })
        .catch({ trailingPE: undefined, priceToSalesTrailing12Months: undefined })
        .parse(summary.summaryDetail ?? {});
      return { trailingPe: detail.trailingPE, priceToSales: detail.priceToSalesTrailing12Months };
    });
  }

  news(vendorSymbol: string, signal?: AbortSignal): Promise<NewsItem[]> {
    return this.#cached(`news:${vendorSymbol}`, TTL.news, async () => {
      const result = await this.#yf.search(
        vendorSymbol,
        { quotesCount: 0, newsCount: 10 },
        { fetchOptions: { signal } },
      );
      return result.news
        .map((raw) => {
          const item = NewsSchema.safeParse(raw);
          return item.success ? { title: item.data.title, publishedAt: item.data.providerPublishTime } : undefined;
        })
        .filter(defined);
    });
  }

  /** Memoizes successful calls for `ttl` ms (failures are not cached). Bounded size, oldest evicted first. */
  #cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.#cache.set(key, { expires: now + ttl, value });
    value.catch(() => this.#cache.delete(key));
    if (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return value;
  }
}
