import {
  AnalysisRunView,
  Instrument,
  instrumentKey,
  ResearchSnapshot,
  TimelineEntryView,
} from '@stock-analysis/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.ts';
import { Prisma, type AnalysisRun, type AnalysisTimeline, type Stock } from '../generated/prisma/client.ts';
import {
  assertDimensionsMatchStatus,
  buildCompletedView,
  buildFailedView,
  isUuid,
  RunInFlightError,
  RunStateError,
  timelineSnapshot,
  type AnalysisRepository,
  type CompletedRunInput,
  type RunFailure,
  type StockRecord,
} from './analysisRepository.ts';

const IN_FLIGHT_INDEX = 'AnalysisRun_one_in_flight_per_stock';
const IN_FLIGHT: ('PENDING' | 'RUNNING')[] = ['PENDING', 'RUNNING'];
const TimelineSnapshot = z.object({
  indicator: z.enum(['BUY', 'DONT_BUY', 'NEUTRAL']),
  confidenceScore: z.number(),
  policyVersion: z.string(),
});

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Postgres-backed repository. Every state change validates the complete resulting AnalysisRunView before writing,
 * inside a transaction that also reads the result, so a committed row is always readable and a caller never sees
 * another writer's state. JSON columns are validated with the shared Zod contracts on every read.
 */
export class PrismaAnalysisRepository implements AnalysisRepository {
  readonly #db: PrismaClient;
  readonly #now: () => Date;

  constructor(db: PrismaClient, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  async upsertStock(instrument: Instrument): Promise<StockRecord> {
    const parsed = Instrument.parse(instrument);
    const key = instrumentKey(parsed);
    const fields = {
      ticker: parsed.symbol,
      companyName: parsed.name,
      exchange: parsed.exchange,
      assetType: parsed.assetType,
      instrument: parsed,
    };
    const stock = await this.#db.stock.upsert({
      where: { instrumentKey: key },
      create: { instrumentKey: key, ...fields },
      update: fields,
    });
    return toStockRecord(stock);
  }

  async findStockByKey(key: string): Promise<StockRecord | null> {
    const stock = await this.#db.stock.findUnique({ where: { instrumentKey: key } });
    return stock ? toStockRecord(stock) : null;
  }

  async createRun(stockId: string): Promise<AnalysisRunView> {
    if (!isUuid(stockId)) throw new RunStateError(`Unknown stock ${stockId}`);
    // Two attempts: if the winning in-flight run finishes between our conflict and our re-read, try again.
    for (let attempt = 1; ; attempt++) {
      try {
        const run = await this.#db.analysisRun.create({
          data: { stockId, status: 'PENDING', startedAt: this.#now() },
          include: { stock: true },
        });
        return toRunView(run, run.stock);
      } catch (err) {
        if (isUniqueViolation(err, IN_FLIGHT_INDEX)) {
          const inFlight = await this.findInFlightRun(stockId);
          if (inFlight) throw new RunInFlightError(inFlight.id);
          if (attempt < 2) continue;
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
          throw new RunStateError(`Unknown stock ${stockId}`);
        }
        throw err;
      }
    }
  }

  async markRunning(runId: string): Promise<AnalysisRunView> {
    if (!isUuid(runId)) throw new RunStateError(`Unknown run ${runId}`);
    return this.#db.$transaction(async (tx) => {
      const updated = await tx.analysisRun.updateMany({
        where: { id: runId, status: 'PENDING' },
        data: { status: 'RUNNING' },
      });
      if (updated.count === 0) throw await stateError(tx, runId);
      return requireRun(tx, runId);
    });
  }

  async completeRun(runId: string, input: CompletedRunInput): Promise<AnalysisRunView> {
    assertDimensionsMatchStatus(input);
    if (!isUuid(runId)) throw new RunStateError(`Unknown run ${runId}`);
    const snapshot = ResearchSnapshot.parse(input.snapshot);
    const completedAt = this.#now();

    return this.#db.$transaction(async (tx) => {
      const run = await tx.analysisRun.findUnique({ where: { id: runId }, include: { stock: true } });
      if (!run || !IN_FLIGHT.includes(run.status as 'PENDING' | 'RUNNING')) throw await stateError(tx, runId);
      // Validate the full view (cross-field rules included) before any write, so nothing unreadable is committed.
      const view = buildCompletedView(
        { id: run.id, instrumentKey: run.stock.instrumentKey, startedAt: run.startedAt.toISOString() },
        completedAt.toISOString(),
        input,
      );
      if (view.status !== 'SUCCEEDED' && view.status !== 'PARTIAL') throw new RunStateError('unexpected view status');

      const updated = await tx.analysisRun.updateMany({
        where: { id: runId, status: { in: IN_FLIGHT } },
        data: {
          status: view.status,
          completedAt,
          policyVersion: view.decision.policyVersion,
          decisionIndicator: view.decision.indicator,
          confidenceScore: view.decision.confidenceScore,
          fundamentalScore: view.decision.subscores.fundamental,
          technicalScore: view.decision.subscores.technical,
          derivativesScore: view.decision.subscores.derivatives,
          sentimentScore: view.decision.subscores.sentiment,
          decision: view.decision,
          explanation: view.explanation,
          researchSnapshot: snapshot,
          sources: view.sources,
          unavailableDimensions: input.unavailableDimensions,
        },
      });
      if (updated.count === 0) throw await stateError(tx, runId);

      const priorEntries = await tx.analysisTimeline.count({ where: { stockId: run.stockId } });
      await tx.analysisTimeline.create({
        data: {
          stockId: run.stockId,
          analysisRunId: runId,
          eventType: priorEntries === 0 ? 'INITIAL_RESEARCH' : 'RE_ANALYSIS',
          snapshotData: timelineSnapshot(view.decision),
          createdAt: completedAt,
        },
      });
      await tx.stock.update({ where: { id: run.stockId }, data: { lastAnalysedAt: completedAt } });
      return requireRun(tx, runId);
    });
  }

  async failRun(runId: string, failure: RunFailure): Promise<AnalysisRunView> {
    if (!isUuid(runId)) throw new RunStateError(`Unknown run ${runId}`);
    const completedAt = this.#now();
    return this.#db.$transaction(async (tx) => {
      const run = await tx.analysisRun.findUnique({ where: { id: runId }, include: { stock: true } });
      if (!run || !IN_FLIGHT.includes(run.status as 'PENDING' | 'RUNNING')) throw await stateError(tx, runId);
      buildFailedView(
        { id: run.id, instrumentKey: run.stock.instrumentKey, startedAt: run.startedAt.toISOString() },
        completedAt.toISOString(),
        failure,
      );
      const updated = await tx.analysisRun.updateMany({
        where: { id: runId, status: { in: IN_FLIGHT } },
        data: { status: 'FAILED', completedAt, error: { code: failure.code, message: failure.message } },
      });
      if (updated.count === 0) throw await stateError(tx, runId);
      return requireRun(tx, runId);
    });
  }

  async getRun(runId: string): Promise<AnalysisRunView | null> {
    if (!isUuid(runId)) return null;
    return findRun(this.#db, runId);
  }

  async findInFlightRun(stockId: string): Promise<AnalysisRunView | null> {
    if (!isUuid(stockId)) return null;
    const run = await this.#db.analysisRun.findFirst({
      where: { stockId, status: { in: IN_FLIGHT } },
      include: { stock: true },
    });
    return run ? toRunView(run, run.stock) : null;
  }

  async getLatestCompletedRun(stockId: string): Promise<AnalysisRunView | null> {
    if (!isUuid(stockId)) return null;
    const run = await this.#db.analysisRun.findFirst({
      where: { stockId, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      include: { stock: true },
    });
    return run ? toRunView(run, run.stock) : null;
  }

  async getTimeline(stockId: string): Promise<TimelineEntryView[]> {
    if (!isUuid(stockId)) return [];
    const entries = await this.#db.analysisTimeline.findMany({
      where: { stockId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return entries.map(toTimelineEntry);
  }
}

async function findRun(db: Db, runId: string): Promise<AnalysisRunView | null> {
  const run = await db.analysisRun.findUnique({ where: { id: runId }, include: { stock: true } });
  return run ? toRunView(run, run.stock) : null;
}

async function requireRun(db: Db, runId: string): Promise<AnalysisRunView> {
  const run = await findRun(db, runId);
  if (!run) throw new RunStateError(`Unknown run ${runId}`);
  return run;
}

async function stateError(db: Db, runId: string): Promise<RunStateError> {
  const run = await db.analysisRun.findUnique({ where: { id: runId }, select: { status: true } });
  return new RunStateError(run ? `Run ${runId} is ${run.status}` : `Unknown run ${runId}`);
}

function toStockRecord(stock: Stock): StockRecord {
  return {
    id: stock.id,
    instrumentKey: stock.instrumentKey,
    instrument: Instrument.parse(stock.instrument),
    lastAnalysedAt: stock.lastAnalysedAt?.toISOString() ?? null,
  };
}

function toRunView(run: AnalysisRun, stock: Stock): AnalysisRunView {
  const base = { id: run.id, instrumentKey: stock.instrumentKey, startedAt: run.startedAt.toISOString() };
  const completedAt = run.completedAt?.toISOString();
  switch (run.status) {
    case 'PENDING':
    case 'RUNNING':
      return AnalysisRunView.parse({ ...base, status: run.status });
    case 'FAILED':
      return AnalysisRunView.parse({ ...base, status: 'FAILED', completedAt, error: run.error });
    case 'SUCCEEDED':
    case 'PARTIAL':
      return AnalysisRunView.parse({
        ...base,
        status: run.status,
        completedAt,
        decision: run.decision,
        explanation: run.explanation,
        sources: run.sources,
        ...(run.status === 'PARTIAL' ? { unavailableDimensions: run.unavailableDimensions } : {}),
      });
  }
}

function toTimelineEntry(entry: AnalysisTimeline): TimelineEntryView {
  const snapshot = TimelineSnapshot.parse(entry.snapshotData);
  return TimelineEntryView.parse({
    id: entry.id,
    runId: entry.analysisRunId,
    eventType: entry.eventType,
    createdAt: entry.createdAt.toISOString(),
    ...snapshot,
  });
}

/**
 * Unique-constraint violation on a specific index. With @prisma/adapter-pg, Prisma reports P2002 and names the
 * index in the error meta (driverAdapterError.cause.constraint.index) and message.
 */
function isUniqueViolation(err: unknown, index: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta ?? {}).includes(index) || err.message.includes(index);
}
