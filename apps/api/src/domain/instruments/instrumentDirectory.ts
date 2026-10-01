import { instrumentKey, parseInstrumentKey, type Instrument } from '@stock-analysis/shared';
import type { Logger } from 'pino';
import type { MarketDataSource } from '../../market/marketData.ts';
import { instrumentFromYahoo, yahooSymbolFor } from '../../market/symbols.ts';
import { nameKey, parseQuery, type InstrumentResolver, type Resolution } from './resolveInstrument.ts';

const MAX_CANDIDATES = 20;
const MAX_SEARCH_RESULTS = 10;

/**
 * Finds instruments in the built-in list first and, when a market-data source is configured, on the web (any
 * NSE/BSE/NASDAQ/NYSE listing). The same safety rule applies to both: only an exact symbol or exact company name
 * resolves; anything looser returns candidates for the user to confirm. A failing web lookup degrades to the
 * built-in results instead of failing the request.
 */
export class InstrumentDirectory {
  readonly #resolver: InstrumentResolver;
  readonly #market: MarketDataSource | undefined;
  readonly #logger: Logger;

  constructor(resolver: InstrumentResolver, market: MarketDataSource | undefined, logger: Logger) {
    this.#resolver = resolver;
    this.#market = market;
    this.#logger = logger;
  }

  async resolve(raw: string, signal?: AbortSignal): Promise<Resolution> {
    const local = this.#resolver.resolve(raw);
    if (local.status === 'RESOLVED' || !this.#market) return local;

    const query = parseQuery(raw);
    // Futures contracts and conflicting/empty queries are only known locally.
    if (query.wantsFutures || query.conflictingExchange || query.text.length === 0) return local;

    const web = await this.#webInstruments(query.text, query.exchange, signal);
    const symbolKey = query.text.toUpperCase();
    const name = nameKey(query.text);
    const exact = web.filter((i) => i.symbol === symbolKey || (name.length > 0 && nameKey(i.name) === name));
    if (exact.length === 1 && exact[0]) return { status: 'RESOLVED', instrument: exact[0] };

    const candidates = dedupe([
      ...(local.status === 'AMBIGUOUS' ? local.candidates : []),
      ...(exact.length > 1 ? exact : web),
    ]);
    return candidates.length === 0
      ? { status: 'NOT_FOUND' }
      : { status: 'AMBIGUOUS', candidates: candidates.slice(0, MAX_CANDIDATES) };
  }

  /** Autocomplete: built-in matches first, then web matches, without duplicates. */
  async search(raw: string, signal?: AbortSignal): Promise<Instrument[]> {
    const local = this.#resolver.search(raw, MAX_SEARCH_RESULTS);
    const query = parseQuery(raw);
    if (!this.#market || local.length >= MAX_SEARCH_RESULTS || query.wantsFutures || query.text.length < 2) {
      return local;
    }
    const web = await this.#webInstruments(query.text, query.exchange, signal);
    return dedupe([...local, ...web]).slice(0, MAX_SEARCH_RESULTS);
  }

  /** Exact lookup by canonical key: built-in list, else the market source confirms the listing exists. */
  async byKey(key: string, signal?: AbortSignal): Promise<Instrument | undefined> {
    const local = this.#resolver.byKey(key);
    if (local || !this.#market) return local;
    const parsed = parseInstrumentKey(key);
    if (!parsed || parsed.futureExpiry !== undefined) return undefined;
    try {
      const quote = await this.#market.quote(yahooSymbolFor(parsed.exchange, parsed.symbol), signal);
      const instrument = quote ? instrumentFromYahoo(quote) : undefined;
      return instrument && instrumentKey(instrument) === key ? instrument : undefined;
    } catch (err) {
      this.#logger.warn({ err, key }, 'market lookup by key failed');
      return undefined;
    }
  }

  async #webInstruments(text: string, exchange: string | undefined, signal?: AbortSignal): Promise<Instrument[]> {
    if (!this.#market) return [];
    try {
      const hits = await this.#market.search(text, signal);
      const instruments = hits
        .map(instrumentFromYahoo)
        .filter((i): i is Instrument => i !== undefined && (exchange === undefined || i.exchange === exchange));
      return preferNse(instruments, exchange);
    } catch (err) {
      this.#logger.warn({ err }, 'market search failed; using built-in instruments only');
      return [];
    }
  }
}

/** Unique by canonical key, first occurrence wins. */
function dedupe(instruments: Instrument[]): Instrument[] {
  const seen = new Set<string>();
  return instruments.filter((instrument) => {
    const key = instrumentKey(instrument);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Without an explicit exchange, a symbol listed on both NSE and BSE is offered once, on NSE. */
function preferNse(instruments: Instrument[], explicit: string | undefined): Instrument[] {
  if (explicit) return instruments;
  const onNse = new Set(instruments.filter((i) => i.exchange === 'NSE').map((i) => i.symbol));
  return instruments.filter((i) => i.exchange !== 'BSE' || !onNse.has(i.symbol));
}
