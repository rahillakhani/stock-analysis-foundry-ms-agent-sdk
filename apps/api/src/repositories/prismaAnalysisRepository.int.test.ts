// Integration tests against a real Postgres (DATABASE_URL_TEST). Run with `npm run test:int`; never part of
// `npm test`. Each test starts from empty tables.
import { ResearchSnapshot } from '@stock-analysis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../db/prisma.ts';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V1 } from '../domain/decision/policy.ts';
import { strongEquity } from '../test-support/snapshots.ts';
import { RunInFlightError } from './analysisRepository.ts';
import { createClock, describeAnalysisRepositoryContract } from './analysisRepository.contract.ts';
import { PrismaAnalysisRepository } from './prismaAnalysisRepository.ts';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST must be set for integration tests (see apps/api/.env.example)');
// These tests TRUNCATE tables: refuse to run against anything but a dedicated *_test database.
if (!new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('DATABASE_URL_TEST must point at a database whose name ends in _test');
}

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
    // Only the pre-seeded row remains: the transaction's own timeline insert was rolled back.
    expect(await db.analysisTimeline.count({ where: { stockId: stock.id } })).toBe(1);
  });

  it('lets exactly one of a concurrent complete and fail win', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    const snapshot = ResearchSnapshot.parse(strongEquity());

    const results = await Promise.allSettled([
      repo.completeRun(run.id, {
        status: 'SUCCEEDED',
        decision: evaluate(snapshot, POLICY_V1, new Date('2026-09-30T10:00:00.000Z')),
        explanation: { status: 'UNAVAILABLE' },
        snapshot,
        sources: snapshot.sources,
        unavailableDimensions: [],
      }),
      repo.failRun(run.id, { code: 'PROVIDER_TIMEOUT', message: 'Research timed out.' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const final = await repo.getRun(run.id);
    const timelineRows = await db.analysisTimeline.count({ where: { stockId: stock.id } });
    expect(timelineRows).toBe(final?.status === 'SUCCEEDED' ? 1 : 0);
  });

  it('stores the research snapshot so the run can be reproduced', async () => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    const snapshot = ResearchSnapshot.parse(strongEquity());
    await repo.completeRun(run.id, {
      status: 'SUCCEEDED',
      decision: evaluate(snapshot, POLICY_V1, new Date('2026-09-30T10:00:00.000Z')),
      explanation: { status: 'UNAVAILABLE' },
      snapshot,
      sources: snapshot.sources,
      unavailableDimensions: [],
    });

    const row = await db.analysisRun.findUniqueOrThrow({ where: { id: run.id }, select: { researchSnapshot: true } });
    expect(ResearchSnapshot.parse(row.researchSnapshot)).toEqual(snapshot);
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

  it.each([
    ['PARTIAL with NULL dimensions', 'PARTIAL', `"unavailableDimensions" = NULL`],
    ['PARTIAL with an unknown dimension', 'PARTIAL', `"unavailableDimensions" = ARRAY['bogus']`],
    ['SUCCEEDED listing dimensions', 'SUCCEEDED', `"unavailableDimensions" = ARRAY['sentiment']`],
    ['FAILED carrying a decision indicator', 'FAILED', `"decisionIndicator" = 'BUY'`],
  ])('rejects %s via CHECK constraints', async (_label, status, assignment) => {
    const repo = new PrismaAnalysisRepository(db, createClock().now);
    const stock = await repo.upsertStock(instrument);
    const run = await repo.createRun(stock.id);
    if (status === 'FAILED') {
      await repo.failRun(run.id, { code: 'PROVIDER_TIMEOUT', message: 'Research timed out.' });
    } else {
      const snapshot = ResearchSnapshot.parse(strongEquity());
      await repo.completeRun(run.id, {
        status: status as 'SUCCEEDED' | 'PARTIAL',
        decision: evaluate(snapshot, POLICY_V1, new Date('2026-09-30T10:00:00.000Z')),
        explanation: { status: 'UNAVAILABLE' },
        snapshot,
        sources: snapshot.sources,
        unavailableDimensions: status === 'PARTIAL' ? ['sentiment'] : [],
      });
    }
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
