import { Instrument, instrumentKey, WATCHLIST_LIMIT } from '@stock-analysis/shared';

export interface PinnedInstrument {
  instrumentKey: string;
  instrument: Instrument;
  /** ISO timestamp. */
  pinnedAt: string;
}

/** Pinning would exceed WATCHLIST_LIMIT. */
export class WatchlistFullError extends Error {
  override readonly name = 'WatchlistFullError';
}

/**
 * Persistence port for the watchlist. Implemented by Prisma (Postgres) and an in-memory store; both pass the shared
 * contract suite in watchlistRepository.contract.ts. Pinning is idempotent (re-pinning keeps the original time).
 */
export interface WatchlistRepository {
  /** Most recently pinned first (ties by key). */
  list(): Promise<PinnedInstrument[]>;
  /** Throws WatchlistFullError when a new pin would exceed WATCHLIST_LIMIT. */
  pin(instrument: Instrument): Promise<PinnedInstrument>;
  /** Returns whether the instrument was pinned. */
  unpin(instrumentKey: string): Promise<boolean>;
}

export function byPinnedAtDesc(a: PinnedInstrument, b: PinnedInstrument): number {
  return b.pinnedAt.localeCompare(a.pinnedAt) || a.instrumentKey.localeCompare(b.instrumentKey);
}

export class InMemoryWatchlistRepository implements WatchlistRepository {
  readonly #now: () => Date;
  readonly #items = new Map<string, PinnedInstrument>();

  constructor(now: () => Date) {
    this.#now = now;
  }

  list(): Promise<PinnedInstrument[]> {
    return Promise.resolve([...this.#items.values()].map((item) => structuredClone(item)).sort(byPinnedAtDesc));
  }

  // async so that validation failures reject rather than throw, like the Postgres implementation.
  // eslint-disable-next-line @typescript-eslint/require-await
  async pin(input: Instrument): Promise<PinnedInstrument> {
    const instrument = Instrument.parse(input);
    const key = instrumentKey(instrument);
    const existing = this.#items.get(key);
    if (existing) return structuredClone(existing);
    if (this.#items.size >= WATCHLIST_LIMIT) {
      throw new WatchlistFullError(`The watchlist holds at most ${WATCHLIST_LIMIT} instruments`);
    }
    const item = { instrumentKey: key, instrument, pinnedAt: this.#now().toISOString() };
    this.#items.set(key, item);
    return structuredClone(item);
  }

  unpin(key: string): Promise<boolean> {
    return Promise.resolve(this.#items.delete(key));
  }
}
