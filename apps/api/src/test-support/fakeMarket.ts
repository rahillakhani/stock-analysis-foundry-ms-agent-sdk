// Offline stand-in for a market-data vendor: deterministic bars, statements, and search results shaped like the
// real Yahoo responses observed on 2026-10-01 (values are synthetic).
import type { Bar } from '../market/indicators.ts';
import type {
  MarketDataSource,
  MarketQuote,
  MarketSearchHit,
  NewsItem,
  StatementRow,
  Valuation,
} from '../market/marketData.ts';

export const FAKE_HITS: Record<string, MarketSearchHit[]> = {
  mrf: [
    { vendorSymbol: 'MRF.NS', exchangeCode: 'NSI', quoteType: 'EQUITY', name: 'MRF Limited' },
    {
      vendorSymbol: 'MRFOX',
      exchangeCode: 'NAS',
      quoteType: 'MUTUALFUND',
      name: 'Marshfield Concentrated Opportunity',
    },
    { vendorSymbol: 'MRF.BO', exchangeCode: 'BSE', quoteType: 'EQUITY', name: 'MRF Limited' },
  ],
  makemytrip: [
    { vendorSymbol: 'MMYT', exchangeCode: 'NMS', quoteType: 'EQUITY', name: 'MakeMyTrip Limited' },
    { vendorSymbol: 'MY1.F', exchangeCode: 'FRA', quoteType: 'EQUITY', name: 'MakeMyTrip Limited' },
  ],
  mmyt: [{ vendorSymbol: 'MMYT', exchangeCode: 'NMS', quoteType: 'EQUITY', name: 'MakeMyTrip Limited' }],
  make: [
    { vendorSymbol: 'MMYT', exchangeCode: 'NMS', quoteType: 'EQUITY', name: 'MakeMyTrip Limited' },
    { vendorSymbol: 'MKTX', exchangeCode: 'NMS', quoteType: 'EQUITY', name: 'MarketAxess Holdings Inc.' },
  ],
};

/** `days` daily bars ending at `end`, rising steadily (a clean uptrend) unless `trend` says otherwise. */
export function bars(end: Date, days = 300, start = 100, trend = 0.4): Bar[] {
  return Array.from({ length: days }, (_, i) => {
    const close = start + i * trend + (i % 2 === 0 ? 0.3 : -0.3);
    return {
      date: new Date(end.getTime() - (days - 1 - i) * 86_400_000).toISOString(),
      high: close + 1,
      low: close - 1,
      close,
      volume: i === days - 1 ? 2_000 : 1_000,
    };
  });
}

export const ANNUAL: StatementRow[] = [
  {
    periodEnd: '2025-03-31',
    totalRevenue: 1_000,
    netIncome: 150,
    stockholdersEquity: 800,
    totalDebt: 200,
    ebit: 220,
    investedCapital: 1_000,
  },
  {
    periodEnd: '2026-03-31',
    totalRevenue: 1_100,
    netIncome: 180,
    stockholdersEquity: 900,
    totalDebt: 270,
    ebit: 260,
    investedCapital: 1_100,
  },
];

export const QUARTERLY: StatementRow[] = [
  { periodEnd: '2025-03-31' },
  { periodEnd: '2025-09-30', totalRevenue: 270, operatingIncome: 40 },
  { periodEnd: '2025-12-31', totalRevenue: 280, operatingIncome: 42 },
  { periodEnd: '2026-03-31', totalRevenue: 290, operatingIncome: 45 },
  { periodEnd: '2026-06-30', totalRevenue: 300, operatingIncome: 48 },
];

export class FakeMarketData implements MarketDataSource {
  readonly name = 'yahoo-finance';
  readonly calls: string[] = [];
  failSearch = false;
  readonly #asOf: Date;
  readonly #overrides: { annual?: StatementRow[]; news?: NewsItem[] };

  constructor(asOf: Date, overrides: { annual?: StatementRow[]; news?: NewsItem[] } = {}) {
    this.#asOf = asOf;
    this.#overrides = overrides;
  }

  pageUrl(vendorSymbol: string) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(vendorSymbol)}`;
  }

  search(query: string): Promise<MarketSearchHit[]> {
    this.calls.push(`search:${query}`);
    if (this.failSearch) return Promise.reject(new Error('yahoo down'));
    return Promise.resolve(FAKE_HITS[query.toLowerCase()] ?? []);
  }

  quote(vendorSymbol: string): Promise<MarketQuote | undefined> {
    this.calls.push(`quote:${vendorSymbol}`);
    const hit = Object.values(FAKE_HITS)
      .flat()
      .find((h) => h.vendorSymbol === vendorSymbol);
    return Promise.resolve(hit ? { ...hit, currency: 'USD', price: 47.76, time: this.#asOf } : undefined);
  }

  dailyBars(): Promise<Bar[]> {
    return Promise.resolve(bars(this.#asOf));
  }

  statements(_symbol: string, period: 'annual' | 'quarterly'): Promise<StatementRow[]> {
    return Promise.resolve(period === 'annual' ? (this.#overrides.annual ?? ANNUAL) : QUARTERLY);
  }

  valuation(): Promise<Valuation> {
    return Promise.resolve({ trailingPe: 21.7, priceToSales: 1.64 });
  }

  news(): Promise<NewsItem[]> {
    return Promise.resolve(
      this.#overrides.news ?? [
        { title: 'Company reports quarterly results', publishedAt: new Date(this.#asOf.getTime() - 86_400_000) },
        { title: 'Item from the future', publishedAt: new Date(this.#asOf.getTime() + 86_400_000) },
      ],
    );
  }
}
