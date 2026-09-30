import type { Metric, OI_BUILD_UPS, ResearchSnapshot } from '@stock-analysis/shared';
import type { DecisionPolicy, Section } from './policy.ts';

const MS_PER_DAY = 86_400_000;

/** What the engine may do with a metric. Only USABLE values can pass a check or fire a veto. */
export type Reading<T> =
  | { kind: 'USABLE'; value: T; sourceId: string }
  | { kind: 'STALE'; sourceId: string; observedAt: string }
  | { kind: 'UNAVAILABLE'; sourceId: string | undefined }
  | { kind: 'NOT_APPLICABLE' };

export type Reader = <T>(section: Section, metric: Metric<T>) => Reading<T>;

/**
 * Builds the metric reader for one snapshot. Applies the policy's max age (measured against `asOf`, never the wall
 * clock) and the fail-closed NOT_APPLICABLE rule: NOT_APPLICABLE is honoured only when the whole derivatives section
 * is NOT_APPLICABLE (no F&O contract); anywhere else it reads as unavailable, so a provider can't drop a BUY
 * criterion or a veto by marking one input not applicable.
 */
export function createReader(snapshot: ResearchSnapshot, policy: DecisionPolicy): Reader {
  const derivatives: Record<string, Metric<unknown>> = snapshot.derivatives;
  const noFnoContract = Object.values(derivatives).every((m) => m.status === 'NOT_APPLICABLE');

  return <T>(section: Section, metric: Metric<T>): Reading<T> => {
    switch (metric.status) {
      case 'NOT_APPLICABLE':
        return section === 'derivatives' && noFnoContract
          ? { kind: 'NOT_APPLICABLE' }
          : { kind: 'UNAVAILABLE', sourceId: undefined };
      case 'MISSING':
      case 'ERROR':
        return { kind: 'UNAVAILABLE', sourceId: metric.sourceId };
      case 'OK': {
        const ageDays = (Date.parse(snapshot.asOf) - Date.parse(metric.observedAt)) / MS_PER_DAY;
        return ageDays <= policy.maxAgeDays[section]
          ? { kind: 'USABLE', value: metric.value, sourceId: metric.sourceId }
          : { kind: 'STALE', sourceId: metric.sourceId, observedAt: metric.observedAt };
      }
    }
  };
}

export type OiBuildUp = (typeof OI_BUILD_UPS)[number];

const OI_BUILD_UP_LABELS: Readonly<Record<OiBuildUp, string>> = Object.freeze({
  LONG_BUILD_UP: 'long build-up',
  SHORT_BUILD_UP: 'short build-up',
  SHORT_COVERING: 'short covering',
  LONG_UNWINDING: 'long unwinding',
});

/** price↑OI↑ long build-up, price↓OI↑ short build-up, price↑OI↓ short covering, price↓OI↓ long unwinding. */
export function classifyOiBuildUp(priceChangePct: number, oiChangePct: number): OiBuildUp | undefined {
  if (priceChangePct === 0 || oiChangePct === 0) return undefined;
  if (priceChangePct > 0) return oiChangePct > 0 ? 'LONG_BUILD_UP' : 'SHORT_COVERING';
  return oiChangePct > 0 ? 'SHORT_BUILD_UP' : 'LONG_UNWINDING';
}

/** Outcome of one check. PASS/FAIL only happen on usable data. */
export type CheckOutcome =
  | { state: 'PASS' | 'FAIL'; message: string; sourceIds: string[] }
  | { state: 'UNAVAILABLE'; message: string; sourceIds: string[] }
  | { state: 'NOT_APPLICABLE' };

export interface CheckContext {
  snapshot: ResearchSnapshot;
  policy: DecisionPolicy;
  read: Reader;
}

export interface CheckDefinition {
  /** Stable code used in reasons when the check passes. */
  readonly code: string;
  /** Stable code used in risk factors when the check fails. */
  readonly failCode: string;
  readonly section: Section;
  readonly requiredForBuy: boolean;
  readonly veto: boolean;
  readonly scored: boolean;
  run(ctx: CheckContext): CheckOutcome;
}

/** Verdict from a check's predicate; `undefined` means the usable data can't decide under this policy. */
type Verdict = { pass: boolean; message: string } | undefined;

/**
 * Evaluates `decide` only when every input is usable. All-NOT_APPLICABLE inputs exclude the check; any other
 * non-usable input (including a mix with NOT_APPLICABLE) makes it unavailable.
 */
function withReadings<T extends unknown[]>(
  label: string,
  readings: { [K in keyof T]: Reading<T[K]> },
  decide: (...values: T) => Verdict,
): CheckOutcome {
  const all = readings as Reading<unknown>[];
  if (all.every((r) => r.kind === 'NOT_APPLICABLE')) return { state: 'NOT_APPLICABLE' };

  const sourceIds = [
    ...new Set(all.flatMap((r) => (r.kind !== 'NOT_APPLICABLE' && r.sourceId !== undefined ? [r.sourceId] : []))),
  ];
  if (all.some((r) => r.kind === 'UNAVAILABLE' || r.kind === 'NOT_APPLICABLE')) {
    return { state: 'UNAVAILABLE', message: `${label}: data unavailable.`, sourceIds };
  }
  const stale = all.find((r): r is Extract<Reading<unknown>, { kind: 'STALE' }> => r.kind === 'STALE');
  if (stale) {
    return {
      state: 'UNAVAILABLE',
      message: `${label}: data is stale (observed ${stale.observedAt.slice(0, 10)}).`,
      sourceIds,
    };
  }

  const values = all.map((r) => (r as Extract<Reading<unknown>, { kind: 'USABLE' }>).value) as T;
  const verdict = decide(...values);
  if (verdict === undefined) {
    return { state: 'UNAVAILABLE', message: `${label}: not enough data to decide.`, sourceIds };
  }
  return { state: verdict.pass ? 'PASS' : 'FAIL', message: verdict.message, sourceIds };
}

/** Rounds for display without ever showing a non-zero value as 0 (which would contradict its classification). */
export function fmt(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0 && value !== 0) {
    const tick = (10 ** -digits).toFixed(digits);
    return value > 0 ? `<${tick}` : `>-${tick}`;
  }
  return rounded.toString();
}

const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'] as const;

/** Calendar quarter `YYYY-Qn` → sequential index and end date; the schema guarantees the format. */
function quarterInfo(period: string): { index: number; endsOn: string } {
  const year = Number(period.slice(0, 4));
  const quarter = Number(period.slice(6));
  return { index: year * 4 + quarter - 1, endsOn: `${year}-${QUARTER_END[quarter - 1]}` };
}

const inRange = (value: number, range: { min: number; max: number }) => value >= range.min && value <= range.max;

function check(definition: CheckDefinition): CheckDefinition {
  return Object.freeze(definition);
}

/** The v1 checks, in the order they appear in docs/decision-policy-v1.md §2 and in the output. */
export const CHECKS_V1: readonly CheckDefinition[] = Object.freeze([
  check({
    code: 'ROE_ABOVE_MIN',
    failCode: 'ROE_NOT_ABOVE_MIN',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('ROE', [read('fundamentals', s.fundamentals.roePct)], (roe) => ({
        pass: roe > p.thresholds.roeMinPct,
        message: `ROE ${fmt(roe)}% vs minimum above ${p.thresholds.roeMinPct}%.`,
      })),
  }),
  check({
    code: 'DEBT_EQUITY_BELOW_MAX',
    failCode: 'DEBT_EQUITY_NOT_BELOW_MAX',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Debt/Equity', [read('fundamentals', s.fundamentals.debtToEquity)], (de) => ({
        pass: de < p.thresholds.debtToEquityMax,
        message: `Debt/Equity ${fmt(de)} vs maximum below ${p.thresholds.debtToEquityMax}.`,
      })),
  }),
  check({
    code: 'PLEDGE_BELOW_MAX',
    failCode: 'PLEDGE_NOT_BELOW_MAX',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Promoter pledging', [read('fundamentals', s.fundamentals.promoterPledgePct)], (pl) => ({
        pass: pl < p.thresholds.pledgeMaxPct,
        message: `Promoter pledging ${fmt(pl)}% vs BUY limit below ${p.thresholds.pledgeMaxPct}%.`,
      })),
  }),
  check({
    code: 'PLEDGE_NOT_EXCESSIVE',
    failCode: 'PLEDGE_EXCESSIVE',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: true,
    scored: false,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Promoter pledging', [read('fundamentals', s.fundamentals.promoterPledgePct)], (pl) => ({
        pass: pl <= p.thresholds.pledgeMaxPct,
        message: `Promoter pledging ${fmt(pl)}% vs veto above ${p.thresholds.pledgeMaxPct}%.`,
      })),
  }),
  check({
    code: 'OPERATING_MARGIN_STABLE',
    failCode: 'OPERATING_MARGIN_SHRINKING',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[{ period: string; valuePct: number }[]]>(
        'Operating margin trend',
        [read('fundamentals', s.fundamentals.operatingMarginPctQuarterly)],
        (quarters) => {
          const n = p.thresholds.shrinkingQuarters;
          if (quarters.length < n) return undefined;
          const recent = quarters.slice(-n).map((q) => ({ ...q, ...quarterInfo(q.period) }));

          let consecutive = true;
          let shrinking = true;
          let previous: (typeof recent)[number] | undefined;
          let newestEndsOn = '';
          for (const quarter of recent) {
            if (previous !== undefined) {
              if (quarter.index !== previous.index + 1) consecutive = false;
              if (quarter.valuePct >= previous.valuePct) shrinking = false;
            }
            previous = quarter;
            newestEndsOn = quarter.endsOn;
          }
          // Old quarters re-fetched today would look fresh by observedAt; require the newest to be recent.
          const newestEnd = Date.parse(`${newestEndsOn}T00:00:00.000Z`);
          const recentEnough = (Date.parse(s.asOf) - newestEnd) / MS_PER_DAY <= p.maxAgeDays.fundamentals;
          if (!consecutive || !recentEnough) return undefined;

          const trail = recent.map((q) => `${q.period} ${fmt(q.valuePct)}%`).join(' → ');
          return {
            pass: !shrinking,
            message: shrinking
              ? `Operating margin shrinking for ${n} quarters: ${trail}.`
              : `Operating margin not shrinking: ${trail}.`,
          };
        },
      ),
  }),
  check({
    code: 'REVENUE_GROWING',
    failCode: 'REVENUE_NOT_GROWING',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Revenue growth', [read('fundamentals', s.fundamentals.revenueGrowthYoYPct)], (g) => ({
        pass: g > p.thresholds.revenueGrowthMinPct,
        message: `Revenue growth ${fmt(g)}% YoY.`,
      })),
  }),
  check({
    code: 'NET_MARGIN_POSITIVE',
    failCode: 'NET_MARGIN_NOT_POSITIVE',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Net margin', [read('fundamentals', s.fundamentals.netMarginPct)], (m) => ({
        pass: m > p.thresholds.netMarginMinPct,
        message: `Net margin ${fmt(m)}%.`,
      })),
  }),
  check({
    code: 'AUDITOR_UNQUALIFIED',
    failCode: 'AUDITOR_NOT_UNQUALIFIED',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[string]>('Auditor opinion', [read('fundamentals', s.fundamentals.auditorOpinion)], (op) => ({
        pass: op === 'UNQUALIFIED',
        message: `Auditor opinion: ${op}.`,
      })),
  }),
  check({
    code: 'PRICE_ABOVE_EMA50',
    failCode: 'PRICE_NOT_ABOVE_EMA50',
    section: 'technicals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[number, number]>(
        'Price vs EMA50',
        [read('technicals', s.technicals.lastPrice), read('technicals', s.technicals.ema50)],
        (price, ema) => ({ pass: price > ema, message: `Price ${fmt(price)} vs EMA50 ${fmt(ema)}.` }),
      ),
  }),
  check({
    code: 'PRICE_ABOVE_EMA200',
    failCode: 'PRICE_NOT_ABOVE_EMA200',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[number, number]>(
        'Price vs EMA200',
        [read('technicals', s.technicals.lastPrice), read('technicals', s.technicals.ema200)],
        (price, ema) => ({ pass: price > ema, message: `Price ${fmt(price)} vs EMA200 ${fmt(ema)}.` }),
      ),
  }),
  check({
    code: 'EMA20_ABOVE_EMA50',
    failCode: 'EMA20_NOT_ABOVE_EMA50',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[number, number]>(
        'EMA20 vs EMA50',
        [read('technicals', s.technicals.ema20), read('technicals', s.technicals.ema50)],
        (ema20, ema50) => ({ pass: ema20 > ema50, message: `EMA20 ${fmt(ema20)} vs EMA50 ${fmt(ema50)}.` }),
      ),
  }),
  check({
    code: 'RSI_IN_HEALTHY_RANGE',
    failCode: 'RSI_OUTSIDE_HEALTHY_RANGE',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('RSI(14)', [read('technicals', s.technicals.rsi14)], (rsi) => ({
        pass: rsi >= p.thresholds.rsiLow && rsi <= p.thresholds.rsiHigh,
        message: `RSI(14) ${fmt(rsi, 1)} vs healthy range ${p.thresholds.rsiLow}–${p.thresholds.rsiHigh}.`,
      })),
  }),
  check({
    code: 'NO_BEARISH_DIVERGENCE',
    failCode: 'BEARISH_RSI_DIVERGENCE',
    section: 'technicals',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[{ kind: string; lookbackBars: number }]>(
        'RSI divergence',
        [read('technicals', s.technicals.rsiDivergence)],
        (d) =>
          inRange(d.lookbackBars, p.windows.divergenceLookbackBars)
            ? {
                pass: d.kind !== 'BEARISH',
                message: `RSI divergence over ${d.lookbackBars} bars: ${d.kind.toLowerCase()}.`,
              }
            : undefined,
      ),
  }),
  check({
    code: 'VOLUME_SURGE',
    failCode: 'NO_VOLUME_SURGE',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Volume', [read('technicals', s.technicals.volumeRatio20d)], (ratio) => ({
        pass: ratio > p.thresholds.volumeSurgeRatio,
        message: `Volume ${fmt(ratio)}x the 20-day average vs surge above ${p.thresholds.volumeSurgeRatio}x.`,
      })),
  }),
  check({
    code: 'CONSOLIDATION_BREAKOUT',
    failCode: 'NO_CONSOLIDATION_BREAKOUT',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[{ brokeOutUp: boolean; rangeWeeks: number }]>(
        'Consolidation breakout',
        [read('technicals', s.technicals.consolidationBreakout)],
        (b) =>
          inRange(b.rangeWeeks, p.windows.breakoutRangeWeeks)
            ? {
                pass: b.brokeOutUp,
                message: b.brokeOutUp
                  ? `Broke out above a ${b.rangeWeeks}-week consolidation range.`
                  : `No breakout from the ${b.rangeWeeks}-week consolidation range.`,
              }
            : undefined,
      ),
  }),
  check({
    code: 'LONG_BUILD_UP',
    failCode: 'NO_LONG_BUILD_UP',
    section: 'derivatives',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[number, number]>(
        'Open interest build-up',
        [read('derivatives', s.derivatives.priceChangePct), read('derivatives', s.derivatives.oiChangePct)],
        (price, oi) => {
          const kind = classifyOiBuildUp(price, oi);
          return {
            pass: kind === 'LONG_BUILD_UP',
            message: `Futures price ${fmt(price)}%, OI ${fmt(oi)}%: ${kind ? OI_BUILD_UP_LABELS[kind] : 'unclassified'}.`,
          };
        },
      ),
  }),
  check({
    code: 'NO_SHORT_BUILD_UP',
    failCode: 'SHORT_BUILD_UP',
    section: 'derivatives',
    requiredForBuy: false,
    veto: true,
    scored: false,
    run: ({ snapshot: s, read }) =>
      withReadings<[number, number]>(
        'Open interest build-up',
        [read('derivatives', s.derivatives.priceChangePct), read('derivatives', s.derivatives.oiChangePct)],
        (price, oi) => {
          const short = classifyOiBuildUp(price, oi) === 'SHORT_BUILD_UP';
          return {
            pass: !short,
            message: short
              ? `Short build-up: futures price ${fmt(price)}% with OI ${fmt(oi)}%.`
              : `No short build-up (futures price ${fmt(price)}%, OI ${fmt(oi)}%).`,
          };
        },
      ),
  }),
  check({
    code: 'NOT_IN_FNO_BAN',
    failCode: 'IN_FNO_BAN',
    section: 'derivatives',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[boolean]>('F&O ban status', [read('derivatives', s.derivatives.inFnoBan)], (ban) => ({
        pass: !ban,
        message: ban ? 'Security is in the F&O ban list.' : 'Security is not in the F&O ban list.',
      })),
  }),
  check({
    code: 'BASIS_NON_NEGATIVE',
    failCode: 'BASIS_NEGATIVE',
    section: 'derivatives',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[number]>('Futures basis', [read('derivatives', s.derivatives.basisPct)], (basis) => ({
        pass: basis >= p.thresholds.basisMinPct,
        message: `Futures basis ${fmt(basis)}% (${basis > 0 ? 'contango' : basis < 0 ? 'backwardation' : 'flat'}).`,
      })),
  }),
  check({
    code: 'FII_NET_BUYING',
    failCode: 'FII_NOT_NET_BUYING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[{ netInrCr: number; lookbackDays: number }]>(
        'FII flows',
        [read('sentiment', s.sentiment.fiiNetFlow)],
        (f) => ({
          pass: f.netInrCr > p.thresholds.fiiNetFlowMinInrCr,
          message: `FII net flow ₹${fmt(f.netInrCr)} cr over ${f.lookbackDays} days.`,
        }),
      ),
  }),
  check({
    code: 'DII_NET_BUYING',
    failCode: 'DII_NOT_NET_BUYING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p, read }) =>
      withReadings<[{ netInrCr: number; lookbackDays: number }]>(
        'DII flows',
        [read('sentiment', s.sentiment.diiNetFlow)],
        (f) => ({
          pass: f.netInrCr > p.thresholds.diiNetFlowMinInrCr,
          message: `DII net flow ₹${fmt(f.netInrCr)} cr over ${f.lookbackDays} days.`,
        }),
      ),
  }),
  check({
    code: 'DEALS_NOT_NET_SELLING',
    failCode: 'DEALS_NET_SELLING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, read }) =>
      withReadings<[{ side: 'BUY' | 'SELL'; quantity: number }[]]>(
        'Bulk/block deals',
        [read('sentiment', s.sentiment.bulkBlockDeals30d)],
        (deals) => {
          const bought = deals.filter((d) => d.side === 'BUY').reduce((sum, d) => sum + d.quantity, 0);
          const sold = deals.filter((d) => d.side === 'SELL').reduce((sum, d) => sum + d.quantity, 0);
          return {
            pass: bought >= sold,
            message:
              deals.length === 0
                ? 'No bulk/block deals in the last 30 days.'
                : `Bulk/block deals: ${bought} bought vs ${sold} sold (30 days).`,
          };
        },
      ),
  }),
]);

/** Check sets by policy version; a policy is always evaluated with its own version's checks. */
const CHECKS_BY_VERSION: Readonly<Record<string, readonly CheckDefinition[]>> = Object.freeze({ v1: CHECKS_V1 });

export function checksFor(policy: DecisionPolicy): readonly CheckDefinition[] {
  const checks = CHECKS_BY_VERSION[policy.version];
  if (!checks) throw new Error(`No checks registered for policy version ${policy.version}`);
  return checks;
}
