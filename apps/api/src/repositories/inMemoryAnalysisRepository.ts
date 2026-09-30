import { randomUUID } from 'node:crypto';
import {
  AnalysisRunView,
  Instrument,
  instrumentKey,
  ResearchSnapshot,
  TimelineEntryView,
  type TimelineEntryView as TimelineEntry,
} from '@stock-analysis/shared';
import {
  assertDimensionsMatchStatus,
  buildCompletedView,
  buildFailedView,
  RunInFlightError,
  RunStateError,
  timelineSnapshot,
  type AnalysisRepository,
  type CompletedRunInput,
  type RunFailure,
  type StockRecord,
} from './analysisRepository.ts';

interface StoredRun {
  view: AnalysisRunView;
  stockId: string;
}

/**
 * In-process repository for unit/API tests and DB-less local runs. Enforces the same invariants as the Postgres
 * schema (one in-flight run per stock, legal status transitions, one timeline entry per completed run). Data is
 * lost on restart. Values are deep-copied in and out so callers can't mutate stored state.
 */
export class InMemoryAnalysisRepository implements AnalysisRepository {
  readonly #now: () => Date;
  readonly #stocks = new Map<string, StockRecord>();
  readonly #runs = new Map<string, StoredRun>();
  readonly #timeline: { stockId: string; entry: TimelineEntry }[] = [];

  constructor(now: () => Date) {
    this.#now = now;
  }

  upsertStock(input: Instrument): Promise<StockRecord> {
    const parsed = Instrument.safeParse(input);
    if (!parsed.success) return Promise.reject(parsed.error);
    const instrument = parsed.data;
    const key = instrumentKey(instrument);
    const existing = [...this.#stocks.values()].find((s) => s.instrumentKey === key);
    const record: StockRecord = existing
      ? { ...existing, instrument: structuredClone(instrument) }
      : { id: randomUUID(), instrumentKey: key, instrument: structuredClone(instrument), lastAnalysedAt: null };
    this.#stocks.set(record.id, record);
    return Promise.resolve(structuredClone(record));
  }

  findStockByKey(key: string): Promise<StockRecord | null> {
    const found = [...this.#stocks.values()].find((s) => s.instrumentKey === key);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  createRun(stockId: string): Promise<AnalysisRunView> {
    const stock = this.#stocks.get(stockId);
    if (!stock) return Promise.reject(new RunStateError(`Unknown stock ${stockId}`));
    const inFlight = this.#inFlight(stockId);
    if (inFlight) return Promise.reject(new RunInFlightError(inFlight.view.id));

    const view = AnalysisRunView.parse({
      id: randomUUID(),
      instrumentKey: stock.instrumentKey,
      startedAt: this.#now().toISOString(),
      status: 'PENDING',
    });
    this.#runs.set(view.id, { view, stockId });
    return Promise.resolve(structuredClone(view));
  }

  markRunning(runId: string): Promise<AnalysisRunView> {
    return this.#transition(runId, ['PENDING'], (view) => ({ ...view, status: 'RUNNING' }));
  }

  completeRun(runId: string, input: CompletedRunInput): Promise<AnalysisRunView> {
    try {
      assertDimensionsMatchStatus(input);
      ResearchSnapshot.parse(input.snapshot);
    } catch (err) {
      return rejectWith(err);
    }
    const completedAt = this.#now().toISOString();
    return this.#transition(runId, ['PENDING', 'RUNNING'], (view, stored) => {
      const hasHistory = this.#timeline.some((t) => t.stockId === stored.stockId);
      const completed = buildCompletedView(view, completedAt, input);
      const entry = TimelineEntryView.parse({
        id: randomUUID(),
        runId: view.id,
        eventType: hasHistory ? 'RE_ANALYSIS' : 'INITIAL_RESEARCH',
        createdAt: completedAt,
        ...timelineSnapshot(input.decision),
      });
      // Commit all three writes together (the validation above can throw before anything changes).
      this.#timeline.push({ stockId: stored.stockId, entry });
      const stock = this.#stocks.get(stored.stockId);
      if (stock) this.#stocks.set(stock.id, { ...stock, lastAnalysedAt: completedAt });
      return completed;
    });
  }

  failRun(runId: string, failure: RunFailure): Promise<AnalysisRunView> {
    const completedAt = this.#now().toISOString();
    return this.#transition(runId, ['PENDING', 'RUNNING'], (view) => buildFailedView(view, completedAt, failure));
  }

  getRun(runId: string): Promise<AnalysisRunView | null> {
    const stored = this.#runs.get(runId);
    return Promise.resolve(stored ? structuredClone(stored.view) : null);
  }

  findInFlightRun(stockId: string): Promise<AnalysisRunView | null> {
    const stored = this.#inFlight(stockId);
    return Promise.resolve(stored ? structuredClone(stored.view) : null);
  }

  getLatestCompletedRun(stockId: string): Promise<AnalysisRunView | null> {
    const completed = [...this.#runs.values()]
      .filter((r) => r.stockId === stockId && (r.view.status === 'SUCCEEDED' || r.view.status === 'PARTIAL'))
      .map((r) => r.view)
      .sort((a, b) => completedAtOf(b).localeCompare(completedAtOf(a)) || b.id.localeCompare(a.id));
    return Promise.resolve(completed[0] ? structuredClone(completed[0]) : null);
  }

  getTimeline(stockId: string): Promise<TimelineEntry[]> {
    return Promise.resolve(
      this.#timeline
        .filter((t) => t.stockId === stockId)
        .map((t) => structuredClone(t.entry))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    );
  }

  failInFlightRuns(failure: RunFailure): Promise<number> {
    const completedAt = this.#now().toISOString();
    let count = 0;
    for (const [id, stored] of this.#runs) {
      if (stored.view.status !== 'PENDING' && stored.view.status !== 'RUNNING') continue;
      this.#runs.set(id, { ...stored, view: buildFailedView(stored.view, completedAt, failure) });
      count++;
    }
    return Promise.resolve(count);
  }

  #inFlight(stockId: string): StoredRun | undefined {
    return [...this.#runs.values()].find(
      (r) => r.stockId === stockId && (r.view.status === 'PENDING' || r.view.status === 'RUNNING'),
    );
  }

  #transition(
    runId: string,
    from: readonly AnalysisRunView['status'][],
    apply: (view: AnalysisRunView, stored: StoredRun) => AnalysisRunView,
  ): Promise<AnalysisRunView> {
    const stored = this.#runs.get(runId);
    if (!stored) return Promise.reject(new RunStateError(`Unknown run ${runId}`));
    if (!from.includes(stored.view.status)) {
      return Promise.reject(new RunStateError(`Run ${runId} is ${stored.view.status}`));
    }
    try {
      const next = apply(structuredClone(stored.view), stored);
      this.#runs.set(runId, { ...stored, view: next });
      return Promise.resolve(structuredClone(next));
    } catch (err) {
      return rejectWith(err);
    }
  }
}

/** Rejects with an Error, wrapping anything else that was thrown. */
function rejectWith(err: unknown): Promise<never> {
  return Promise.reject(err instanceof Error ? err : new Error(String(err)));
}

function completedAtOf(view: AnalysisRunView): string {
  return 'completedAt' in view ? view.completedAt : '';
}
