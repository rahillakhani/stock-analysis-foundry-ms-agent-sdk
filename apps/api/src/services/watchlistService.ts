import { currencyFor, type Watchlist, type WatchlistItem } from '@stock-analysis/shared';
import type { Logger } from 'pino';
import {
  InstrumentLookupUnavailableError,
  type InstrumentDirectory,
} from '../domain/instruments/instrumentDirectory.ts';
import { AppError } from '../http/errors.ts';
import type { MarketDataSource, MarketQuote } from '../market/marketData.ts';
import { yahooSymbolFor } from '../market/symbols.ts';
import type { AnalysisRepository } from '../repositories/analysisRepository.ts';
import { WatchlistFullError, type WatchlistRepository } from '../repositories/watchlistRepository.ts';
import { priceMove } from './marketService.ts';

export interface WatchlistServiceDeps {
  watchlist: WatchlistRepository;
  analyses: AnalysisRepository;
  directory: InstrumentDirectory;
  /** Undefined when live market data is off: items are listed without prices. */
  market: MarketDataSource | undefined;
  logger: Logger;
}

const TIMEOUT_MS = 6_000;

/** Pinned instruments with their live price (one batch request) and latest analysis. Prices degrade to null. */
export class WatchlistService {
  readonly #deps: WatchlistServiceDeps;

  constructor(deps: WatchlistServiceDeps) {
    this.#deps = deps;
  }

  async list(): Promise<Watchlist> {
    const pins = await this.#deps.watchlist.list();
    const [quotes, analysed] = await Promise.all([
      this.#quotes(pins.flatMap((p) => (p.instrument.assetType === 'FUTURE' ? [] : [vendorSymbol(p.instrument)]))),
      this.#deps.analyses.listAnalysedStocks(),
    ]);
    const latestByKey = new Map(analysed.map((stock) => [stock.instrumentKey, stock]));

    const items = pins.map(({ instrumentKey, instrument, pinnedAt }): WatchlistItem => {
      const quote = instrument.assetType === 'FUTURE' ? undefined : quotes.get(vendorSymbol(instrument));
      const move = quote && priceMove(quote);
      const latest = latestByKey.get(instrumentKey);
      return {
        instrumentKey,
        name: instrument.name,
        exchange: instrument.exchange,
        assetType: instrument.assetType,
        pinnedAt,
        quote: move
          ? { currency: currencyFor(instrument.exchange), ...move, marketState: quote.marketState ?? 'CLOSED' }
          : null,
        latest: latest
          ? {
              lastAnalysedAt: latest.lastAnalysedAt,
              indicator: latest.indicator,
              confidenceScore: latest.confidenceScore,
              policyVersion: latest.policyVersion,
              runStatus: latest.runStatus,
            }
          : null,
      };
    });
    return { items };
  }

  async pin(key: string): Promise<Watchlist> {
    let instrument;
    try {
      instrument = await this.#deps.directory.byKey(key, AbortSignal.timeout(TIMEOUT_MS));
    } catch (err) {
      if (err instanceof InstrumentLookupUnavailableError) {
        throw new AppError(503, 'Market data is temporarily unavailable. Please try again shortly.', { cause: err });
      }
      throw err;
    }
    if (!instrument) throw new AppError(404, `Unknown or expired instrument ${key}.`);
    try {
      await this.#deps.watchlist.pin(instrument);
    } catch (err) {
      if (err instanceof WatchlistFullError) {
        throw new AppError(409, err.message, { cause: err, extensions: { code: 'WATCHLIST_FULL' } });
      }
      throw err;
    }
    return this.list();
  }

  /** Idempotent: unpinning something that isn't pinned is not an error. */
  async unpin(key: string): Promise<Watchlist> {
    await this.#deps.watchlist.unpin(key);
    return this.list();
  }

  async #quotes(symbols: string[]): Promise<Map<string, MarketQuote>> {
    const market = this.#deps.market;
    if (!market || symbols.length === 0) return new Map();
    try {
      const quotes = await market.quotes(symbols, AbortSignal.timeout(TIMEOUT_MS));
      return new Map(quotes.map((q) => [q.vendorSymbol, q]));
    } catch (err) {
      this.#deps.logger.warn(
        { error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown error' },
        'watchlist quotes unavailable; listing without prices',
      );
      return new Map();
    }
  }
}

const vendorSymbol = (instrument: { exchange: Parameters<typeof yahooSymbolFor>[0]; symbol: string }) =>
  yahooSymbolFor(instrument.exchange, instrument.symbol);
