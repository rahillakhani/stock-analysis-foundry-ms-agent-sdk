// Synthetic research snapshots for decision-engine tests. Values are illustrative, not market data.
import type { Instrument, ResearchSnapshot } from '@stock-analysis/shared';

export const AS_OF = '2026-09-30T10:00:00.000Z';
export const SRC_QUOTE = 'fixture:quote';
export const SRC_FIN = 'fixture:financials';
export const SRC_FNO = 'fixture:fno';
export const SRC_FLOWS = 'fixture:flows';

/** An observation `daysBefore` days before AS_OF. */
export const daysBefore = (days: number) => new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString();

export const ok = <T>(value: T, sourceId: string, observedAt = AS_OF) => ({
  status: 'OK' as const,
  value,
  sourceId,
  observedAt,
});
const na = { status: 'NOT_APPLICABLE' as const, value: null };

const equity: Instrument = { exchange: 'NSE', symbol: 'TESTCO', name: 'Test Co Ltd', assetType: 'EQUITY' };
const future: Instrument = {
  exchange: 'NSE',
  symbol: 'TESTCO',
  name: 'Test Co Futures 2026-10-27',
  assetType: 'FUTURE',
  contract: { expiry: '2026-10-27', lotSize: 100 },
};

/**
 * An equity with no F&O contract where every v1 check passes: BUY with all subscores at 100.
 * Fresh object per call; mutate freely.
 */
export function strongEquity(): ResearchSnapshot {
  return {
    schemaVersion: 1,
    instrument: equity,
    currency: 'INR',
    asOf: AS_OF,
    fundamentals: {
      revenueGrowthYoYPct: ok(10, SRC_FIN),
      netMarginPct: ok(8, SRC_FIN),
      operatingMarginPctQuarterly: ok(
        [
          { period: '2026-Q1', valuePct: 11 },
          { period: '2026-Q2', valuePct: 12 },
          { period: '2026-Q3', valuePct: 13 },
        ],
        SRC_FIN,
      ),
      peRatio: ok(20, SRC_QUOTE),
      psRatio: ok(2, SRC_QUOTE),
      debtToEquity: ok(0.3, SRC_FIN),
      roePct: ok(18, SRC_FIN),
      rocePct: ok(17, SRC_FIN),
      promoterHoldingPct: ok(50, SRC_FIN),
      promoterPledgePct: ok(0, SRC_FIN),
      auditorOpinion: ok('UNQUALIFIED' as const, SRC_FIN),
    },
    technicals: {
      lastPrice: ok(110, SRC_QUOTE),
      ema20: ok(108, SRC_QUOTE),
      ema50: ok(100, SRC_QUOTE),
      ema200: ok(90, SRC_QUOTE),
      rsi14: ok(60, SRC_QUOTE),
      atr14: ok(2, SRC_QUOTE),
      volumeRatio20d: ok(1.8, SRC_QUOTE),
      rsiDivergence: ok({ kind: 'NONE' as const, lookbackBars: 14 }, SRC_QUOTE),
      consolidationBreakout: ok({ brokeOutUp: true, rangeWeeks: 6 }, SRC_QUOTE),
    },
    derivatives: {
      nearMonthExpiry: na,
      futuresPrice: na,
      priceChangePct: na,
      oiChangePct: na,
      basisPct: na,
      inFnoBan: na,
    },
    sentiment: {
      bulkBlockDeals30d: ok([], SRC_FLOWS),
      fiiNetFlow: ok({ netInrCr: 100, lookbackDays: 30 }, SRC_FLOWS),
      diiNetFlow: ok({ netInrCr: 50, lookbackDays: 30 }, SRC_FLOWS),
      announcements: ok([], SRC_FLOWS),
    },
    sources: [
      { id: SRC_QUOTE, provider: 'fixture', retrievedAt: AS_OF },
      { id: SRC_FIN, provider: 'fixture', retrievedAt: AS_OF },
      { id: SRC_FNO, provider: 'fixture', retrievedAt: AS_OF },
      { id: SRC_FLOWS, provider: 'fixture', retrievedAt: AS_OF },
    ],
  };
}

/** A FUTURE where every v1 check passes, including long build-up. */
export function strongFuture(): ResearchSnapshot {
  return {
    ...strongEquity(),
    instrument: future,
    derivatives: {
      nearMonthExpiry: ok('2026-10-27', SRC_FNO),
      futuresPrice: ok(110.5, SRC_FNO),
      priceChangePct: ok(1.5, SRC_FNO),
      oiChangePct: ok(5, SRC_FNO),
      basisPct: ok(0.4, SRC_FNO),
      inFnoBan: ok(false, SRC_FNO),
    },
  };
}
