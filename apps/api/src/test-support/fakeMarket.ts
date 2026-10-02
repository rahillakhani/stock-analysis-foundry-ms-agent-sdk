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
  sun: [
    { vendorSymbol: 'SUN', exchangeCode: 'NYQ', quoteType: 'EQUITY', name: 'Sunoco LP' },
    {
      vendorSymbol: 'SUNPHARMA.NS',
      exchangeCode: 'NSI',
      quoteType: 'EQUITY',
      name: 'Sun Pharmaceutical Industries Limited',
    },
  ],
  gold: [
    { vendorSymbol: 'GOLD', exchangeCode: 'NYQ', quoteType: 'EQUITY', name: 'Gold.com, Inc.' },
    { vendorSymbol: 'NEM', exchangeCode: 'NYQ', quoteType: 'EQUITY', name: 'Newmont Corporation' },
  ],
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
      open: close - 0.2,
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

/** Five consecutive calendar quarters (TTM = the last four) plus an empty row, as Yahoo returns them. */
export const QUARTERLY: StatementRow[] = [
  { periodEnd: '2025-03-31' },
  { periodEnd: '2025-06-30', totalRevenue: 250, netIncome: 30, operatingIncome: 38, ebit: 55 },
  { periodEnd: '2025-09-30', totalRevenue: 270, netIncome: 45, operatingIncome: 40, ebit: 65 },
  { periodEnd: '2025-12-31', totalRevenue: 280, netIncome: 45, operatingIncome: 42, ebit: 65 },
  { periodEnd: '2026-03-31', totalRevenue: 290, netIncome: 45, operatingIncome: 45, ebit: 65 },
  {
    periodEnd: '2026-06-30',
    totalRevenue: 300,
    netIncome: 45,
    operatingIncome: 48,
    ebit: 65,
    stockholdersEquity: 900,
    totalDebt: 270,
    investedCapital: 1_100,
  },
];

export class FakeMarketData implements MarketDataSource {
  readonly name = 'yahoo-finance';
  readonly calls: string[] = [];
  failSearch = false;
  failQuote = false;
  readonly #asOf: Date;
  readonly #overrides: { annual?: StatementRow[]; quarterly?: StatementRow[]; news?: NewsItem[] };

  constructor(asOf: Date, overrides: { annual?: StatementRow[]; quarterly?: StatementRow[]; news?: NewsItem[] } = {}) {
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
    if (this.failQuote) return Promise.reject(new Error('yahoo down'));
    const hit = Object.values(FAKE_HITS)
      .flat()
      .find((h) => h.vendorSymbol === vendorSymbol);
    return Promise.resolve(
      hit
        ? {
            ...hit,
            currency: 'USD',
            price: 47.76,
            time: this.#asOf,
            change: 1.26,
            changePct: 2.7097,
            previousClose: 46.5,
            marketState: 'REGULAR' as const,
          }
        : undefined,
    );
  }

  dailyBars(): Promise<Bar[]> {
    return Promise.resolve(bars(this.#asOf));
  }

  intradayBars(): Promise<Bar[]> {
    // 5-minute bars over the last day.
    return Promise.resolve(
      bars(this.#asOf, 75, 100, 0.05).map((bar, i) => ({
        ...bar,
        date: new Date(this.#asOf.getTime() - (74 - i) * 300_000).toISOString(),
      })),
    );
  }

  quotes(vendorSymbols: readonly string[]): Promise<MarketQuote[]> {
    this.calls.push(`quotes:${vendorSymbols.length}`);
    if (this.failQuote) return Promise.reject(new Error('yahoo down'));
    return Promise.resolve(
      vendorSymbols.map((vendorSymbol, i) => ({
        vendorSymbol,
        exchangeCode: 'NSI',
        quoteType: 'EQUITY',
        name: `${vendorSymbol.replace('.NS', '')} Ltd`,
        currency: 'INR',
        price: 100 + i,
        time: this.#asOf,
        // Spread of daily changes from -(n/2)% to +(n/2)%, deterministic.
        changePct: i - vendorSymbols.length / 2,
        change: (i - vendorSymbols.length / 2) * 1.0,
        previousClose: 100,
        marketState: 'REGULAR' as const,
      })),
    );
  }

  statements(_symbol: string, period: 'annual' | 'quarterly'): Promise<StatementRow[]> {
    return Promise.resolve(
      period === 'annual' ? (this.#overrides.annual ?? ANNUAL) : (this.#overrides.quarterly ?? QUARTERLY),
    );
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
