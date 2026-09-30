import type { Instrument, Source } from '@stock-analysis/shared';
import type { InstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { nearestLiveExpiry } from '../domain/instruments/resolveInstrument.ts';
import type { Dimension, DimensionData, DimensionResult, FetchContext, ResearchProvider } from './researchProvider.ts';

// SYNTHETIC sample data for local development and demos. Every value is generated from a seeded PRNG (symbol +
// calendar day), so the same stock on the same day always yields the same research, different stocks yield
// different verdicts, and re-analysing on a later day drifts slightly. Nothing here is real market data.

const PROVIDER = 'fixture';

/** Deterministic 32-bit PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a hash of a string, used to seed the PRNG. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Last `count` calendar quarters that ended before `asOf`, oldest first (`YYYY-Qn`). */
function completedQuarters(asOf: Date, count: number): string[] {
  const currentIndex = asOf.getUTCFullYear() * 4 + Math.floor(asOf.getUTCMonth() / 3);
  return Array.from({ length: count }, (_, i) => {
    const index = currentIndex - count + i;
    return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
  });
}

export class FixtureResearchProvider implements ResearchProvider {
  readonly name = PROVIDER;
  readonly #master: InstrumentMaster;

  constructor(master: InstrumentMaster) {
    this.#master = master;
  }

  fetch<D extends Dimension>(dimension: D, instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<D>> {
    if (ctx.signal.aborted) return Promise.reject(ctx.signal.reason as Error);
    const day = ctx.asOf.toISOString().slice(0, 10);
    const observedAt = ctx.asOf.toISOString();
    const sourceId = `${PROVIDER}:${dimension}:${instrument.symbol.toLowerCase().replace(/[^a-z0-9]/g, '-')}:${day}`;
    const source: Source = { id: sourceId, provider: PROVIDER, retrievedAt: observedAt };
    // Seed per symbol+dimension+day so dimensions vary independently but reproducibly.
    const random = prng(hash(`${instrument.exchange}:${instrument.symbol}:${dimension}:${day}`));
    // Spot price and basis are shared by technicals and derivatives so futures data stays internally consistent.
    const shared = prng(hash(`${instrument.exchange}:${instrument.symbol}:market:${day}`));
    const spot = round2(80 + 3420 * shared());
    const basisPct = round2(-0.3 + 1 * shared());
    const futuresPrice = round2(spot * (1 + basisPct / 100));
    const record = this.#master.all().find((r) => r.exchange === instrument.exchange && r.symbol === instrument.symbol);
    const ok = <T>(value: T) => ({ status: 'OK' as const, value, sourceId, observedAt });
    const between = (min: number, max: number) => round2(min + (max - min) * random());

    const sections: { [K in Dimension]: () => DimensionData[K] } = {
      fundamentals: () => {
        if (record?.assetType === 'INDEX' || instrument.assetType === 'INDEX') {
          // Indices and index futures have no company fundamentals.
          const missing = { status: 'MISSING' as const, value: null };
          return {
            revenueGrowthYoYPct: missing,
            netMarginPct: missing,
            operatingMarginPctQuarterly: missing,
            peRatio: missing,
            psRatio: missing,
            debtToEquity: missing,
            roePct: missing,
            rocePct: missing,
            promoterHoldingPct: missing,
            promoterPledgePct: missing,
            auditorOpinion: missing,
          };
        }
        const marginStart = between(8, 25);
        const marginDrift = between(-2, 2);
        return {
          revenueGrowthYoYPct: ok(between(-6, 22)),
          netMarginPct: ok(between(-2, 18)),
          operatingMarginPctQuarterly: ok(
            completedQuarters(ctx.asOf, 3).map((period, i) => ({
              period,
              valuePct: round2(marginStart + marginDrift * i),
            })),
          ),
          peRatio: ok(between(8, 60)),
          psRatio: ok(between(0.5, 12)),
          debtToEquity: ok(between(0, 1.2)),
          roePct: ok(between(6, 28)),
          rocePct: ok(between(6, 30)),
          promoterHoldingPct: ok(between(25, 75)),
          promoterPledgePct: ok(random() < 0.75 ? 0 : between(1, 35)),
          auditorOpinion: ok(random() < 0.92 ? ('UNQUALIFIED' as const) : ('QUALIFIED' as const)),
        };
      },
      technicals: () => {
        // For a FUTURE, the instrument's own traded price is the contract price.
        const price = instrument.assetType === 'FUTURE' ? futuresPrice : spot;
        const ema50 = round2(price * (1 + between(-0.08, 0.08)));
        return {
          lastPrice: ok(price),
          ema20: ok(round2(price * (1 + between(-0.04, 0.04)))),
          ema50: ok(ema50),
          ema200: ok(round2(price * (1 + between(-0.15, 0.15)))),
          rsi14: ok(between(28, 78)),
          atr14: ok(round2(price * between(0.01, 0.035))),
          volumeRatio20d: ok(between(0.5, 2.4)),
          rsiDivergence: ok({
            kind: random() < 0.15 ? ('BEARISH' as const) : random() < 0.2 ? ('BULLISH' as const) : ('NONE' as const),
            lookbackBars: 14,
          }),
          consolidationBreakout: ok({ brokeOutUp: random() < 0.35, rangeWeeks: 6 }),
        };
      },
      derivatives: () => {
        const hasFno = instrument.assetType === 'FUTURE' || record?.futuresExpiries !== undefined;
        const expiry =
          instrument.assetType === 'FUTURE'
            ? instrument.contract.expiry
            : record?.futuresExpiries && nearestLiveExpiry(record.futuresExpiries, ctx.asOf);
        if (!hasFno || expiry === undefined) {
          const na = { status: 'NOT_APPLICABLE' as const, value: null };
          return {
            nearMonthExpiry: na,
            futuresPrice: na,
            priceChangePct: na,
            oiChangePct: na,
            basisPct: na,
            inFnoBan: na,
          };
        }
        return {
          nearMonthExpiry: ok(expiry),
          futuresPrice: ok(futuresPrice),
          priceChangePct: ok(between(-2.5, 2.5)),
          oiChangePct: ok(between(-6, 9)),
          basisPct: ok(basisPct),
          inFnoBan: ok(random() < 0.05),
        };
      },
      sentiment: () => ({
        bulkBlockDeals30d: ok(
          random() < 0.4
            ? [
                {
                  date: day,
                  kind: 'BULK' as const,
                  side: random() < 0.5 ? ('BUY' as const) : ('SELL' as const),
                  quantity: Math.round(between(10_000, 500_000)),
                  price: between(80, 3500),
                },
              ]
            : [],
        ),
        fiiNetFlow: ok({ netInrCr: between(-800, 900), lookbackDays: 30 }),
        diiNetFlow: ok({ netInrCr: between(-500, 700), lookbackDays: 30 }),
        announcements: ok([
          { publishedAt: observedAt, headline: `${instrument.name}: sample announcement (synthetic)` },
        ]),
      }),
    };

    return Promise.resolve({ data: sections[dimension](), sources: [source] });
  }
}
