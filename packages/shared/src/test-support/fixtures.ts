// Synthetic fixtures for contract tests. Values are illustrative, not real market data.
import type { DecisionResult } from '../decision.ts';
import type { Instrument } from '../instrument.ts';
import type { ResearchSnapshot } from '../research.ts';
import type { Source } from '../source.ts';

export const AS_OF = '2026-09-30T10:00:00.000Z';
export const OBSERVED = '2026-09-30T09:45:00.000Z';
export const SRC_QUOTE = 'fixture:quote:tatasteel';
export const SRC_FIN = 'fixture:financials:tatasteel';
export const SRC_FLOWS = 'fixture:flows:nse';

const ok = <T>(value: T, sourceId: string) => ({ status: 'OK' as const, value, sourceId, observedAt: OBSERVED });
const notApplicable = { status: 'NOT_APPLICABLE' as const, value: null };

export const equity: Instrument = { exchange: 'NSE', symbol: 'TATASTEEL', name: 'Tata Steel Ltd', assetType: 'EQUITY' };

export const niftyFuture: Extract<Instrument, { assetType: 'FUTURE' }> = {
  exchange: 'NSE',
  symbol: 'NIFTY',
  name: 'Nifty 50 Futures',
  assetType: 'FUTURE',
  contract: { expiry: '2026-10-27', lotSize: 75 },
};

export function sources(): Source[] {
  return [
    { id: SRC_QUOTE, provider: 'fixture', retrievedAt: AS_OF },
    { id: SRC_FIN, provider: 'fixture', url: 'https://example.com/financials', retrievedAt: AS_OF },
    { id: SRC_FLOWS, provider: 'fixture', retrievedAt: AS_OF },
  ];
}

/** A complete, valid equity snapshot with no F&O contract. Fresh object per call; safe to mutate. */
export function equitySnapshot(): ResearchSnapshot {
  return {
    schemaVersion: 1,
    instrument: equity,
    currency: 'INR',
    asOf: AS_OF,
    fundamentals: {
      revenueGrowthYoYPct: ok(8.2, SRC_FIN),
      netMarginPct: ok(6.1, SRC_FIN),
      operatingMarginPctQuarterly: ok(
        [
          { period: '2026-Q1', valuePct: 12.4 },
          { period: '2026-Q2', valuePct: 11.9 },
        ],
        SRC_FIN,
      ),
      peRatio: ok(18.5, SRC_QUOTE),
      psRatio: ok(0.9, SRC_QUOTE),
      debtToEquity: ok(0.45, SRC_FIN),
      roePct: ok(16.2, SRC_FIN),
      rocePct: ok(14.8, SRC_FIN),
      promoterHoldingPct: ok(33.2, SRC_FIN),
      promoterPledgePct: ok(0, SRC_FIN),
      auditorOpinion: ok('UNQUALIFIED' as const, SRC_FIN),
    },
    technicals: {
      lastPrice: ok(152.3, SRC_QUOTE),
      ema20: ok(149.8, SRC_QUOTE),
      ema50: ok(146.1, SRC_QUOTE),
      ema200: ok(140.2, SRC_QUOTE),
      rsi14: ok(58.4, SRC_QUOTE),
      atr14: ok(3.9, SRC_QUOTE),
      volumeRatio20d: ok(1.7, SRC_QUOTE),
      rsiDivergence: ok({ kind: 'NONE' as const, lookbackBars: 14 }, SRC_QUOTE),
      consolidationBreakout: ok({ brokeOutUp: true, rangeWeeks: 6 }, SRC_QUOTE),
    },
    derivatives: {
      nearMonthExpiry: notApplicable,
      futuresPrice: notApplicable,
      priceChangePct: notApplicable,
      oiChangePct: notApplicable,
      basisPct: notApplicable,
      inFnoBan: notApplicable,
    },
    sentiment: {
      bulkBlockDeals30d: ok([], SRC_FLOWS),
      fiiNetFlow: ok({ netInrCr: 1250.5, lookbackDays: 30 }, SRC_FLOWS),
      diiNetFlow: { status: 'MISSING', value: null },
      announcements: ok([{ publishedAt: OBSERVED, headline: 'Board meeting on 2026-10-15' }], SRC_FLOWS),
    },
    sources: sources(),
  };
}

/** A valid FUTURE snapshot with populated derivatives. */
export function futureSnapshot(): ResearchSnapshot {
  return {
    ...equitySnapshot(),
    instrument: niftyFuture,
    derivatives: {
      nearMonthExpiry: ok('2026-10-27', SRC_QUOTE),
      futuresPrice: ok(152.8, SRC_QUOTE),
      priceChangePct: ok(1.2, SRC_QUOTE),
      oiChangePct: ok(6.5, SRC_QUOTE),
      basisPct: ok(0.33, SRC_QUOTE),
      inFnoBan: ok(false, SRC_QUOTE),
    },
  };
}

export function decision(): DecisionResult {
  return {
    indicator: 'BUY',
    confidenceScore: 72.5,
    subscores: { fundamental: 80, technical: 75, derivatives: null, sentiment: 60 },
    riskReward: { ratio: 2, entry: 152.3, stop: 144.5, target: 167.9, method: '2x ATR14 stop, 4x ATR14 target' },
    reasons: [{ code: 'ROE_ABOVE_THRESHOLD', message: 'ROE 16.2% is above 15%.', sourceIds: [SRC_FIN] }],
    riskFactors: [{ code: 'DII_FLOWS_MISSING', message: 'DII flow data unavailable.', sourceIds: [] }],
    policyVersion: 'v1',
    evaluatedAt: AS_OF,
  };
}
