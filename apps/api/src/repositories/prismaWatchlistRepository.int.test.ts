// Integration tests against a real Postgres (DATABASE_URL_TEST); see prismaAnalysisRepository.int.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../db/prisma.ts';
import { createClock } from './analysisRepository.contract.ts';
import { PrismaWatchlistRepository } from './prismaWatchlistRepository.ts';
import { describeWatchlistRepositoryContract } from './watchlistRepository.contract.ts';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST must be set for integration tests (see apps/api/.env.example)');
if (!new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('DATABASE_URL_TEST must point at a database whose name ends in _test');
}

let db: PrismaClient;

beforeAll(() => {
  db = createPrismaClient(databaseUrl);
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "WatchlistItem"');
});
afterAll(async () => {
  await db.$disconnect();
});

describeWatchlistRepositoryContract('postgres', (clock) =>
  Promise.resolve(new PrismaWatchlistRepository(db, clock.now)),
);

describe('PrismaWatchlistRepository', () => {
  it('leaves out a row whose stored instrument is unreadable', async () => {
    const repo = new PrismaWatchlistRepository(db, createClock().now);
    await repo.pin({ exchange: 'NSE', symbol: 'GOOD', name: 'Good Ltd', assetType: 'EQUITY' });
    await db.watchlistItem.create({ data: { instrumentKey: 'NSE:BAD', instrument: { nonsense: true } } });
    expect((await repo.list()).map((i) => i.instrumentKey)).toEqual(['NSE:GOOD']);
  });
});
