// Behavioural contract every WatchlistRepository implementation must satisfy (in-memory in unit tests, Postgres in
// integration tests).
import { WATCHLIST_LIMIT, type Instrument } from '@stock-analysis/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClock, type ContractClock } from './analysisRepository.contract.ts';
import { WatchlistFullError, type WatchlistRepository } from './watchlistRepository.ts';

const equity = (symbol: string): Instrument => ({
  exchange: 'NSE',
  symbol,
  name: `${symbol} Ltd`,
  assetType: 'EQUITY',
});

export function describeWatchlistRepositoryContract(
  label: string,
  setup: (clock: ContractClock) => Promise<WatchlistRepository>,
): void {
  describe(`WatchlistRepository contract: ${label}`, () => {
    let clock: ContractClock;
    let repo: WatchlistRepository;

    beforeEach(async () => {
      clock = createClock();
      repo = await setup(clock);
    });

    it('lists pins newest first and keeps the original time when re-pinned', async () => {
      expect(await repo.list()).toEqual([]);
      await repo.pin(equity('AAA'));
      clock.set('2026-09-30T11:00:00.000Z');
      await repo.pin(equity('BBB'));
      clock.set('2026-09-30T12:00:00.000Z');
      const again = await repo.pin(equity('AAA'));

      expect(again.pinnedAt).toBe('2026-09-30T10:00:00.000Z');
      expect((await repo.list()).map((i) => [i.instrumentKey, i.pinnedAt])).toEqual([
        ['NSE:BBB', '2026-09-30T11:00:00.000Z'],
        ['NSE:AAA', '2026-09-30T10:00:00.000Z'],
      ]);
    });

    it('stores the full instrument, including futures contracts', async () => {
      const future: Instrument = {
        exchange: 'BSE',
        symbol: 'SENSEX',
        name: 'S&P BSE Sensex Futures 2026-10-29',
        assetType: 'FUTURE',
        contract: { expiry: '2026-10-29', lotSize: 20 },
      };
      await repo.pin(future);
      expect(await repo.list()).toEqual([
        { instrumentKey: 'BSE:SENSEX:FUT:2026-10-29', instrument: future, pinnedAt: '2026-09-30T10:00:00.000Z' },
      ]);
    });

    it('unpins, reporting whether anything was removed', async () => {
      await repo.pin(equity('AAA'));
      expect(await repo.unpin('NSE:AAA')).toBe(true);
      expect(await repo.unpin('NSE:AAA')).toBe(false);
      expect(await repo.list()).toEqual([]);
    });

    it('refuses a new pin beyond the limit but still accepts re-pins', async () => {
      for (let i = 0; i < WATCHLIST_LIMIT; i += 1) await repo.pin(equity(`S${i}`));
      await expect(repo.pin(equity('ONEMORE'))).rejects.toBeInstanceOf(WatchlistFullError);
      await expect(repo.pin(equity('S0'))).resolves.toMatchObject({ instrumentKey: 'NSE:S0' });
      expect(await repo.list()).toHaveLength(WATCHLIST_LIMIT);
    });

    it('rejects an invalid instrument', async () => {
      await expect(repo.pin({ exchange: 'NSE', symbol: 'bad', name: 'x', assetType: 'EQUITY' })).rejects.toThrow();
    });
  });
}
