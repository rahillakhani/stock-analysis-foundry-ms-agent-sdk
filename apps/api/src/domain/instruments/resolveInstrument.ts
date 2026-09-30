import { parseInstrumentKey, type Exchange, type Instrument } from '@stock-analysis/shared';
import type { InstrumentMaster, InstrumentRecord } from './instrumentMaster.ts';

/**
 * RESOLVED only for an exact symbol, key, name, or alias match. Partial input never auto-resolves: its matches come
 * back as AMBIGUOUS candidates (possibly just one) for the user to confirm, because resolving "hdfc" or "w" to a
 * single company would cache an analysis under the wrong instrument.
 */
export type Resolution =
  | { status: 'RESOLVED'; instrument: Instrument }
  | { status: 'AMBIGUOUS'; candidates: Instrument[] }
  | { status: 'NOT_FOUND' };

const DEFAULT_EXCHANGE: Exchange = 'NSE';
const MAX_CANDIDATES = 20;
const MAX_SEARCH_LIMIT = 20;
/** Matches the API's QueryText cap; longer input can't be a symbol or company name. */
const MAX_QUERY_LENGTH = 100;
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
  /** Prefix and suffix name different exchanges (e.g. "BSE:RELIANCE.NS"): the query can't be trusted. */
  conflictingExchange: boolean;
}

/**
 * Parses free text such as "tata steel", "TATASTEEL.NS", "BSE:RELIANCE", or "Nifty 50 Futures".
 * The input is only ever compared against the master list; it is never executed or interpolated anywhere.
 */
export function parseQuery(raw: string): ParsedQuery {
  const words = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase().split(' ').filter(Boolean);

  // Futures intent only as a trailing word ("Nifty 50 Futures", "TATASTEEL.NS FUT"), so company names that contain
  // "Future" (e.g. "Future Retail") are not misread as a futures request.
  const wantsFutures = words.length > 1 && FUTURES_WORDS.has(words[words.length - 1] ?? '');
  let text = (wantsFutures ? words.slice(0, -1) : words).join(' ');

  let prefixExchange: Exchange | undefined;
  const prefix = /^(NSE|BSE)\s*:\s*/.exec(text);
  if (prefix?.[1]) {
    prefixExchange = prefix[1] as Exchange;
    text = text.slice(prefix[0].length);
  }
  let suffixExchange: Exchange | undefined;
  const suffix = /\.(NS|NSE|BO|BSE)$/.exec(text);
  if (suffix?.[1]) {
    suffixExchange = EXCHANGE_SUFFIXES[suffix[1]];
    text = text.slice(0, -suffix[0].length);
  }

  const conflictingExchange =
    prefixExchange !== undefined && suffixExchange !== undefined && prefixExchange !== suffixExchange;
  return { text: text.trim(), exchange: prefixExchange ?? suffixExchange, wantsFutures, conflictingExchange };
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
    const query = this.#parse(raw);
    if (query === undefined) return { status: 'NOT_FOUND' };

    const exact = this.#toInstruments(this.#exactMatches(query), query.wantsFutures);
    if (exact.length === 1) return { status: 'RESOLVED', instrument: exact[0]! };
    if (exact.length > 1) return { status: 'AMBIGUOUS', candidates: exact.slice(0, MAX_CANDIDATES) };

    const suggestions = this.#toInstruments(this.#rankedFuzzyMatches(query), query.wantsFutures);
    return suggestions.length === 0
      ? { status: 'NOT_FOUND' }
      : { status: 'AMBIGUOUS', candidates: suggestions.slice(0, MAX_CANDIDATES) };
  }

  /** Autocomplete: ranked candidates for partial input (exact, symbol prefix, then name/alias word prefix). */
  search(raw: string, limit = 10): Instrument[] {
    const query = this.#parse(raw);
    if (query === undefined) return [];
    const safeLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 10)));
    return this.#toInstruments(this.#rankedFuzzyMatches(query), query.wantsFutures).slice(0, safeLimit);
  }

  /** undefined when the query can't identify anything: empty, oversized, or with conflicting exchanges. */
  #parse(raw: string): ParsedQuery | undefined {
    if (raw.length > MAX_QUERY_LENGTH) return undefined;
    const query = parseQuery(raw);
    return query.text.length === 0 || query.conflictingExchange ? undefined : query;
  }

  /**
   * Exact lookup by canonical key (as returned by resolve/search). A futures key must name a listed contract that
   * is still trading; expired or unknown contracts return undefined.
   */
  byKey(key: string): Instrument | undefined {
    const parsed = parseInstrumentKey(key);
    if (!parsed) return undefined;
    const record = this.#master.all().find((r) => r.exchange === parsed.exchange && r.symbol === parsed.symbol);
    if (!record) return undefined;
    if (parsed.futureExpiry === undefined) return toSpot(record);
    const expiry = parsed.futureExpiry;
    const listed = record.futuresExpiries?.includes(expiry) ?? false;
    const live = nearestLiveExpiry([expiry], this.#now()) === expiry;
    return listed && live ? toFuture(record, expiry) : undefined;
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

  /** Partial matches, best first: exact, symbol prefix, then name/alias word prefix; ties by symbol. */
  #rankedFuzzyMatches(query: ParsedQuery): InstrumentRecord[] {
    return preferDefaultExchange([...this.#candidates(query)], query.exchange)
      .map((record) => ({ record, rank: rankMatch(record, query) }))
      .filter((entry): entry is { record: InstrumentRecord; rank: number } => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.record.symbol.localeCompare(b.record.symbol))
      .map((entry) => entry.record);
  }

  #toInstruments(records: readonly InstrumentRecord[], wantsFutures: boolean): Instrument[] {
    if (!wantsFutures) return records.map(toSpot);
    const now = this.#now();
    return records.flatMap((record): Instrument[] => {
      const expiry = record.futuresExpiries ? nearestLiveExpiry(record.futuresExpiries, now) : undefined;
      return expiry === undefined ? [] : [toFuture(record, expiry)].filter((i): i is Instrument => i !== undefined);
    });
  }
}

function toSpot(record: InstrumentRecord): Instrument {
  return { exchange: record.exchange, symbol: record.symbol, name: record.name, assetType: record.assetType };
}

function toFuture(record: InstrumentRecord, expiry: string): Instrument | undefined {
  if (record.futuresLotSize === undefined) return undefined;
  return {
    exchange: record.exchange,
    symbol: record.symbol,
    name: `${record.name} Futures ${expiry}`,
    assetType: 'FUTURE',
    contract: { expiry, lotSize: record.futuresLotSize },
  };
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

/**
 * When the user named no exchange and a symbol is dual-listed, keep only the default-exchange listing.
 * Matches by symbol, which holds for the fixture; a real master where BSE uses scrip codes needs an ISIN-based
 * match instead (Phase 12).
 */
function preferDefaultExchange(records: InstrumentRecord[], explicit: Exchange | undefined): InstrumentRecord[] {
  if (explicit) return records;
  const onDefault = new Set(records.filter((r) => r.exchange === DEFAULT_EXCHANGE).map((r) => r.symbol));
  return records.filter((record) => record.exchange === DEFAULT_EXCHANGE || !onDefault.has(record.symbol));
}
