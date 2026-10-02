import { Instrument, instrumentKey, WATCHLIST_LIMIT } from '@stock-analysis/shared';
import type { PrismaClient } from '../db/prisma.ts';
import type { WatchlistItem } from '../generated/prisma/client.ts';
import { WatchlistFullError, type PinnedInstrument, type WatchlistRepository } from './watchlistRepository.ts';

/**
 * Postgres-backed watchlist. The size limit is checked inside the pinning transaction; two concurrent first-time
 * pins at the limit can exceed it by one (accepted: a soft cap for display, not an invariant).
 */
export class PrismaWatchlistRepository implements WatchlistRepository {
  readonly #db: PrismaClient;
  readonly #now: () => Date;

  constructor(db: PrismaClient, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  async list(): Promise<PinnedInstrument[]> {
    const rows = await this.#db.watchlistItem.findMany({
      orderBy: [{ pinnedAt: 'desc' }, { instrumentKey: 'asc' }],
      take: WATCHLIST_LIMIT,
    });
    // An unreadable row is left out rather than failing the whole list.
    return rows.flatMap((row) => {
      const item = toPinned(row);
      return item ? [item] : [];
    });
  }

  async pin(input: Instrument): Promise<PinnedInstrument> {
    const instrument = Instrument.parse(input);
    const key = instrumentKey(instrument);
    const row = await this.#db.$transaction(async (tx) => {
      const existing = await tx.watchlistItem.findUnique({ where: { instrumentKey: key } });
      if (existing) return existing;
      if ((await tx.watchlistItem.count()) >= WATCHLIST_LIMIT) {
        throw new WatchlistFullError(`The watchlist holds at most ${WATCHLIST_LIMIT} instruments`);
      }
      return tx.watchlistItem.create({ data: { instrumentKey: key, instrument, pinnedAt: this.#now() } });
    });
    return {
      instrumentKey: row.instrumentKey,
      instrument: Instrument.parse(row.instrument),
      pinnedAt: row.pinnedAt.toISOString(),
    };
  }

  async unpin(key: string): Promise<boolean> {
    const { count } = await this.#db.watchlistItem.deleteMany({ where: { instrumentKey: key } });
    return count > 0;
  }
}

function toPinned(row: WatchlistItem): PinnedInstrument | undefined {
  const instrument = Instrument.safeParse(row.instrument);
  return instrument.success
    ? { instrumentKey: row.instrumentKey, instrument: instrument.data, pinnedAt: row.pinnedAt.toISOString() }
    : undefined;
}
