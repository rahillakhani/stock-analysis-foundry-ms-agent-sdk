import type { OI_BUILD_UPS } from '@stock-analysis/shared';
import { type Metric, type ResearchSnapshot } from '@stock-analysis/shared';
import type { DecisionPolicy, Section } from './policy.ts';

const MS_PER_DAY = 86_400_000;

/** What the engine may do with a metric. Only USABLE values can pass a check or fire a veto. */
export type Reading<T> =
  | { kind: 'USABLE'; value: T; sourceId: string }
  | { kind: 'STALE'; sourceId: string; observedAt: string }
  | { kind: 'UNAVAILABLE'; sourceId: string | undefined }
  | { kind: 'NOT_APPLICABLE' };

/** Applies the policy's max age for the section, measured against the snapshot's asOf (never the wall clock). */
export function read<T>(metric: Metric<T>, section: Section, policy: DecisionPolicy, asOf: string): Reading<T> {
  switch (metric.status) {
    case 'NOT_APPLICABLE':
      return { kind: 'NOT_APPLICABLE' };
    case 'MISSING':
    case 'ERROR':
      return { kind: 'UNAVAILABLE', sourceId: metric.sourceId };
    case 'OK': {
      const ageDays = (Date.parse(asOf) - Date.parse(metric.observedAt)) / MS_PER_DAY;
      return ageDays <= policy.maxAgeDays[section]
        ? { kind: 'USABLE', value: metric.value, sourceId: metric.sourceId }
        : { kind: 'STALE', sourceId: metric.sourceId, observedAt: metric.observedAt };
    }
  }
}

export type OiBuildUp = (typeof OI_BUILD_UPS)[number];

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

export interface CheckDefinition {
  /** Stable code used in reasons when the check passes. */
  code: string;
  /** Stable code used in risk factors when the check fails. */
  failCode: string;
  section: Section;
  requiredForBuy: boolean;
  veto: boolean;
  scored: boolean;
  run(ctx: CheckContext): CheckOutcome;
}

/** Verdict from a check's predicate; `undefined` means the usable data was insufficient to decide. */
type Verdict = { pass: boolean; message: string } | undefined;

export interface CheckContext {
  snapshot: ResearchSnapshot;
  policy: DecisionPolicy;
}

/** Evaluates `decide` only when every input is usable; otherwise reports why the check couldn't run. */
function withReadings<T extends unknown[]>(
  label: string,
  readings: { [K in keyof T]: Reading<T[K]> },
  decide: (...values: T) => Verdict,
): CheckOutcome {
  const all = readings as Reading<unknown>[];
  if (all.some((r) => r.kind === 'NOT_APPLICABLE')) return { state: 'NOT_APPLICABLE' };

  const sourceIds = [
    ...new Set(all.flatMap((r) => (r.kind !== 'NOT_APPLICABLE' && r.sourceId !== undefined ? [r.sourceId] : []))),
  ];
  const stale = all.find((r): r is Extract<Reading<unknown>, { kind: 'STALE' }> => r.kind === 'STALE');
  if (all.some((r) => r.kind === 'UNAVAILABLE')) {
    return { state: 'UNAVAILABLE', message: `${label}: data unavailable.`, sourceIds };
  }
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

const fmt = (value: number, digits = 2) => Number(value.toFixed(digits)).toString();

/** The v1 checks, in the order they appear in docs/decision-policy-v1.md §2 and in the output. */
export const CHECKS_V1: readonly CheckDefinition[] = [
  {
    code: 'ROE_ABOVE_MIN',
    failCode: 'ROE_NOT_ABOVE_MIN',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('ROE', [read(s.fundamentals.roePct, 'fundamentals', p, s.asOf)], (roe) => ({
        pass: roe > p.thresholds.roeMinPct,
        message: `ROE ${fmt(roe)}% vs minimum above ${p.thresholds.roeMinPct}%.`,
      })),
  },
  {
    code: 'DEBT_EQUITY_BELOW_MAX',
    failCode: 'DEBT_EQUITY_NOT_BELOW_MAX',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('Debt/Equity', [read(s.fundamentals.debtToEquity, 'fundamentals', p, s.asOf)], (de) => ({
        pass: de < p.thresholds.debtToEquityMax,
        message: `Debt/Equity ${fmt(de)} vs maximum below ${p.thresholds.debtToEquityMax}.`,
      })),
  },
  {
    code: 'PLEDGE_BELOW_MAX',
    failCode: 'PLEDGE_NOT_BELOW_MAX',
    section: 'fundamentals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>(
        'Promoter pledging',
        [read(s.fundamentals.promoterPledgePct, 'fundamentals', p, s.asOf)],
        (pledge) => ({
          pass: pledge < p.thresholds.pledgeMaxPct,
          message: `Promoter pledging ${fmt(pledge)}% vs BUY limit below ${p.thresholds.pledgeMaxPct}%.`,
        }),
      ),
  },
  {
    code: 'PLEDGE_NOT_EXCESSIVE',
    failCode: 'PLEDGE_EXCESSIVE',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: true,
    scored: false,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>(
        'Promoter pledging',
        [read(s.fundamentals.promoterPledgePct, 'fundamentals', p, s.asOf)],
        (pledge) => ({
          pass: pledge <= p.thresholds.pledgeMaxPct,
          message: `Promoter pledging ${fmt(pledge)}% vs veto above ${p.thresholds.pledgeMaxPct}%.`,
        }),
      ),
  },
  {
    code: 'OPERATING_MARGIN_STABLE',
    failCode: 'OPERATING_MARGIN_SHRINKING',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ period: string; valuePct: number }[]]>(
        'Operating margin trend',
        [read(s.fundamentals.operatingMarginPctQuarterly, 'fundamentals', p, s.asOf)],
        (quarters) => {
          const n = p.thresholds.shrinkingQuarters;
          if (quarters.length < n) return undefined;
          const recent = quarters.slice(-n);
          let shrinking = true;
          let previous: number | undefined;
          for (const quarter of recent) {
            if (previous !== undefined && quarter.valuePct >= previous) shrinking = false;
            previous = quarter.valuePct;
          }
          const trail = recent.map((q) => `${q.period} ${fmt(q.valuePct)}%`).join(' → ');
          return {
            pass: !shrinking,
            message: shrinking
              ? `Operating margin shrinking for ${n} quarters: ${trail}.`
              : `Operating margin not shrinking: ${trail}.`,
          };
        },
      ),
  },
  {
    code: 'REVENUE_GROWING',
    failCode: 'REVENUE_NOT_GROWING',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>(
        'Revenue growth',
        [read(s.fundamentals.revenueGrowthYoYPct, 'fundamentals', p, s.asOf)],
        (growth) => ({ pass: growth > 0, message: `Revenue growth ${fmt(growth)}% YoY.` }),
      ),
  },
  {
    code: 'NET_MARGIN_POSITIVE',
    failCode: 'NET_MARGIN_NOT_POSITIVE',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('Net margin', [read(s.fundamentals.netMarginPct, 'fundamentals', p, s.asOf)], (m) => ({
        pass: m > 0,
        message: `Net margin ${fmt(m)}%.`,
      })),
  },
  {
    code: 'AUDITOR_UNQUALIFIED',
    failCode: 'AUDITOR_NOT_UNQUALIFIED',
    section: 'fundamentals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[string]>(
        'Auditor opinion',
        [read(s.fundamentals.auditorOpinion, 'fundamentals', p, s.asOf)],
        (opinion) => ({ pass: opinion === 'UNQUALIFIED', message: `Auditor opinion: ${opinion}.` }),
      ),
  },
  {
    code: 'PRICE_ABOVE_EMA50',
    failCode: 'PRICE_NOT_ABOVE_EMA50',
    section: 'technicals',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number, number]>(
        'Price vs EMA50',
        [read(s.technicals.lastPrice, 'technicals', p, s.asOf), read(s.technicals.ema50, 'technicals', p, s.asOf)],
        (price, ema) => ({ pass: price > ema, message: `Price ${fmt(price)} vs EMA50 ${fmt(ema)}.` }),
      ),
  },
  {
    code: 'PRICE_ABOVE_EMA200',
    failCode: 'PRICE_NOT_ABOVE_EMA200',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number, number]>(
        'Price vs EMA200',
        [read(s.technicals.lastPrice, 'technicals', p, s.asOf), read(s.technicals.ema200, 'technicals', p, s.asOf)],
        (price, ema) => ({ pass: price > ema, message: `Price ${fmt(price)} vs EMA200 ${fmt(ema)}.` }),
      ),
  },
  {
    code: 'EMA20_ABOVE_EMA50',
    failCode: 'EMA20_NOT_ABOVE_EMA50',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number, number]>(
        'EMA20 vs EMA50',
        [read(s.technicals.ema20, 'technicals', p, s.asOf), read(s.technicals.ema50, 'technicals', p, s.asOf)],
        (ema20, ema50) => ({ pass: ema20 > ema50, message: `EMA20 ${fmt(ema20)} vs EMA50 ${fmt(ema50)}.` }),
      ),
  },
  {
    code: 'RSI_IN_HEALTHY_RANGE',
    failCode: 'RSI_OUTSIDE_HEALTHY_RANGE',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('RSI(14)', [read(s.technicals.rsi14, 'technicals', p, s.asOf)], (rsi) => ({
        pass: rsi >= p.thresholds.rsiLow && rsi <= p.thresholds.rsiHigh,
        message: `RSI(14) ${fmt(rsi, 1)} vs healthy range ${p.thresholds.rsiLow}–${p.thresholds.rsiHigh}.`,
      })),
  },
  {
    code: 'NO_BEARISH_DIVERGENCE',
    failCode: 'BEARISH_RSI_DIVERGENCE',
    section: 'technicals',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ kind: string; lookbackBars: number }]>(
        'RSI divergence',
        [read(s.technicals.rsiDivergence, 'technicals', p, s.asOf)],
        (d) => ({
          pass: d.kind !== 'BEARISH',
          message: `RSI divergence over ${d.lookbackBars} bars: ${d.kind.toLowerCase()}.`,
        }),
      ),
  },
  {
    code: 'VOLUME_SURGE',
    failCode: 'NO_VOLUME_SURGE',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('Volume', [read(s.technicals.volumeRatio20d, 'technicals', p, s.asOf)], (ratio) => ({
        pass: ratio > p.thresholds.volumeSurgeRatio,
        message: `Volume ${fmt(ratio)}x the 20-day average vs surge above ${p.thresholds.volumeSurgeRatio}x.`,
      })),
  },
  {
    code: 'CONSOLIDATION_BREAKOUT',
    failCode: 'NO_CONSOLIDATION_BREAKOUT',
    section: 'technicals',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ brokeOutUp: boolean; rangeWeeks: number }]>(
        'Consolidation breakout',
        [read(s.technicals.consolidationBreakout, 'technicals', p, s.asOf)],
        (b) => ({
          pass: b.brokeOutUp,
          message: b.brokeOutUp
            ? `Broke out above a ${b.rangeWeeks}-week consolidation range.`
            : `No breakout from the ${b.rangeWeeks}-week consolidation range.`,
        }),
      ),
  },
  {
    code: 'LONG_BUILD_UP',
    failCode: 'NO_LONG_BUILD_UP',
    section: 'derivatives',
    requiredForBuy: true,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number, number]>(
        'Open interest build-up',
        [
          read(s.derivatives.priceChangePct, 'derivatives', p, s.asOf),
          read(s.derivatives.oiChangePct, 'derivatives', p, s.asOf),
        ],
        (price, oi) => {
          const kind = classifyOiBuildUp(price, oi);
          return {
            pass: kind === 'LONG_BUILD_UP',
            message: `Futures price ${fmt(price)}%, OI ${fmt(oi)}%: ${kind?.toLowerCase().replace(/_/g, ' ') ?? 'unclassified'}.`,
          };
        },
      ),
  },
  {
    code: 'NO_SHORT_BUILD_UP',
    failCode: 'SHORT_BUILD_UP',
    section: 'derivatives',
    requiredForBuy: false,
    veto: true,
    scored: false,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number, number]>(
        'Open interest build-up',
        [
          read(s.derivatives.priceChangePct, 'derivatives', p, s.asOf),
          read(s.derivatives.oiChangePct, 'derivatives', p, s.asOf),
        ],
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
  },
  {
    code: 'NOT_IN_FNO_BAN',
    failCode: 'IN_FNO_BAN',
    section: 'derivatives',
    requiredForBuy: false,
    veto: true,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[boolean]>('F&O ban status', [read(s.derivatives.inFnoBan, 'derivatives', p, s.asOf)], (ban) => ({
        pass: !ban,
        message: ban ? 'Security is in the F&O ban list.' : 'Security is not in the F&O ban list.',
      })),
  },
  {
    code: 'BASIS_NON_NEGATIVE',
    failCode: 'BASIS_NEGATIVE',
    section: 'derivatives',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[number]>('Futures basis', [read(s.derivatives.basisPct, 'derivatives', p, s.asOf)], (basis) => ({
        pass: basis >= 0,
        message: `Futures basis ${fmt(basis)}% (${basis > 0 ? 'contango' : basis < 0 ? 'backwardation' : 'flat'}).`,
      })),
  },
  {
    code: 'FII_NET_BUYING',
    failCode: 'FII_NOT_NET_BUYING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ netInrCr: number; lookbackDays: number }]>(
        'FII flows',
        [read(s.sentiment.fiiNetFlow, 'sentiment', p, s.asOf)],
        (f) => ({ pass: f.netInrCr > 0, message: `FII net flow ₹${fmt(f.netInrCr)} cr over ${f.lookbackDays} days.` }),
      ),
  },
  {
    code: 'DII_NET_BUYING',
    failCode: 'DII_NOT_NET_BUYING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ netInrCr: number; lookbackDays: number }]>(
        'DII flows',
        [read(s.sentiment.diiNetFlow, 'sentiment', p, s.asOf)],
        (f) => ({ pass: f.netInrCr > 0, message: `DII net flow ₹${fmt(f.netInrCr)} cr over ${f.lookbackDays} days.` }),
      ),
  },
  {
    code: 'DEALS_NOT_NET_SELLING',
    failCode: 'DEALS_NET_SELLING',
    section: 'sentiment',
    requiredForBuy: false,
    veto: false,
    scored: true,
    run: ({ snapshot: s, policy: p }) =>
      withReadings<[{ side: 'BUY' | 'SELL'; quantity: number }[]]>(
        'Bulk/block deals',
        [read(s.sentiment.bulkBlockDeals30d, 'sentiment', p, s.asOf)],
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
  },
];
