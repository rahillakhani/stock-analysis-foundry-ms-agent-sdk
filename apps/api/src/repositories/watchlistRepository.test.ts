import { describe, expect, it } from 'vitest';
import { createClock } from './analysisRepository.contract.ts';
import { describeWatchlistRepositoryContract } from './watchlistRepository.contract.ts';
import { InMemoryWatchlistRepository } from './watchlistRepository.ts';

describeWatchlistRepositoryContract('in-memory', (clock) =>
  Promise.resolve(new InMemoryWatchlistRepository(clock.now)),
);

describe('InMemoryWatchlistRepository', () => {
  it('returns copies, so callers cannot mutate stored state', async () => {
    const repo = new InMemoryWatchlistRepository(createClock().now);
    const pinned = await repo.pin({ exchange: 'NSE', symbol: 'ABC', name: 'Abc', assetType: 'EQUITY' });
    pinned.instrument.name = 'mutated';
    expect((await repo.list())[0]?.instrument.name).toBe('Abc');
  });
});
