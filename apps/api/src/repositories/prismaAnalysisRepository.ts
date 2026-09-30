import {
  AnalysisRunView,
  DecisionResult,
  Explanation,
  Instrument,
  instrumentKey,
  Source,
  TimelineEntryView,
} from '@stock-analysis/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.ts';
import { Prisma, type AnalysisRun, type AnalysisTimeline, type Stock } from '../generated/prisma/client.ts';
import {
  assertDimensionsMatchStatus,
  RunInFlightError,
  RunStateError,
  timelineSnapshot,
  type AnalysisRepository,
  type CompletedRunInput,
  type RunFailure,
  type StockRecord,
} from './analysisRepository.ts';

const IN_FLIGHT_INDEX = 'AnalysisRun_one_in_flight_per_stock';
const TimelineSnapshot = z.object({
  indicator: z.enum(['BUY', 'DONT_BUY', 'NEUTRAL']),
  confidenceScore: z.number(),
  policyVersion: z.string(),
});

/** Postgres-backed repository. JSON columns are validated with the shared Zod contracts on every read. */
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
    try {
      const run = await this.#db.analysisRun.create({
        data: { stockId, status: 'PENDING', startedAt: this.#now() },
        include: { stock: true },
      });
      return toRunView(run, run.stock);
    } catch (err) {
      if (isUniqueViolation(err, IN_FLIGHT_INDEX)) {
        const inFlight = await this.findInFlightRun(stockId);
        throw new RunInFlightError(inFlight?.id ?? 'unknown');
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new RunStateError(`Unknown stock ${stockId}`);
      }
      throw err;
    }
  }

  async markRunning(runId: string): Promise<AnalysisRunView> {
    const updated = await this.#db.analysisRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'RUNNING' },
    });
    if (updated.count === 0) throw await this.#stateError(runId);
    return this.#requireRun(runId);
  }

  async completeRun(runId: string, input: CompletedRunInput): Promise<AnalysisRunView> {
    assertDimensionsMatchStatus(input);
    const decision = DecisionResult.parse(input.decision);
    const explanation = Explanation.parse(input.explanation);
    const sources = z.array(Source).parse(input.sources);
    const completedAt = this.#now();

    await this.#db.$transaction(async (tx) => {
      const updated = await tx.analysisRun.updateMany({
        where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: input.status,
          completedAt,
          policyVersion: decision.policyVersion,
          decisionIndicator: decision.indicator,
          confidenceScore: decision.confidenceScore,
          fundamentalScore: decision.subscores.fundamental,
          technicalScore: decision.subscores.technical,
          derivativesScore: decision.subscores.derivatives,
          sentimentScore: decision.subscores.sentiment,
          decision,
          explanation,
          researchSnapshot: input.snapshot,
          sources,
          unavailableDimensions: input.unavailableDimensions,
        },
      });
      if (updated.count === 0) throw await this.#stateError(runId);

      const run = await tx.analysisRun.findUniqueOrThrow({ where: { id: runId }, select: { stockId: true } });
      const priorEntries = await tx.analysisTimeline.count({ where: { stockId: run.stockId } });
      await tx.analysisTimeline.create({
        data: {
          stockId: run.stockId,
          analysisRunId: runId,
          eventType: priorEntries === 0 ? 'INITIAL_RESEARCH' : 'RE_ANALYSIS',
          snapshotData: timelineSnapshot(decision),
          createdAt: completedAt,
        },
      });
      await tx.stock.update({ where: { id: run.stockId }, data: { lastAnalysedAt: completedAt } });
    });
    return this.#requireRun(runId);
  }

  async failRun(runId: string, failure: RunFailure): Promise<AnalysisRunView> {
    const updated = await this.#db.analysisRun.updateMany({
      where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'FAILED', completedAt: this.#now(), error: { code: failure.code, message: failure.message } },
    });
    if (updated.count === 0) throw await this.#stateError(runId);
    return this.#requireRun(runId);
  }

  async getRun(runId: string): Promise<AnalysisRunView | null> {
    const run = await this.#db.analysisRun.findUnique({ where: { id: runId }, include: { stock: true } });
    return run ? toRunView(run, run.stock) : null;
  }

  async findInFlightRun(stockId: string): Promise<AnalysisRunView | null> {
    const run = await this.#db.analysisRun.findFirst({
      where: { stockId, status: { in: ['PENDING', 'RUNNING'] } },
      include: { stock: true },
    });
    return run ? toRunView(run, run.stock) : null;
  }

  async getLatestCompletedRun(stockId: string): Promise<AnalysisRunView | null> {
    const run = await this.#db.analysisRun.findFirst({
      where: { stockId, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      include: { stock: true },
    });
    return run ? toRunView(run, run.stock) : null;
  }

  async getTimeline(stockId: string): Promise<TimelineEntryView[]> {
    const entries = await this.#db.analysisTimeline.findMany({
      where: { stockId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return entries.map(toTimelineEntry);
  }

  async #requireRun(runId: string): Promise<AnalysisRunView> {
    const run = await this.getRun(runId);
    if (!run) throw new RunStateError(`Unknown run ${runId}`);
    return run;
  }

  async #stateError(runId: string): Promise<RunStateError> {
    const run = await this.#db.analysisRun.findUnique({ where: { id: runId }, select: { status: true } });
    return new RunStateError(run ? `Run ${runId} is ${run.status}` : `Unknown run ${runId}`);
  }
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

/** Unique-constraint violation on a specific index (Prisma P2002, or a raw 23505 surfaced by the pg adapter). */
function isUniqueViolation(err: unknown, index: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta ?? {}).includes(index) || err.message.includes(index);
}
