import { isIndianExchange, type Instrument, type Source } from '@stock-analysis/shared';
import { atr, breakoutUp, ema, rsiDivergence, rsiSeries, volumeRatio } from '../market/indicators.ts';
import type { MarketDataSource, StatementRow } from '../market/marketData.ts';
import { yahooSymbolFor } from '../market/symbols.ts';
import type { Dimension, DimensionData, DimensionResult, FetchContext, ResearchProvider } from './researchProvider.ts';

// Live research from a market-data vendor. Every number is either a vendor fact (price bars, statement lines,
// valuation ratios) or computed here from those facts with documented formulas, so values are reproducible from the
// cited sources. Data the vendor doesn't carry is MISSING (it lowers confidence and never counts toward BUY), and
// concepts that don't exist for a market are NOT_APPLICABLE (e.g. promoter pledging for US stocks).

const DAY_MS = 86_400_000;
/** Enough daily bars for EMA200 plus warm-up. */
const PRICE_HISTORY_DAYS = 420;
const DIVERGENCE_LOOKBACK_BARS = 14;
const BREAKOUT_RANGE_WEEKS = 6;
const TRADING_DAYS_PER_WEEK = 5;

const MISSING = { status: 'MISSING' as const, value: null };
const NOT_APPLICABLE = { status: 'NOT_APPLICABLE' as const, value: null };
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** Calendar quarter label for a period-end date: 2026-06-30 -> 2026-Q2. */
export function quarterLabel(periodEnd: string): string {
  const month = Number(periodEnd.slice(5, 7));
  return `${periodEnd.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
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

/** Ratios from the latest annual statement (and the prior one for growth). Undefined when not meaningful. */
export function annualRatios(rows: readonly StatementRow[]) {
  const withRevenue = rows.filter((r) => r.totalRevenue !== undefined && r.totalRevenue > 0);
  const latest = withRevenue.at(-1);
  const prior = withRevenue.at(-2);
  if (!latest) return undefined;
  const equity = latest.stockholdersEquity;
  // ROE and D/E are meaningless with zero or negative equity (e.g. after large buybacks or losses).
  const positiveEquity = equity !== undefined && equity > 0 ? equity : undefined;
  const revenue = latest.totalRevenue ?? 0;
  return {
    periodEnd: latest.periodEnd,
    roePct:
      positiveEquity && latest.netIncome !== undefined ? round((100 * latest.netIncome) / positiveEquity) : undefined,
    debtToEquity:
      positiveEquity && latest.totalDebt !== undefined
        ? round(Math.max(0, latest.totalDebt) / positiveEquity)
        : undefined,
    netMarginPct: latest.netIncome !== undefined ? round((100 * latest.netIncome) / revenue) : undefined,
    revenueGrowthYoYPct:
      prior?.totalRevenue !== undefined ? round(100 * (revenue / prior.totalRevenue - 1)) : undefined,
    rocePct:
      latest.ebit !== undefined && latest.investedCapital !== undefined && latest.investedCapital > 0
        ? round((100 * latest.ebit) / latest.investedCapital)
        : undefined,
  };
}

/** Quarterly operating margins (calendar-quarter labels), oldest first; quarters lacking data are skipped. */
export function quarterlyOperatingMargins(rows: readonly StatementRow[]) {
  return rows
    .filter((r) => r.totalRevenue !== undefined && r.totalRevenue > 0 && r.operatingIncome !== undefined)
    .map((r) => ({
      period: quarterLabel(r.periodEnd),
      periodEnd: r.periodEnd,
      valuePct: round((100 * (r.operatingIncome ?? 0)) / (r.totalRevenue ?? 1)),
    }))
    .filter((q, i, all) => all.findIndex((other) => other.period === q.period) === i)
    .slice(-8);
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
    return builders[dimension]();
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
    const [annual, quarterly, valuation] = await Promise.all([
      this.#market.statements(symbol, 'annual', new Date(asOf.getTime() - 4 * 365 * DAY_MS), signal),
      this.#market.statements(symbol, 'quarterly', new Date(asOf.getTime() - 2 * 365 * DAY_MS), signal),
      this.#market.valuation(symbol, signal),
    ]);
    const statementsSource = this.#source('statements', instrument, asOf);
    const quoteSource = this.#source('valuation', instrument, asOf);
    const ratios = annualRatios(annual.filter((r) => r.periodEnd <= asOf.toISOString().slice(0, 10)));
    const quarters = quarterlyOperatingMargins(quarterly.filter((r) => r.periodEnd <= asOf.toISOString().slice(0, 10)));

    const fromStatements = (value: number | undefined) =>
      ratios && value !== undefined
        ? {
            status: 'OK' as const,
            value,
            sourceId: statementsSource.id,
            observedAt: observedAt(ratios.periodEnd, asOf),
          }
        : MISSING;
    const fromQuote = (value: number | undefined) =>
      value !== undefined
        ? { status: 'OK' as const, value: round(value), sourceId: quoteSource.id, observedAt: asOf.toISOString() }
        : MISSING;
    const latestQuarter = quarters.at(-1);
    // India-specific shareholding disclosures aren't available from this vendor; the concept doesn't apply in the US.
    const indiaOnly = isIndianExchange(instrument.exchange) ? MISSING : NOT_APPLICABLE;

    const data: DimensionData['fundamentals'] = {
      revenueGrowthYoYPct: fromStatements(ratios?.revenueGrowthYoYPct),
      netMarginPct: fromStatements(ratios?.netMarginPct),
      operatingMarginPctQuarterly: latestQuarter
        ? {
            status: 'OK',
            value: quarters.map(({ period, valuePct }) => ({ period, valuePct })),
            sourceId: statementsSource.id,
            observedAt: observedAt(latestQuarter.periodEnd, asOf),
          }
        : MISSING,
      peRatio: fromQuote(valuation.trailingPe),
      psRatio: fromQuote(
        valuation.priceToSales !== undefined && valuation.priceToSales >= 0 ? valuation.priceToSales : undefined,
      ),
      debtToEquity: fromStatements(ratios?.debtToEquity),
      roePct: fromStatements(ratios?.roePct),
      rocePct: fromStatements(ratios?.rocePct),
      promoterHoldingPct: indiaOnly,
      promoterPledgePct: indiaOnly,
      auditorOpinion: MISSING,
    };
    const used = new Set(Object.values(data).flatMap((m) => ('sourceId' in m && m.sourceId ? [m.sourceId] : [])));
    return { data, sources: [statementsSource, quoteSource].filter((s) => used.has(s.id)) };
  }

  async #technicals(instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<'technicals'>> {
    const missing = {
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
    const bars = (
      await this.#market.dailyBars(
        this.#vendorSymbol(instrument),
        new Date(asOf.getTime() - PRICE_HISTORY_DAYS * DAY_MS),
        signal,
      )
    ).filter((bar) => bar.date <= asOf.toISOString());
    const latest = bars.at(-1);
    if (!latest) return { data: missing, sources: [] };

    const source = this.#source('chart', instrument, asOf);
    const at = latest.date;
    const ok = <T>(value: T | undefined) =>
      value === undefined ? MISSING : { status: 'OK' as const, value, sourceId: source.id, observedAt: at };
    const closes = bars.map((bar) => bar.close);
    const divergence = rsiDivergence(closes, DIVERGENCE_LOOKBACK_BARS);
    const breakout = breakoutUp(bars, BREAKOUT_RANGE_WEEKS * TRADING_DAYS_PER_WEEK);
    const rsi = rsiSeries(closes, 14).at(-1);
    const averageTrueRange = atr(bars, 14);
    const volume = volumeRatio(bars, 20);
    const positive = (value: number | undefined) => (value !== undefined && value > 0 ? round(value) : undefined);

    const data: DimensionData['technicals'] = {
      lastPrice: ok(positive(latest.close)),
      ema20: ok(positive(ema(closes, 20))),
      ema50: ok(positive(ema(closes, 50))),
      ema200: ok(positive(ema(closes, 200))),
      rsi14: ok(rsi === undefined ? undefined : round(rsi, 2)),
      atr14: ok(averageTrueRange === undefined ? undefined : round(averageTrueRange)),
      volumeRatio20d: ok(volume === undefined ? undefined : round(volume)),
      rsiDivergence: ok(
        divergence === undefined ? undefined : { kind: divergence, lookbackBars: DIVERGENCE_LOOKBACK_BARS },
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
