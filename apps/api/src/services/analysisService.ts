import {
  instrumentKey,
  type AnalysisRunView,
  type AnalyzeAccepted,
  type Instrument,
  type InstrumentSummary,
  type LookupResponse,
} from '@stock-analysis/shared';
import type { Logger } from 'pino';
import { evaluate } from '../domain/decision/evaluate.ts';
import type { DecisionPolicy } from '../domain/decision/policy.ts';
import type { InstrumentDirectory } from '../domain/instruments/instrumentDirectory.ts';
import { AppError } from '../http/errors.ts';
import { RunInFlightError, TIMELINE_LIMIT, type AnalysisRepository } from '../repositories/analysisRepository.ts';
import { aggregateResearch, type AggregatorOptions } from '../research/researchAggregator.ts';
import type { ResearchProvider } from '../research/researchProvider.ts';

export interface AnalysisServiceDeps {
  repository: AnalysisRepository;
  directory: InstrumentDirectory;
  provider: ResearchProvider;
  policy: DecisionPolicy;
  now: () => Date;
  logger: Logger;
  aggregatorOptions?: AggregatorOptions;
  /** An in-flight run older than this can't be live (analyses take seconds) and is closed as stalled. */
  staleRunAfterMs?: number;
}

const DEFAULT_STALE_RUN_AFTER_MS = 10 * 60_000;

/** Client-safe failure summaries stored on FAILED runs; internal detail goes to the log only. */
const FAILURES = {
  analysisFailed: { code: 'ANALYSIS_FAILED', message: 'The analysis could not be completed. Please try again.' },
  cancelled: { code: 'ANALYSIS_CANCELLED', message: 'The analysis was cancelled because the server stopped.' },
  interrupted: { code: 'INTERRUPTED', message: 'The analysis was interrupted by a server restart. Please try again.' },
  stalled: { code: 'STALLED', message: 'The analysis stopped responding. Please try again.' },
} as const;

export function toSummary(instrument: Instrument): InstrumentSummary {
  return {
    key: instrumentKey(instrument),
    exchange: instrument.exchange,
    symbol: instrument.symbol,
    assetType: instrument.assetType,
    name: instrument.name,
  };
}

/**
 * Search, lookup (spec step 1), and background analysis (steps 2–4). Analyses run in-process: `analyze` returns
 * as soon as the run is recorded, and the run is executed asynchronously. `shutdown` refuses new analyses, then
 * cancels and awaits in-flight work; `recoverInterruptedRuns` must run at startup, before accepting requests.
 *
 * Deployment constraint: exactly ONE API process per database. Startup recovery fails every in-flight run, which
 * is only correct when no other process could own one. Running replicas needs run ownership (instance id + lease)
 * first; see implementation-plan.md Phase 14.
 *
 * Known race (accepted for the MVP): two simultaneous non-forced analyze calls for a never-analysed instrument can
 * both pass the ANALYSIS_EXISTS check if the first run completes between the second call's check and its create;
 * the result is one extra RE_ANALYSIS entry, never a lost or corrupted run.
 */
export class AnalysisService {
  readonly #deps: AnalysisServiceDeps;
  readonly #jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #closed = false;

  constructor(deps: AnalysisServiceDeps) {
    this.#deps = deps;
  }

  async search(query: string): Promise<InstrumentSummary[]> {
    return (await this.#deps.directory.search(query)).map(toSummary);
  }

  async lookup(query: string): Promise<LookupResponse> {
    const resolution = await this.#deps.directory.resolve(query);
    if (resolution.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    if (resolution.status === 'AMBIGUOUS') {
      return { status: 'AMBIGUOUS', candidates: resolution.candidates.map(toSummary) };
    }

    const instrument = resolution.instrument;
    const key = instrumentKey(instrument);
    const stock = await this.#deps.repository.findStockByKey(key);
    const latestRun = stock ? await this.#deps.repository.getLatestCompletedRun(stock.id) : null;
    if (!stock || !latestRun || !('completedAt' in latestRun)) {
      return { status: 'RESOLVED', instrument, instrumentKey: key, existing: null };
    }
    const timeline = await this.#deps.repository.getTimeline(stock.id, TIMELINE_LIMIT);
    // Age of the analysis being shown, from the run itself (one source of truth).
    const ageSeconds = Math.max(0, Math.floor((this.#deps.now().getTime() - Date.parse(latestRun.completedAt)) / 1000));
    return {
      status: 'RESOLVED',
      instrument,
      instrumentKey: key,
      existing: { latestRun, timeline, ageSeconds, promptReanalysis: true },
    };
  }

  /**
   * Starts an analysis. Without `force`, an instrument that already has a completed analysis is rejected with 409
   * ANALYSIS_EXISTS so the UI asks the user first; an in-flight run always yields 409 RUN_IN_FLIGHT.
   */
  async analyze(key: string, force: boolean): Promise<AnalyzeAccepted> {
    if (this.#closed) throw new AppError(503, 'The server is shutting down. Please try again shortly.');
    const instrument = await this.#deps.directory.byKey(key);
    if (!instrument) throw new AppError(404, `Unknown or expired instrument ${key}.`);

    const stock = await this.#deps.repository.upsertStock(instrument);
    const inFlight = await this.#deps.repository.findInFlightRun(stock.id);
    if (inFlight && !(await this.#closeIfStalled(inFlight))) throw runInFlight(inFlight.id);
    if (!force) {
      const existing = await this.#deps.repository.getLatestCompletedRun(stock.id);
      if (existing) {
        throw new AppError(409, 'An analysis already exists for this instrument. Re-analyse to replace it.', {
          extensions: { code: 'ANALYSIS_EXISTS', runId: existing.id },
        });
      }
    }

    let run: AnalysisRunView;
    try {
      run = await this.#deps.repository.createRun(stock.id);
    } catch (err) {
      if (err instanceof RunInFlightError) throw runInFlight(err.runId);
      throw err;
    }
    this.#start(run.id, instrument);
    return { runId: run.id, status: 'PENDING' };
  }

  async getRun(runId: string): Promise<AnalysisRunView | null> {
    const run = await this.#deps.repository.getRun(runId);
    if (run && (run.status === 'PENDING' || run.status === 'RUNNING') && (await this.#closeIfStalled(run))) {
      return this.#deps.repository.getRun(runId);
    }
    return run;
  }

  /**
   * Closes an in-flight run this process isn't executing and that is too old to be live (e.g. its failure could not
   * be recorded during a database outage). Returns true if the run is no longer in flight.
   */
  async #closeIfStalled(run: AnalysisRunView): Promise<boolean> {
    if (this.#jobs.has(run.id)) return false;
    const ageMs = this.#deps.now().getTime() - Date.parse(run.startedAt);
    if (ageMs < (this.#deps.staleRunAfterMs ?? DEFAULT_STALE_RUN_AFTER_MS)) return false;
    try {
      await this.#deps.repository.failRun(run.id, FAILURES.stalled);
      this.#deps.logger.warn({ runId: run.id }, 'closed a stalled analysis run');
    } catch {
      // Another request closed it first, or storage is still unavailable; the re-read below decides.
    }
    const current = await this.#deps.repository.getRun(run.id);
    return current !== null && current.status !== 'PENDING' && current.status !== 'RUNNING';
  }

  async recoverInterruptedRuns(): Promise<number> {
    const count = await this.#deps.repository.failInFlightRuns(FAILURES.interrupted);
    if (count > 0) this.#deps.logger.warn({ count }, 'failed runs interrupted by a previous shutdown');
    return count;
  }

  /** Resolves when no analysis is executing (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.#jobs.size > 0) await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }

  /** Cancels in-flight analyses and waits for them to record their outcome. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort(new Error('server shutting down'));
    await this.idle();
  }

  #start(runId: string, instrument: Instrument): void {
    const controller = new AbortController();
    const done = this.#execute(runId, instrument, controller.signal).finally(() => this.#jobs.delete(runId));
    this.#jobs.set(runId, { controller, done });
  }

  async #execute(runId: string, instrument: Instrument, signal: AbortSignal): Promise<void> {
    const { repository, provider, policy, now, logger } = this.#deps;
    const log = logger.child({ runId, instrumentKey: instrumentKey(instrument) });
    let stage: 'start' | 'research' | 'persist' = 'start';
    try {
      await repository.markRunning(runId);
      stage = 'research';
      const asOf = now();
      const research = await aggregateResearch(provider, instrument, asOf, signal, this.#deps.aggregatorOptions);
      stage = 'persist';
      const decision = evaluate(research.snapshot, policy, now());
      await repository.completeRun(runId, {
        status: research.unavailableDimensions.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
        decision,
        // LLM explanations arrive in Phase 11; until then the decision is shown with its sourced factors only.
        explanation: { status: 'UNAVAILABLE' },
        snapshot: research.snapshot,
        sources: research.snapshot.sources,
        unavailableDimensions: research.unavailableDimensions,
      });
      log.info({ indicator: decision.indicator, partial: research.unavailableDimensions }, 'analysis completed');
    } catch (err) {
      // Only an abort during research is a cancellation; a persistence error after abort is still a failure.
      const failure = signal.aborted && stage === 'research' ? FAILURES.cancelled : FAILURES.analysisFailed;
      log.error({ err }, 'analysis failed');
      await repository.failRun(runId, failure).catch((failErr: unknown) => {
        log.error({ err: failErr }, 'could not record the analysis failure');
      });
    }
  }
}

function runInFlight(runId: string): AppError {
  return new AppError(409, 'An analysis is already running for this instrument.', {
    extensions: { code: 'RUN_IN_FLIGHT', runId },
  });
}
