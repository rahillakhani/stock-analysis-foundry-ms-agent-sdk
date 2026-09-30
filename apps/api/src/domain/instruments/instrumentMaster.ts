import type { Exchange } from '@stock-analysis/shared';

/**
 * One tradable underlying as the resolver sees it. Futures are not separate records: a record with
 * `futuresExpiries` has monthly contracts, and the resolver picks the nearest live one when the query asks for
 * futures.
 */
export interface InstrumentRecord {
  exchange: Exchange;
  symbol: string;
  name: string;
  assetType: 'EQUITY' | 'INDEX';
  /** Extra names users type, e.g. "Nifty 50", "SBI". Matched case- and punctuation-insensitively. */
  aliases: readonly string[];
  /** Ascending YYYY-MM-DD expiries of the underlying's monthly futures, if it has F&O. */
  futuresExpiries?: readonly string[];
  futuresLotSize?: number;
}

/** Source of instrument records. The MVP uses a static list; a real symbol master can implement the same port. */
export interface InstrumentMaster {
  all(): readonly InstrumentRecord[];
}

export class InMemoryInstrumentMaster implements InstrumentMaster {
  readonly #records: readonly InstrumentRecord[];

  constructor(records: readonly InstrumentRecord[]) {
    this.#records = records;
  }

  all(): readonly InstrumentRecord[] {
    return this.#records;
  }
}
