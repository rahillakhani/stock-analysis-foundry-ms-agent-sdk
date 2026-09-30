// Integration tests against a real Postgres (DATABASE_URL_TEST). Run with `npm run test:int`; never part of
// `npm test`. Each test starts from empty tables.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../db/prisma.ts';
import { strongEquity } from '../test-support/snapshots.ts';
import { RunInFlightError } from './analysisRepository.ts';
import { createClock, describeAnalysisRepositoryContract } from './analysisRepository.contract.ts';
import { PrismaAnalysisRepository } from './prismaAnalysisRepository.ts';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST must be set for integration tests (see apps/api/.env.example)');

let db: PrismaClient;

beforeAll(() => {
  db = createPrismaClient(databaseUrl);
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "AnalysisTimeline", "AnalysisRun", "Stock" CASCADE');
});
afterAll(async () => {
  await db.$disconnect();
});

describeAnalysisRepositoryContract('postgres', (clock) => Promise.resolve(new PrismaAnalysisRepository(db, clock.now)));

describe('PrismaAnalysisRepository (database guarantees)', () => {
  const instrument = strongEquity().instrument;

  it('lets exactly one of two concurrent createRun calls win', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);

    const results = await Promise.allSettled([repo.createRun(stock.id), repo.createRun(stock.id)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(RunInFlightError);
  });

  it('rolls back the whole completion when the timeline write fails', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    // Pre-existing timeline row for this run makes the transaction's timeline insert violate its unique key.
    await db.analysisTimeline.create({
      data: { stockId: stock.id, analysisRunId: run.id, eventType: 'INITIAL_RESEARCH', snapshotData: {} },
    });
    const { ResearchSnapshot } = await import('@stock-analysis/shared');
    const { evaluate } = await import('../domain/decision/evaluate.ts');
    const { POLICY_V1 } = await import('../domain/decision/policy.ts');
    const snapshot = ResearchSnapshot.parse(strongEquity());

    await expect(
      repo.completeRun(run.id, {
        status: 'SUCCEEDED',
        decision: evaluate(snapshot, POLICY_V1, new Date('2026-09-30T10:00:00.000Z')),
        explanation: { status: 'UNAVAILABLE' },
        snapshot,
        sources: snapshot.sources,
        unavailableDimensions: [],
      }),
    ).rejects.toThrow();

    expect((await repo.getRun(run.id))?.status).toBe('PENDING');
    expect((await repo.findStockByKey('NSE:TESTCO'))?.lastAnalysedAt).toBeNull();
  });

  it('rejects a duplicate instrument key at the database level', async () => {
    const data = {
      instrumentKey: 'NSE:DUP',
      ticker: 'DUP',
      companyName: 'Dup',
      exchange: 'NSE',
      assetType: 'EQUITY' as const,
      instrument: {},
    };
    await db.stock.create({ data });
    await expect(db.stock.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it.each([
    ['SUCCEEDED without a decision', `status = 'SUCCEEDED', "completedAt" = now()`],
    ['FAILED without an error', `status = 'FAILED', "completedAt" = now()`],
    ['PENDING with a completion time', `"completedAt" = now()`],
    ['a confidence score above 100', `"confidenceScore" = 101`],
    [
      'completion before start',
      `status = 'FAILED', error = '{}'::jsonb, "completedAt" = "startedAt" - interval '1 second'`,
    ],
  ])('rejects %s via CHECK constraints', async (_label, assignment) => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    await expect(
      db.$executeRawUnsafe(`UPDATE "AnalysisRun" SET ${assignment} WHERE id = '${run.id}'::uuid`),
    ).rejects.toThrow(/violates check constraint/);
  });

  it('keeps a timeline entry on the same stock as its run (composite foreign key)', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const a = await repo.upsertStock(instrument);
    const b = await repo.upsertStock({ ...instrument, symbol: 'OTHERCO', name: 'Other Co' });
    const run = await repo.createRun(a.id);

    await expect(
      db.analysisTimeline.create({
        data: { stockId: b.id, analysisRunId: run.id, eventType: 'INITIAL_RESEARCH', snapshotData: {} },
      }),
    ).rejects.toThrow();
  });

  it('cascades a stock delete to its runs and timeline', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    await db.stock.delete({ where: { id: stock.id } });

    expect(await db.analysisRun.count({ where: { id: run.id } })).toBe(0);
    expect(await db.analysisTimeline.count({ where: { stockId: stock.id } })).toBe(0);
  });
});
