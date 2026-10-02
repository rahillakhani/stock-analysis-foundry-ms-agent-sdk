import type { Bar } from './indicators.ts';

/** A security found by a market-data search, in the vendor's own symbol and exchange codes. */
export interface MarketSearchHit {
  vendorSymbol: string;
  exchangeCode: string;
  quoteType: string;
  name: string;
}

export type VendorMarketState = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';

export interface MarketQuote extends MarketSearchHit {
  currency: string | undefined;
  price: number | undefined;
  time: Date | undefined;
  change?: number | undefined;
  changePct?: number | undefined;
  previousClose?: number | undefined;
  marketState?: VendorMarketState | undefined;
}

/** One reported period from the income statement and balance sheet (absolute values, reporting currency). */
export interface StatementRow {
  /** Period end, YYYY-MM-DD. */
  periodEnd: string;
  totalRevenue?: number;
  netIncome?: number;
  operatingIncome?: number;
  ebit?: number;
  stockholdersEquity?: number;
  totalDebt?: number;
  investedCapital?: number;
}

export interface NewsItem {
  title: string;
  publishedAt: Date;
}

export interface Valuation {
  trailingPe?: number;
  priceToSales?: number;
}

/**
 * Port to a market-data vendor. Implementations return normalized, validated shapes; callers never see vendor
 * types. Every call accepts an AbortSignal so research timeouts and cancellation reach the network.
 */
export interface MarketDataSource {
  readonly name: string;
  search(query: string, signal?: AbortSignal): Promise<MarketSearchHit[]>;
  quote(vendorSymbol: string, signal?: AbortSignal): Promise<MarketQuote | undefined>;
  dailyBars(vendorSymbol: string, from: Date, signal?: AbortSignal): Promise<Bar[]>;
  /** 5-minute bars for the live chart (oldest first; incomplete bars skipped). */
  intradayBars(vendorSymbol: string, from: Date, signal?: AbortSignal): Promise<Bar[]>;
  /** Batch quotes (one request); symbols the vendor doesn't know are simply absent. */
  quotes(vendorSymbols: readonly string[], signal?: AbortSignal): Promise<MarketQuote[]>;
  statements(
    vendorSymbol: string,
    period: 'annual' | 'quarterly',
    from: Date,
    signal?: AbortSignal,
  ): Promise<StatementRow[]>;
  valuation(vendorSymbol: string, signal?: AbortSignal): Promise<Valuation>;
  news(vendorSymbol: string, signal?: AbortSignal): Promise<NewsItem[]>;
  /** Public page for a security, used as the source link shown to users. */
  pageUrl(vendorSymbol: string): string;
}
