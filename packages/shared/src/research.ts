import { z } from 'zod';
import { IsoDate, IsoDateTime, isStrictlyAscending, Percent0To100 } from './common.ts';
import { Instrument } from './instrument.ts';
import { metricSchema, type Metric } from './metric.ts';
import { Source } from './source.ts';

// Units and windows are in field names or recorded next to the value, so a stored snapshot is self-describing and
// can be re-evaluated under any policy version. Ratios are plain numbers (0.45 = 0.45x); *Pct fields are
// percentages (15 = 15%). Classifications that depend on policy (OI build-up type, contango vs backwardation,
// staleness) are derived by the decision engine, not stored here.

/** Quarterly values, oldest first, unique periods (`YYYY-Qn`). Used for trend rules like "shrinking margins". */
const QuarterlyPct = z
  .array(z.object({ period: z.string().regex(/^\d{4}-Q[1-4]$/), valuePct: z.number() }))
  .min(1)
  .max(40)
  .refine((quarters) => isStrictlyAscending(quarters.map((q) => q.period)), 'periods must be unique and ascending');

/**
 * Statutory auditor's opinion type only. Emphasis-of-matter paragraphs and other note text are intentionally not
 * captured in v1; add a field if a policy rule needs them.
 */
export const AUDITOR_OPINIONS = ['UNQUALIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER'] as const;
export const RSI_DIVERGENCES = ['BEARISH', 'BULLISH', 'NONE'] as const;
/** Vocabulary for the engine's OI classification from price and OI change; not a snapshot field. */
export const OI_BUILD_UPS = ['LONG_BUILD_UP', 'SHORT_BUILD_UP', 'SHORT_COVERING', 'LONG_UNWINDING'] as const;

export const Fundamentals = z.object({
  revenueGrowthYoYPct: metricSchema(z.number()),
  netMarginPct: metricSchema(z.number()),
  operatingMarginPctQuarterly: metricSchema(QuarterlyPct),
  peRatio: metricSchema(z.number()),
  psRatio: metricSchema(z.number().nonnegative()),
  debtToEquity: metricSchema(z.number().nonnegative()),
  roePct: metricSchema(z.number()),
  rocePct: metricSchema(z.number()),
  promoterHoldingPct: metricSchema(Percent0To100),
  promoterPledgePct: metricSchema(Percent0To100),
  auditorOpinion: metricSchema(z.enum(AUDITOR_OPINIONS)),
});

export const Technicals = z.object({
  /** The instrument's own last traded price: spot for EQUITY/INDEX, the contract price for a FUTURE. */
  lastPrice: metricSchema(z.number().positive()),
  ema20: metricSchema(z.number().positive()),
  ema50: metricSchema(z.number().positive()),
  ema200: metricSchema(z.number().positive()),
  rsi14: metricSchema(Percent0To100),
  atr14: metricSchema(z.number().nonnegative()),
  /** Today's volume divided by the 20-day average volume (1.5 = 1.5x). */
  volumeRatio20d: metricSchema(z.number().nonnegative()),
  rsiDivergence: metricSchema(
    z.object({ kind: z.enum(RSI_DIVERGENCES), lookbackBars: z.number().int().min(2).max(250) }),
  ),
  /** Whether the latest close broke above the high of the preceding `rangeWeeks`-week consolidation range. */
  consolidationBreakout: metricSchema(
    z.object({ brokeOutUp: z.boolean(), rangeWeeks: z.number().int().min(2).max(52) }),
  ),
});

/**
 * The near-month futures contract: the stock's own futures for an EQUITY/INDEX with F&O, the contract itself for
 * a FUTURE. NOT_APPLICABLE means the instrument has no F&O contract.
 */
export const Derivatives = z.object({
  nearMonthExpiry: metricSchema(IsoDate),
  futuresPrice: metricSchema(z.number().positive()),
  /** Day-over-day change of the futures price and of open interest; the engine classifies the build-up type. */
  priceChangePct: metricSchema(z.number()),
  oiChangePct: metricSchema(z.number()),
  /** (futures price − spot) / spot × 100. */
  basisPct: metricSchema(z.number()),
  inFnoBan: metricSchema(z.boolean()),
});

const BlockDeal = z.object({
  date: IsoDate,
  kind: z.enum(['BULK', 'BLOCK']),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().int().positive(),
  price: z.number().positive(),
});

/** Third-party text: untrusted data. Length-capped here; prompt isolation is the explanation layer's job. */
const Announcement = z.object({
  publishedAt: IsoDateTime,
  headline: z.string().min(1).max(500),
});

const NetFlow = z.object({
  netInrCr: z.number(),
  lookbackDays: z.number().int().min(1).max(365),
});

/** "Macro trends" from the spec is not captured in v1: there is no structured source for it yet. */
export const Sentiment = z.object({
  bulkBlockDeals30d: metricSchema(z.array(BlockDeal).max(200)),
  fiiNetFlow: metricSchema(NetFlow),
  diiNetFlow: metricSchema(NetFlow),
  announcements: metricSchema(z.array(Announcement).max(50)),
});

const SECTIONS = ['fundamentals', 'technicals', 'derivatives', 'sentiment'] as const;

/** Bump when the snapshot shape changes; parsers of stored snapshots switch on it. */
export const RESEARCH_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Everything the decision engine and explanation layer may use for one instrument. Invariants:
 * - every metric's `sourceId` resolves to an entry in `sources`, and source ids are unique;
 * - no metric was observed after the snapshot's `asOf`;
 * - a FUTURE's derivatives metrics are never NOT_APPLICABLE.
 */
export const ResearchSnapshot = z
  .object({
    schemaVersion: z.literal(RESEARCH_SNAPSHOT_SCHEMA_VERSION),
    instrument: Instrument,
    /** ISO 4217, e.g. INR. Prices and ATR are in this currency. */
    currency: z.string().regex(/^[A-Z]{3}$/),
    asOf: IsoDateTime,
    fundamentals: Fundamentals,
    technicals: Technicals,
    derivatives: Derivatives,
    sentiment: Sentiment,
    sources: z.array(Source).max(500),
  })
  .superRefine((snapshot, ctx) => {
    const sourceIds = new Set<string>();
    snapshot.sources.forEach((source, index) => {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: `duplicate source id "${source.id}"` });
      }
      sourceIds.add(source.id);
    });

    for (const section of SECTIONS) {
      const metrics: Record<string, Metric<unknown>> = snapshot[section];
      for (const [field, metric] of Object.entries(metrics)) {
        const sourceId = 'sourceId' in metric ? metric.sourceId : undefined;
        if (sourceId !== undefined && !sourceIds.has(sourceId)) {
          ctx.addIssue({
            code: 'custom',
            path: [section, field, 'sourceId'],
            message: `source "${sourceId}" is not listed in sources`,
          });
        }
        // Fixed-precision UTC timestamps compare correctly as strings.
        if (metric.status === 'OK' && metric.observedAt > snapshot.asOf) {
          ctx.addIssue({
            code: 'custom',
            path: [section, field, 'observedAt'],
            message: 'observedAt is after the snapshot asOf',
          });
        }
        if (
          section === 'derivatives' &&
          snapshot.instrument.assetType === 'FUTURE' &&
          metric.status === 'NOT_APPLICABLE'
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [section, field, 'status'],
            message: 'derivatives metrics cannot be NOT_APPLICABLE for a FUTURE',
          });
        }
      }
    }
  });
export type ResearchSnapshot = z.infer<typeof ResearchSnapshot>;
