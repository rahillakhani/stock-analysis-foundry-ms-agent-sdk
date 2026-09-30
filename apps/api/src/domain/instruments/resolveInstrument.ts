import type { Exchange, Instrument } from '@stock-analysis/shared';
import type { InstrumentMaster, InstrumentRecord } from './instrumentMaster.ts';

export type Resolution =
  | { status: 'RESOLVED'; instrument: Instrument }
  | { status: 'AMBIGUOUS'; candidates: Instrument[] }
  | { status: 'NOT_FOUND' };

const DEFAULT_EXCHANGE: Exchange = 'NSE';
const MAX_CANDIDATES = 20;
const IST_OFFSET_MINUTES = 5 * 60 + 30;
/** Monthly contracts trade until the 15:30 IST close on their expiry day. */
const EXPIRY_CUTOFF_MINUTES_IST = 15 * 60 + 30;

const EXCHANGE_SUFFIXES: Record<string, Exchange> = { NS: 'NSE', NSE: 'NSE', BO: 'BSE', BSE: 'BSE' };
const FUTURES_WORDS = new Set(['FUT', 'FUTS', 'FUTURE', 'FUTURES']);
const COMPANY_NOISE = new Set(['LTD', 'LIMITED', 'INC', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'THE']);

interface ParsedQuery {
  /** Uppercased, whitespace-collapsed text with exchange and futures markers removed. */
  text: string;
  exchange: Exchange | undefined;
  wantsFutures: boolean;
}

/**
 * Parses free text such as "tata steel", "TATASTEEL.NS", "BSE:RELIANCE", or "Nifty 50 Futures".
 * The input is only ever compared against the master list; it is never executed or interpolated anywhere.
 */
export function parseQuery(raw: string): ParsedQuery {
  let text = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  let exchange: Exchange | undefined;

  const prefix = /^(NSE|BSE)\s*:\s*/.exec(text);
  if (prefix?.[1]) {
    exchange = prefix[1] as Exchange;
    text = text.slice(prefix[0].length);
  }
  const suffix = /\.(NS|NSE|BO|BSE)$/.exec(text);
  if (suffix?.[1]) {
    exchange ??= EXCHANGE_SUFFIXES[suffix[1]];
    text = text.slice(0, -suffix[0].length);
  }

  const words = text.split(' ').filter((word) => word.length > 0);
  const wantsFutures = words.some((word) => FUTURES_WORDS.has(word));
  text = words.filter((word) => !FUTURES_WORDS.has(word)).join(' ');
  return { text, exchange, wantsFutures };
}

/** Case-, punctuation-, and suffix-insensitive form for comparing names ("Tata Steel Ltd." == "tata steel"). */
export function nameKey(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !COMPANY_NOISE.has(word))
    .join(' ');
}

/** Returns the calendar date (YYYY-MM-DD) and minutes past midnight in India Standard Time. */
function istClock(now: Date): { date: string; minutes: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

/** Nearest contract still trading at `now`: expiring later than today (IST), or today before the 15:30 close. */
export function nearestLiveExpiry(expiries: readonly string[], now: Date): string | undefined {
  const { date, minutes } = istClock(now);
  return expiries.find((expiry) => expiry > date || (expiry === date && minutes < EXPIRY_CUTOFF_MINUTES_IST));
}

export class InstrumentResolver {
  readonly #master: InstrumentMaster;
  readonly #now: () => Date;

  constructor(master: InstrumentMaster, now: () => Date) {
    this.#master = master;
    this.#now = now;
  }

  /** Spec step 1: map a user query to exactly one instrument, several candidates, or nothing. */
  resolve(raw: string): Resolution {
    const query = parseQuery(raw);
    if (query.text.length === 0) return { status: 'NOT_FOUND' };

    const exact = this.#exactMatches(query);
    const matches = exact.length > 0 ? exact : this.#fuzzyMatches(query);
    const instruments = this.#toInstruments(matches, query.wantsFutures);

    if (instruments.length === 0) return { status: 'NOT_FOUND' };
    if (instruments.length === 1) return { status: 'RESOLVED', instrument: instruments[0]! };
    return { status: 'AMBIGUOUS', candidates: instruments.slice(0, MAX_CANDIDATES) };
  }

  /** Autocomplete: ranked candidates for partial input (exact, symbol prefix, then name/alias word prefix). */
  search(raw: string, limit = 10): Instrument[] {
    const query = parseQuery(raw);
    if (query.text.length === 0) return [];
    const ranked = preferDefaultExchange([...this.#candidates(query)], query.exchange)
      .map((record) => ({ record, rank: rankMatch(record, query) }))
      .filter((entry): entry is { record: InstrumentRecord; rank: number } => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.record.symbol.localeCompare(b.record.symbol));
    return this.#toInstruments(
      ranked.map((entry) => entry.record),
      query.wantsFutures,
    ).slice(0, limit);
  }

  #candidates(query: ParsedQuery): readonly InstrumentRecord[] {
    const all = this.#master.all();
    return query.exchange ? all.filter((record) => record.exchange === query.exchange) : all;
  }

  /** Exact symbol, or exact name/alias. Without an explicit exchange, a symbol listed on several prefers NSE. */
  #exactMatches(query: ParsedQuery): InstrumentRecord[] {
    const candidates = this.#candidates(query);
    const bySymbol = candidates.filter((record) => record.symbol === query.text);
    const key = nameKey(query.text);
    const matches =
      bySymbol.length > 0
        ? bySymbol
        : candidates.filter((record) => [record.name, ...record.aliases].some((name) => nameKey(name) === key));
    return preferDefaultExchange(matches, query.exchange);
  }

  #fuzzyMatches(query: ParsedQuery): InstrumentRecord[] {
    const matches = this.#candidates(query).filter((record) => rankMatch(record, query) !== undefined);
    return preferDefaultExchange(matches, query.exchange);
  }

  #toInstruments(records: readonly InstrumentRecord[], wantsFutures: boolean): Instrument[] {
    if (!wantsFutures) {
      return records.map((record) => ({
        exchange: record.exchange,
        symbol: record.symbol,
        name: record.name,
        assetType: record.assetType,
      }));
    }
    const now = this.#now();
    return records.flatMap((record): Instrument[] => {
      const expiry = record.futuresExpiries ? nearestLiveExpiry(record.futuresExpiries, now) : undefined;
      if (expiry === undefined || record.futuresLotSize === undefined) return [];
      return [
        {
          exchange: record.exchange,
          symbol: record.symbol,
          name: `${record.name} Futures ${expiry}`,
          assetType: 'FUTURE',
          contract: { expiry, lotSize: record.futuresLotSize },
        },
      ];
    });
  }
}

/** Lower rank = better match; undefined = no match. */
function rankMatch(record: InstrumentRecord, query: ParsedQuery): number | undefined {
  const text = query.text;
  if (record.symbol === text) return 0;
  if (record.symbol.startsWith(text)) return 1;
  const key = nameKey(text);
  if (key.length === 0) return undefined;
  const names = [record.name, ...record.aliases].map(nameKey);
  if (names.some((name) => name === key)) return 0;
  // Word-prefix only: mid-word substrings ("tat" in "STATE") are noise for autocomplete.
  if (names.some((name) => name.startsWith(key) || name.includes(` ${key}`))) return 2;
  return undefined;
}

/** When the user named no exchange and a symbol is dual-listed, keep only the default-exchange listing. */
function preferDefaultExchange(records: InstrumentRecord[], explicit: Exchange | undefined): InstrumentRecord[] {
  if (explicit) return records;
  const onDefault = new Set(records.filter((r) => r.exchange === DEFAULT_EXCHANGE).map((r) => r.symbol));
  return records.filter((record) => record.exchange === DEFAULT_EXCHANGE || !onDefault.has(record.symbol));
}
