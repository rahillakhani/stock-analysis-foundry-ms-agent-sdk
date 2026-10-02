import { isIndianExchange, type Instrument, type Source } from '@stock-analysis/shared';
import {
  atr,
  breakoutUp,
  DIVERGENCE_DEFAULTS,
  ema,
  rsiDivergence,
  rsiSeries,
  volumeRatio,
  type Bar,
} from '../market/indicators.ts';
import { exchangeDate } from '../market/exchangeTime.ts';
import type { MarketDataSource, StatementRow } from '../market/marketData.ts';
import { yahooSymbolFor } from '../market/symbols.ts';
import { MarketDataError } from '../market/yahooMarketData.ts';
import {
  RetryableProviderError,
  type Dimension,
  type DimensionData,
  type DimensionResult,
  type FetchContext,
  type ResearchProvider,
} from './researchProvider.ts';

// Live research from a market-data vendor. Every number is either a vendor fact (price bars, statement lines,
// valuation ratios) or computed here from those facts with the formulas documented in docs/decision-policy-v2.md
// ("Live research methodology"), so values are reproducible from the cited sources. Data the vendor doesn't carry
// is MISSING (it lowers confidence and never counts toward BUY); concepts that don't exist for a market are
// NOT_APPLICABLE (e.g. promoter pledging for US stocks).

const DAY_MS = 86_400_000;
/** ~3 years of daily bars, so EMA200 is well converged (its seed's weight decays below 5%). */
const PRICE_HISTORY_DAYS = 3 * 365 + 30;
const BREAKOUT_RANGE_WEEKS = 6;
const TRADING_DAYS_PER_WEEK = 5;

const MISSING = { status: 'MISSING' as const, value: null };
const NOT_APPLICABLE = { status: 'NOT_APPLICABLE' as const, value: null };
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

/** Calendar quarter label for a period-end date: 2026-06-30 -> 2026-Q2. */
export function quarterLabel(periodEnd: string): string {
  const month = Number(periodEnd.slice(5, 7));
  return `${periodEnd.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}

/** Sequential calendar-quarter number, so consecutive quarters differ by exactly 1. */
function quarterIndex(periodEnd: string): number {
  return Number(periodEnd.slice(0, 4)) * 4 + Math.ceil(Number(periodEnd.slice(5, 7)) / 3) - 1;
}

/** Period end as an observation timestamp, never later than the snapshot time. */
function observedAt(periodEnd: string, asOf: Date): string {
  const end = new Date(`${periodEnd}T00:00:00.000Z`);
  return (end.getTime() > asOf.getTime() ? asOf : end).toISOString();
}

function sourceId(kind: string, vendorSymbol: string, asOf: Date): string {
  const symbol = vendorSymbol
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `yahoo:${kind}:${symbol}:${asOf.toISOString().slice(0, 10)}`;
}

type RatioKey = 'roePct' | 'debtToEquity' | 'rocePct' | 'netMarginPct' | 'revenueGrowthYoYPct';

/** Ratios with the period their inputs come from; `periodEnd` is the OLDEST input (it decides freshness). */
interface RatioGroup {
  periodEnd: string;
  values: Partial<Record<RatioKey, number>>;
}

interface Ratios {
  income: RatioGroup;
  balance?: RatioGroup;
}

/** Keeps the newest row per calendar quarter, oldest first. */
function newestPerQuarter(rows: readonly StatementRow[]): StatementRow[] {
  const byQuarter = new Map<number, StatementRow>();
  for (const row of rows) byQuarter.set(quarterIndex(row.periodEnd), row);
  return [...byQuarter.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/**
 * Trailing-twelve-month ratios from the last four CONSECUTIVE quarterly income statements and the latest balance
 * sheet. Two groups are dated separately: income-only ratios (latest quarter) and balance-sheet ratios (the older of
 * the latest quarter and the balance-sheet date). Undefined without four consecutive quarters.
 */
export function trailingRatios(quarterly: readonly StatementRow[]): Ratios | undefined {
  const rows = newestPerQuarter(quarterly);
  const income = rows.filter((r) => r.totalRevenue !== undefined && r.totalRevenue > 0 && r.netIncome !== undefined);
  const last4 = income.slice(-4);
  const latest = last4.at(-1);
  if (last4.length < 4 || !latest) return undefined;
  const consecutive = last4.every(
    (r, i) => i === 0 || quarterIndex(r.periodEnd) === quarterIndex(last4[i - 1]?.periodEnd ?? '') + 1,
  );
  if (!consecutive) return undefined;

  const revenue = sum(last4.map((r) => r.totalRevenue ?? 0));
  const netIncome = sum(last4.map((r) => r.netIncome ?? 0));
  const yearAgo = rows.find((r) => quarterIndex(r.periodEnd) === quarterIndex(latest.periodEnd) - 4);
  const incomeGroup: RatioGroup = {
    periodEnd: latest.periodEnd,
    values: {
      netMarginPct: round((100 * netIncome) / revenue),
      // Latest quarter vs the same quarter a year earlier (seasonality-neutral YoY).
      ...(yearAgo?.totalRevenue && yearAgo.totalRevenue > 0
        ? { revenueGrowthYoYPct: round(100 * ((latest.totalRevenue ?? 0) / yearAgo.totalRevenue - 1)) }
        : {}),
    },
  };

  const sheet = [...rows].reverse().find((r) => r.stockholdersEquity !== undefined);
  const equity = sheet?.stockholdersEquity;
  // ROE and D/E are meaningless with zero or negative equity (e.g. after large buybacks or accumulated losses).
  if (!sheet || equity === undefined || equity <= 0) return { income: incomeGroup };
  const ebitKnown = last4.every((r) => r.ebit !== undefined);
  return {
    income: incomeGroup,
    balance: {
      periodEnd: sheet.periodEnd < latest.periodEnd ? sheet.periodEnd : latest.periodEnd,
      values: {
        roePct: round((100 * netIncome) / equity),
        ...(sheet.totalDebt !== undefined ? { debtToEquity: round(Math.max(0, sheet.totalDebt) / equity) } : {}),
        ...(ebitKnown && sheet.investedCapital !== undefined && sheet.investedCapital > 0
          ? { rocePct: round((100 * sum(last4.map((r) => r.ebit ?? 0))) / sheet.investedCapital) }
          : {}),
      },
    },
  };
}

/** Fallback when quarterly data is insufficient: the latest annual statement (dated to its fiscal year end). */
export function annualRatios(rows: readonly StatementRow[]): Ratios | undefined {
  const withRevenue = rows.filter((r) => r.totalRevenue !== undefined && r.totalRevenue > 0);
  const latest = withRevenue.at(-1);
  if (!latest) return undefined;
  const prior = withRevenue.at(-2);
  const revenue = latest.totalRevenue ?? 0;
  const consecutiveYears =
    prior !== undefined && Number(latest.periodEnd.slice(0, 4)) - Number(prior.periodEnd.slice(0, 4)) === 1;
  const income: RatioGroup = {
    periodEnd: latest.periodEnd,
    values: {
      ...(latest.netIncome !== undefined ? { netMarginPct: round((100 * latest.netIncome) / revenue) } : {}),
      // Only a directly preceding fiscal year counts as year-over-year.
      ...(consecutiveYears && prior.totalRevenue
        ? { revenueGrowthYoYPct: round(100 * (revenue / prior.totalRevenue - 1)) }
        : {}),
    },
  };
  const equity = latest.stockholdersEquity;
  if (equity === undefined || equity <= 0) return { income };
  return {
    income,
    balance: {
      periodEnd: latest.periodEnd,
      values: {
        ...(latest.netIncome !== undefined ? { roePct: round((100 * latest.netIncome) / equity) } : {}),
        ...(latest.totalDebt !== undefined ? { debtToEquity: round(Math.max(0, latest.totalDebt) / equity) } : {}),
        ...(latest.ebit !== undefined && latest.investedCapital !== undefined && latest.investedCapital > 0
          ? { rocePct: round((100 * latest.ebit) / latest.investedCapital) }
          : {}),
      },
    },
  };
}

/** Quarterly operating margins (calendar-quarter labels, newest row per quarter), oldest first. */
export function quarterlyOperatingMargins(rows: readonly StatementRow[]) {
  return newestPerQuarter(rows)
    .filter((r) => r.totalRevenue !== undefined && r.totalRevenue > 0 && r.operatingIncome !== undefined)
    .map((r) => ({
      period: quarterLabel(r.periodEnd),
      periodEnd: r.periodEnd,
      valuePct: round((100 * (r.operatingIncome ?? 0)) / (r.totalRevenue ?? 1)),
    }))
    .slice(-8);
}

/** Vendor failures worth retrying become RetryableProviderError for the aggregator's bounded retry. */
async function classifyFailures<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof MarketDataError && err.retryable) throw new RetryableProviderError(err.message, { cause: err });
    throw err;
  }
}

export class MarketResearchProvider implements ResearchProvider {
  readonly name: string;
  readonly #market: MarketDataSource;

  constructor(market: MarketDataSource) {
    this.#market = market;
    this.name = market.name;
  }

  fetch<D extends Dimension>(dimension: D, instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<D>> {
    const builders: { [K in Dimension]: () => Promise<DimensionResult<K>> } = {
      fundamentals: () => this.#fundamentals(instrument, ctx),
      technicals: () => this.#technicals(instrument, ctx),
      derivatives: () => Promise.resolve(this.#derivatives(instrument)),
      sentiment: () => this.#sentiment(instrument, ctx),
    };
    return classifyFailures(builders[dimension]());
  }

  #vendorSymbol(instrument: Instrument): string {
    return yahooSymbolFor(instrument.exchange, instrument.symbol);
  }

  #source(kind: string, instrument: Instrument, asOf: Date): Source {
    const vendorSymbol = this.#vendorSymbol(instrument);
    return {
      id: sourceId(kind, vendorSymbol, asOf),
      provider: this.#market.name,
      url: this.#market.pageUrl(vendorSymbol),
      retrievedAt: asOf.toISOString(),
    };
  }

  async #fundamentals(instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<'fundamentals'>> {
    const allMissing: DimensionData['fundamentals'] = {
      revenueGrowthYoYPct: MISSING,
      netMarginPct: MISSING,
      operatingMarginPctQuarterly: MISSING,
      peRatio: MISSING,
      psRatio: MISSING,
      debtToEquity: MISSING,
      roePct: MISSING,
      rocePct: MISSING,
      promoterHoldingPct: MISSING,
      promoterPledgePct: MISSING,
      auditorOpinion: MISSING,
    };
    if (instrument.assetType === 'INDEX') return { data: allMissing, sources: [] };

    const symbol = this.#vendorSymbol(instrument);
    const { asOf, signal } = ctx;
    const today = asOf.toISOString().slice(0, 10);
    const [annual, quarterly, valuation] = await Promise.all([
      this.#market.statements(symbol, 'annual', new Date(asOf.getTime() - 4 * 365 * DAY_MS), signal),
      this.#market.statements(symbol, 'quarterly', new Date(asOf.getTime() - 3 * 365 * DAY_MS), signal),
      this.#market.valuation(symbol, signal),
    ]);
    const reported = (rows: StatementRow[]) => rows.filter((r) => r.periodEnd <= today);
    const ttm = trailingRatios(reported(quarterly));
    const fallback = annualRatios(reported(annual));
    const quarters = quarterlyOperatingMargins(reported(quarterly));
    const statementsSource = this.#source('statements', instrument, asOf);
    const quoteSource = this.#source('valuation', instrument, asOf);

    /** Prefer TTM; fall back to the annual figure (older, so it may read as stale under the policy's max age). */
    const ratio = (group: 'income' | 'balance', key: RatioKey) => {
      for (const candidate of [ttm?.[group], fallback?.[group]]) {
        const value = candidate?.values[key];
        if (candidate && value !== undefined) {
          return {
            status: 'OK' as const,
            value,
            sourceId: statementsSource.id,
            observedAt: observedAt(candidate.periodEnd, asOf),
          };
        }
      }
      return MISSING;
    };
    const fromQuote = (value: number | undefined) =>
      value !== undefined
        ? { status: 'OK' as const, value: round(value), sourceId: quoteSource.id, observedAt: asOf.toISOString() }
        : MISSING;
    const latestQuarter = quarters.at(-1);
    // India-specific shareholding disclosures aren't available from this vendor; the concept doesn't apply in the US.
    const indiaOnly = isIndianExchange(instrument.exchange) ? MISSING : NOT_APPLICABLE;

    const data: DimensionData['fundamentals'] = {
      revenueGrowthYoYPct: ratio('income', 'revenueGrowthYoYPct'),
      netMarginPct: ratio('income', 'netMarginPct'),
      operatingMarginPctQuarterly: latestQuarter
        ? {
            status: 'OK',
            value: quarters.map(({ period, valuePct }) => ({ period, valuePct })),
            sourceId: statementsSource.id,
            observedAt: observedAt(latestQuarter.periodEnd, asOf),
          }
        : MISSING,
      peRatio: fromQuote(valuation.trailingPe),
      psRatio: fromQuote(valuation.priceToSales),
      debtToEquity: ratio('balance', 'debtToEquity'),
      roePct: ratio('balance', 'roePct'),
      rocePct: ratio('balance', 'rocePct'),
      promoterHoldingPct: indiaOnly,
      promoterPledgePct: indiaOnly,
      auditorOpinion: MISSING,
    };
    const used = new Set(Object.values(data).flatMap((m) => ('sourceId' in m && m.sourceId ? [m.sourceId] : [])));
    return { data, sources: [statementsSource, quoteSource].filter((s) => used.has(s.id)) };
  }

  async #technicals(instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<'technicals'>> {
    const missing: DimensionData['technicals'] = {
      lastPrice: MISSING,
      ema20: MISSING,
      ema50: MISSING,
      ema200: MISSING,
      rsi14: MISSING,
      atr14: MISSING,
      volumeRatio20d: MISSING,
      rsiDivergence: MISSING,
      consolidationBreakout: MISSING,
    };
    // No futures price feed yet: a FUTURE's own traded price is unknown, so its technicals are unavailable.
    if (instrument.assetType === 'FUTURE') return { data: missing, sources: [] };

    const { asOf, signal } = ctx;
    const sessionToday = exchangeDate(asOf, instrument.exchange);
    const from = new Date(asOf.getTime() - PRICE_HISTORY_DAYS * DAY_MS);
    // Only completed sessions: today's bar may be partial (intraday volume, live price).
    const bars: Bar[] = (await this.#market.dailyBars(this.#vendorSymbol(instrument), from, signal)).filter(
      (bar) => bar.date <= asOf.toISOString() && exchangeDate(new Date(bar.date), instrument.exchange) < sessionToday,
    );
    const latest = bars.at(-1);
    if (!latest) return { data: missing, sources: [] };

    const source = this.#source('chart', instrument, asOf);
    const ok = <T>(value: T | undefined) =>
      value === undefined ? MISSING : { status: 'OK' as const, value, sourceId: source.id, observedAt: latest.date };
    const closes = bars.map((bar) => bar.close);
    const positive = (value: number | undefined) => (value !== undefined && value > 0 ? round(value) : undefined);
    const rsi = rsiSeries(closes, 14).at(-1);
    const averageTrueRange = atr(bars, 14);
    const volume = volumeRatio(bars, 20);
    const divergence = rsiDivergence(closes);
    const breakout = breakoutUp(bars, BREAKOUT_RANGE_WEEKS * TRADING_DAYS_PER_WEEK);

    const data: DimensionData['technicals'] = {
      lastPrice: ok(positive(latest.close)),
      ema20: ok(positive(ema(closes, 20))),
      ema50: ok(positive(ema(closes, 50))),
      ema200: ok(positive(ema(closes, 200))),
      rsi14: ok(rsi === undefined ? undefined : round(rsi, 2)),
      atr14: ok(averageTrueRange === undefined ? undefined : round(averageTrueRange)),
      volumeRatio20d: ok(volume === undefined ? undefined : round(volume)),
      rsiDivergence: ok(
        divergence === undefined ? undefined : { kind: divergence, lookbackBars: DIVERGENCE_DEFAULTS.lookback },
      ),
      consolidationBreakout: ok(
        breakout === undefined ? undefined : { brokeOutUp: breakout, rangeWeeks: BREAKOUT_RANGE_WEEKS },
      ),
    };
    return { data, sources: [source] };
  }

  #derivatives(instrument: Instrument): DimensionResult<'derivatives'> {
    // US stocks have no Indian F&O contract. For Indian instruments no F&O data source is connected yet, so the
    // data is MISSING: the decision engine treats it as unavailable and never as a pass (fail-closed).
    const status = isIndianExchange(instrument.exchange) ? MISSING : NOT_APPLICABLE;
    return {
      data: {
        nearMonthExpiry: status,
        futuresPrice: status,
        priceChangePct: status,
        oiChangePct: status,
        basisPct: status,
        inFnoBan: status,
      },
      sources: [],
    };
  }

  async #sentiment(instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<'sentiment'>> {
    const { asOf, signal } = ctx;
    const news = (await this.#market.news(this.#vendorSymbol(instrument), signal))
      .filter((item) => item.publishedAt.getTime() <= asOf.getTime())
      .slice(0, 50);
    const source = this.#source('news', instrument, asOf);
    // Bulk/block deals and FII/DII flows are Indian-market disclosures not carried by this vendor.
    const indiaOnly = isIndianExchange(instrument.exchange) ? MISSING : NOT_APPLICABLE;
    return {
      data: {
        bulkBlockDeals30d: indiaOnly,
        fiiNetFlow: indiaOnly,
        diiNetFlow: indiaOnly,
        announcements: {
          status: 'OK',
          // Third-party headlines: untrusted text, length-capped, used as data only.
          value: news.map((item) => ({
            publishedAt: item.publishedAt.toISOString(),
            headline: item.title.slice(0, 500),
          })),
          sourceId: source.id,
          observedAt: asOf.toISOString(),
        },
      },
      sources: [source],
    };
  }
}
