import { Exchange, IsoDate, isStrictlyAscending, TradingSymbol } from '@stock-analysis/shared';
import { z } from 'zod';

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

/** Futures names append " Futures YYYY-MM-DD" (19 chars), so base names stay within the 200-char Instrument cap. */
const MAX_BASE_NAME_LENGTH = 180;

const InstrumentRecordSchema = z
  .object({
    exchange: Exchange,
    symbol: TradingSymbol,
    name: z.string().min(1).max(MAX_BASE_NAME_LENGTH),
    assetType: z.enum(['EQUITY', 'INDEX']),
    aliases: z.array(z.string().min(1).max(MAX_BASE_NAME_LENGTH)),
    futuresExpiries: z.array(IsoDate).min(1).refine(isStrictlyAscending, 'expiries must be ascending').optional(),
    futuresLotSize: z.number().int().positive().optional(),
  })
  .refine((r) => (r.futuresExpiries === undefined) === (r.futuresLotSize === undefined), {
    message: 'futuresExpiries and futuresLotSize must be set together',
  });

export class InMemoryInstrumentMaster implements InstrumentMaster {
  readonly #records: readonly InstrumentRecord[];

  /** Validates every record up front so the resolver can only emit instruments that satisfy the shared schema. */
  constructor(records: readonly InstrumentRecord[]) {
    const seen = new Set<string>();
    for (const record of records) {
      InstrumentRecordSchema.parse(record);
      const key = `${record.exchange}:${record.symbol}`;
      if (seen.has(key)) throw new Error(`Duplicate instrument record ${key}`);
      seen.add(key);
    }
    this.#records = records;
  }

  all(): readonly InstrumentRecord[] {
    return this.#records;
  }
}
