import { describe, expect, it } from 'vitest';
import { describeAnalysisRepositoryContract, createClock } from './analysisRepository.contract.ts';
import { InMemoryAnalysisRepository } from './inMemoryAnalysisRepository.ts';

describeAnalysisRepositoryContract('in-memory', (clock) => Promise.resolve(new InMemoryAnalysisRepository(clock.now)));

describe('InMemoryAnalysisRepository', () => {
  it('returns copies, so callers cannot mutate stored state', async () => {
    const repo = new InMemoryAnalysisRepository(createClock().now);
    const stock = await repo.upsertStock({ exchange: 'NSE', symbol: 'ABC', name: 'Abc', assetType: 'EQUITY' });
    stock.instrument.name = 'mutated';
    expect((await repo.findStockByKey('NSE:ABC'))?.instrument.name).toBe('Abc');
  });
});
