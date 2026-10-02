import { z } from 'zod';
import { IsoDateTime, isUnique, Score } from './common.ts';
import { DecisionIndicator, DecisionResult, decisionSourceIds, PolicyVersion } from './decision.ts';
import {
  ASSET_TYPES,
  Exchange,
  Instrument,
  InstrumentKey,
  instrumentKey,
  parseInstrumentKey,
  TradingSymbol,
} from './instrument.ts';
import { Source, SourceId } from './source.ts';

// Request/response contracts for /api/v1. Requests are validated by the API; responses are parsed by the web client.
// Every text field here is shown to users, so none may carry internal error detail.

const QueryText = z.string().trim().min(1).max(100);

/** GET /api/v1/stock/search?q= (autocomplete) */
export const SearchQuery = z.object({ q: QueryText });
export type SearchQuery = z.infer<typeof SearchQuery>;

/** Search/lookup candidate. `key` must agree with `exchange`, `symbol`, and `assetType`. */
export const InstrumentSummary = z
  .object({
    key: InstrumentKey,
    exchange: Exchange,
    symbol: TradingSymbol,
    assetType: z.enum(ASSET_TYPES),
    name: z.string().min(1).max(200),
  })
  .refine(
    (summary) => {
      const parsed = parseInstrumentKey(summary.key);
      return (
        parsed !== undefined &&
        parsed.exchange === summary.exchange &&
        parsed.symbol === summary.symbol &&
        (parsed.futureExpiry !== undefined) === (summary.assetType === 'FUTURE')
      );
    },
    { message: 'key must match exchange, symbol, and asset type', path: ['key'] },
  );
export type InstrumentSummary = z.infer<typeof InstrumentSummary>;

export const SearchResponse = z.object({ candidates: z.array(InstrumentSummary).max(20) });
export type SearchResponse = z.infer<typeof SearchResponse>;

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RESEARCH_DIMENSIONS = ['fundamentals', 'technicals', 'derivatives', 'sentiment'] as const;

export const Explanation = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('AVAILABLE'),
    summaryMarkdown: z.string().min(1).max(20_000),
    keyDrivers: z.array(z.string().min(1).max(500)).max(20),
    riskFactors: z.array(z.string().min(1).max(500)).max(20),
    /** Must resolve to the run's sources (checked on AnalysisRunView). */
    citations: z.array(SourceId).min(1).max(100),
  }),
  z.object({ status: z.literal('UNAVAILABLE') }),
]);
export type Explanation = z.infer<typeof Explanation>;

const runBase = {
  id: z.uuid(),
  instrumentKey: InstrumentKey,
  startedAt: IsoDateTime,
};

/** Client-safe failure summary: a stable code plus a user-facing message, never provider or stack detail. */
const RunError = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  message: z.string().min(1).max(500),
});

const completedRunFields = {
  completedAt: IsoDateTime,
  decision: DecisionResult,
  explanation: Explanation,
  sources: z.array(Source).max(500),
};

/**
 * GET /api/v1/analysis-runs/:id. The status decides which fields exist: finished runs always carry a decision
 * (PARTIAL = decision made with some research dimensions unavailable), failed runs always carry an error.
 * Cross-field invariants: completedAt ≥ startedAt; every citation and decision source id resolves to `sources`;
 * a FUTURE run has a derivatives subscore.
 */
export const AnalysisRunView = z
  .discriminatedUnion('status', [
    z.object({ ...runBase, status: z.literal('PENDING') }),
    z.object({ ...runBase, status: z.literal('RUNNING') }),
    z.object({ ...runBase, status: z.literal('SUCCEEDED'), ...completedRunFields }),
    z.object({
      ...runBase,
      status: z.literal('PARTIAL'),
      ...completedRunFields,
      unavailableDimensions: z.array(z.enum(RESEARCH_DIMENSIONS)).min(1).refine(isUnique, 'dimensions must be unique'),
    }),
    z.object({ ...runBase, status: z.literal('FAILED'), completedAt: IsoDateTime, error: RunError }),
  ])
  .superRefine((run, ctx) => {
    if ('completedAt' in run && run.completedAt < run.startedAt) {
      ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'completedAt is before startedAt' });
    }
    if (run.status !== 'SUCCEEDED' && run.status !== 'PARTIAL') return;

    const known = new Set(run.sources.map((source) => source.id));
    const cited = [
      ...decisionSourceIds(run.decision),
      ...(run.explanation.status === 'AVAILABLE' ? run.explanation.citations : []),
    ];
    for (const id of new Set(cited)) {
      if (!known.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['sources'], message: `cited source "${id}" is not listed in sources` });
      }
    }
    if (
      parseInstrumentKey(run.instrumentKey)?.futureExpiry !== undefined &&
      run.decision.subscores.derivatives === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', 'subscores', 'derivatives'],
        message: 'a FUTURE run must have a derivatives subscore',
      });
    }
  });
export type AnalysisRunView = z.infer<typeof AnalysisRunView>;

/**
 * INITIAL_RESEARCH for a stock's first run, RE_ANALYSIS afterwards. The spec's EARNINGS_UPDATE example has no
 * producer yet; add it when a scheduled earnings refresh exists.
 */
export const TimelineEntryView = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  eventType: z.enum(['INITIAL_RESEARCH', 'RE_ANALYSIS']),
  createdAt: IsoDateTime,
  indicator: DecisionIndicator,
  confidenceScore: Score,
  policyVersion: PolicyVersion,
});
export type TimelineEntryView = z.infer<typeof TimelineEntryView>;

/** POST /api/v1/stock/lookup: resolve free text and report any existing analysis (spec step 1). */
export const LookupRequest = z.object({ query: QueryText });
export type LookupRequest = z.infer<typeof LookupRequest>;

export const LookupResponse = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('NOT_FOUND') }),
    /** Candidates for the user to pick from; a single candidate means "did you mean …?" for partial input. */
    z.object({ status: z.literal('AMBIGUOUS'), candidates: z.array(InstrumentSummary).min(1).max(20) }),
    z.object({
      status: z.literal('RESOLVED'),
      instrument: Instrument,
      instrumentKey: InstrumentKey,
      /** null when the instrument has never been analysed. */
      existing: z
        .object({
          latestRun: AnalysisRunView,
          timeline: z.array(TimelineEntryView).max(500),
          ageSeconds: z.number().int().nonnegative(),
          /** Always true: the UI must ask "view existing or re-analyse?" whenever a record exists. */
          promptReanalysis: z.literal(true),
        })
        .nullable(),
    }),
  ])
  .superRefine((response, ctx) => {
    if (response.status !== 'RESOLVED') return;
    if (response.instrumentKey !== instrumentKey(response.instrument)) {
      ctx.addIssue({ code: 'custom', path: ['instrumentKey'], message: 'instrumentKey does not match instrument' });
    }
    if (response.existing && response.existing.latestRun.instrumentKey !== response.instrumentKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['existing', 'latestRun', 'instrumentKey'],
        message: 'latest run belongs to a different instrument',
      });
    }
  });
export type LookupResponse = z.infer<typeof LookupResponse>;

/** POST /api/v1/stock/analyze: 202 with AnalyzeAccepted, or 409 if a run is already in flight. */
export const AnalyzeRequest = z.object({
  instrumentKey: InstrumentKey,
  force: z.boolean().default(false),
});
/** Parsed request (force always present). */
export type AnalyzeRequest = z.infer<typeof AnalyzeRequest>;
/** What a client sends (force optional). */
export type AnalyzeRequestInput = z.input<typeof AnalyzeRequest>;

export const AnalyzeAccepted = z.object({ runId: z.uuid(), status: z.enum(['PENDING', 'RUNNING']) });
export type AnalyzeAccepted = z.infer<typeof AnalyzeAccepted>;

// ---------------------------------------------------------------------------------------------------------------
// Market data for the UI (movers, chart, live quote) and the analysed-stocks list. Prices are in the listing's
// trading currency; percentages are on a 0–100 scale (1.5 = 1.5%).
// ---------------------------------------------------------------------------------------------------------------

export const MARKET_STATES = ['PRE', 'REGULAR', 'POST', 'CLOSED'] as const;
export const MarketState = z.enum(MARKET_STATES);
export type MarketState = z.infer<typeof MarketState>;

export const Mover = z.object({
  instrumentKey: InstrumentKey,
  symbol: TradingSymbol,
  name: z.string().min(1).max(200),
  price: z.number().positive(),
  change: z.number(),
  changePct: z.number(),
});
export type Mover = z.infer<typeof Mover>;

/** GET /api/v1/market/movers: top gainers and losers of an index universe for the latest session. */
export const MarketMovers = z.object({
  /** Which constituents were ranked, e.g. "NIFTY 50"; "fallback" when the official list was unreachable. */
  universe: z.string().min(1).max(60),
  marketState: MarketState,
  /** Time of the most recent quote used (the latest session's last trade when the market is closed). */
  asOf: IsoDateTime,
  gainers: z.array(Mover).max(10),
  losers: z.array(Mover).max(10),
});
export type MarketMovers = z.infer<typeof MarketMovers>;

export const CHART_INTERVALS = ['5m', '1d'] as const;
export const ChartInterval = z.enum(CHART_INTERVALS);
export type ChartInterval = z.infer<typeof ChartInterval>;

export const PriceBar = z
  .object({
    time: IsoDateTime,
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
  })
  .refine((bar) => bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close), {
    message: 'low/high must bound open and close',
  });
export type PriceBar = z.infer<typeof PriceBar>;

/** GET /api/v1/market/chart/:key?interval= : OHLCV bars, oldest first. */
export const PriceChart = z.object({
  instrumentKey: InstrumentKey,
  currency: z.string().regex(/^[A-Z]{3}$/),
  interval: ChartInterval,
  bars: z.array(PriceBar).max(2_000),
});
export type PriceChart = z.infer<typeof PriceChart>;

/** GET /api/v1/market/quote/:key : the live ticker (vendor-delayed). */
export const LiveQuote = z.object({
  instrumentKey: InstrumentKey,
  currency: z.string().regex(/^[A-Z]{3}$/),
  price: z.number().positive(),
  change: z.number(),
  changePct: z.number(),
  previousClose: z.number().positive().optional(),
  marketState: MarketState,
  time: IsoDateTime,
});
export type LiveQuote = z.infer<typeof LiveQuote>;

export const AnalysedStock = z.object({
  instrumentKey: InstrumentKey,
  name: z.string().min(1).max(200),
  exchange: Exchange,
  lastAnalysedAt: IsoDateTime,
  indicator: DecisionIndicator,
  confidenceScore: Score,
});
export type AnalysedStock = z.infer<typeof AnalysedStock>;

/** GET /api/v1/stocks : analysed stocks, most recently analysed first. */
export const AnalysedStocks = z.object({ stocks: z.array(AnalysedStock).max(100) });
export type AnalysedStocks = z.infer<typeof AnalysedStocks>;
