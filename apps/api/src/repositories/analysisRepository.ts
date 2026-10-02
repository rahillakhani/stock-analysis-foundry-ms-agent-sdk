import {
  AnalysisRunView,
  type AnalysedStock,
  type DecisionResult,
  type Explanation,
  type Instrument,
  type ResearchSnapshot,
  type Source,
  type TimelineEntryView,
} from '@stock-analysis/shared';
import { z } from 'zod';

export interface StockRecord {
  id: string;
  instrumentKey: string;
  instrument: Instrument;
  /** ISO timestamp of the latest completed run, or null if never analysed. */
  lastAnalysedAt: string | null;
}

/** Matches the LookupResponse contract cap: older entries are omitted from the view, never from storage. */
export const TIMELINE_LIMIT = 500;

export function clampTimelineLimit(limit: number | undefined): number {
  return Math.min(TIMELINE_LIMIT, Math.max(1, Math.trunc(limit ?? TIMELINE_LIMIT)));
}

/** Matches the AnalysedStocks contract cap. */
export const ANALYSED_STOCKS_LIMIT = 100;

export function clampStocksLimit(limit: number | undefined): number {
  return Math.min(ANALYSED_STOCKS_LIMIT, Math.max(1, Math.trunc(limit ?? ANALYSED_STOCKS_LIMIT)));
}

export type ResearchDimension = 'fundamentals' | 'technicals' | 'derivatives' | 'sentiment';

/** Everything persisted when a run finishes with a decision. */
export interface CompletedRunInput {
  status: 'SUCCEEDED' | 'PARTIAL';
  decision: DecisionResult;
  explanation: Explanation;
  snapshot: ResearchSnapshot;
  sources: Source[];
  /** Must be non-empty for PARTIAL and empty for SUCCEEDED. */
  unavailableDimensions: ResearchDimension[];
}

/** Client-safe failure summary; never provider or stack detail. */
export interface RunFailure {
  code: string;
  message: string;
}

/** A second analysis was requested while one is PENDING/RUNNING for the same stock. */
export class RunInFlightError extends Error {
  override readonly name = 'RunInFlightError';
  readonly runId: string;

  constructor(runId: string) {
    super(`An analysis run is already in flight: ${runId}`);
    this.runId = runId;
  }
}

/** The run doesn't exist or is not in a state that allows the requested transition. */
export class RunStateError extends Error {
  override readonly name = 'RunStateError';
}

/**
 * Persistence port for stocks, runs, and the timeline. Implemented by Prisma (Postgres) and an in-memory store;
 * both must pass the shared contract suite in analysisRepository.contract.ts.
 *
 * Run lifecycle: createRun -> PENDING -> markRunning -> RUNNING -> completeRun (SUCCEEDED/PARTIAL) or failRun
 * (FAILED). Completing a run appends one timeline entry and updates the stock's lastAnalysedAt atomically.
 */
export interface AnalysisRepository {
  /** Creates the stock on first sight, or refreshes its stored instrument; keyed by instrument key. */
  upsertStock(instrument: Instrument): Promise<StockRecord>;
  findStockByKey(instrumentKey: string): Promise<StockRecord | null>;
  /** Throws RunInFlightError if the stock already has a PENDING/RUNNING run. */
  createRun(stockId: string): Promise<AnalysisRunView>;
  markRunning(runId: string): Promise<AnalysisRunView>;
  completeRun(runId: string, input: CompletedRunInput): Promise<AnalysisRunView>;
  failRun(runId: string, failure: RunFailure): Promise<AnalysisRunView>;
  getRun(runId: string): Promise<AnalysisRunView | null>;
  findInFlightRun(stockId: string): Promise<AnalysisRunView | null>;
  /** Latest SUCCEEDED/PARTIAL run: the "existing analysis" shown on lookup. */
  getLatestCompletedRun(stockId: string): Promise<AnalysisRunView | null>;
  /** The latest `limit` entries (default and maximum: TIMELINE_LIMIT), returned oldest first. */
  getTimeline(stockId: string, limit?: number): Promise<TimelineEntryView[]>;
  /**
   * Stocks with at least one completed run, most recently analysed first (ties by instrument key), each with its
   * latest completed decision. At most `limit` (default and maximum: ANALYSED_STOCKS_LIMIT).
   */
  listAnalysedStocks(limit?: number): Promise<AnalysedStock[]>;
  /**
   * Marks every PENDING/RUNNING run FAILED. Called at startup: runs in flight when the process stopped can never
   * finish, and would otherwise block their stock (one in-flight run per stock). Returns the number failed.
   */
  failInFlightRuns(failure: RunFailure): Promise<number>;
}

/** The compact data stored in a timeline entry. */
export function timelineSnapshot(decision: DecisionResult) {
  return {
    indicator: decision.indicator,
    confidenceScore: decision.confidenceScore,
    policyVersion: decision.policyVersion,
  };
}

export function assertDimensionsMatchStatus(input: CompletedRunInput): void {
  const partial = input.status === 'PARTIAL';
  if (partial !== input.unavailableDimensions.length > 0) {
    throw new RunStateError(
      partial ? 'PARTIAL runs must name unavailable dimensions' : 'SUCCEEDED runs cannot have unavailable dimensions',
    );
  }
}

const Uuid = z.uuid();

/** Ids are UUIDs; anything else can't exist, so lookups return null and transitions throw RunStateError. */
export function isUuid(value: string): boolean {
  return Uuid.safeParse(value).success;
}

interface RunIdentity {
  id: string;
  instrumentKey: string;
  startedAt: string;
}

/**
 * The complete view a finished run will have, validated (including cross-field rules such as citations resolving
 * to sources) before anything is written. Throws ZodError for invalid input.
 */
export function buildCompletedView(run: RunIdentity, completedAt: string, input: CompletedRunInput): AnalysisRunView {
  return AnalysisRunView.parse({
    ...run,
    status: input.status,
    completedAt,
    decision: input.decision,
    explanation: input.explanation,
    sources: input.sources,
    ...(input.status === 'PARTIAL' ? { unavailableDimensions: input.unavailableDimensions } : {}),
  });
}

export function buildFailedView(run: RunIdentity, completedAt: string, failure: RunFailure): AnalysisRunView {
  return AnalysisRunView.parse({ ...run, status: 'FAILED', completedAt, error: failure });
}
