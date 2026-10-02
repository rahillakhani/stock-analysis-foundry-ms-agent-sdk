import { TradingSymbol, type Exchange, type Instrument } from '@stock-analysis/shared';
import type { MarketSearchHit } from './marketData.ts';

/** Yahoo Finance exchange codes (observed in live responses) for the exchanges we support. */
const YAHOO_EXCHANGES: Readonly<Record<string, Exchange>> = {
  NSI: 'NSE',
  BSE: 'BSE',
  BOM: 'BSE',
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NYQ: 'NYSE',
};

/** Indices whose Yahoo symbols don't follow the exchange-suffix rule. */
const YAHOO_INDEX_SYMBOLS: Readonly<Record<string, string>> = {
  'NSE:NIFTY': '^NSEI',
  'NSE:BANKNIFTY': '^NSEBANK',
  'BSE:SENSEX': '^BSESN',
};

/** Our instrument -> Yahoo symbol: NSE:MRF -> MRF.NS, BSE:MRF -> MRF.BO, NASDAQ:MMYT -> MMYT. */
export function yahooSymbolFor(exchange: Exchange, symbol: string): string {
  const index = YAHOO_INDEX_SYMBOLS[`${exchange}:${symbol}`];
  if (index) return index;
  if (exchange === 'NSE') return `${symbol}.NS`;
  if (exchange === 'BSE') return `${symbol}.BO`;
  return symbol;
}

/**
 * A Yahoo search hit -> our Instrument, or undefined for anything we don't support (other exchanges, funds,
 * options, indices without a mapping, symbols outside our symbol grammar).
 */
export function instrumentFromYahoo(hit: MarketSearchHit): Instrument | undefined {
  const exchange = YAHOO_EXCHANGES[hit.exchangeCode];
  if (!exchange || hit.quoteType !== 'EQUITY') return undefined;
  const symbol = hit.vendorSymbol.replace(/\.(NS|BO)$/, '');
  if (!TradingSymbol.safeParse(symbol).success || yahooSymbolFor(exchange, symbol) !== hit.vendorSymbol) {
    return undefined;
  }
  const name = hit.name.trim().slice(0, 180);
  // Yahoo labels some non-common-stock listings EQUITY: US preferred shares/notes (e.g. F-PB) and Indian ETFs.
  const preferredSymbol = !(exchange === 'NSE' || exchange === 'BSE') && /-P[A-Z]?$/.test(symbol);
  const nonCommonName = /\b(ETF|ETN|notes?|preferred|pref|debentures?|bonds?|depositary units?)\b|%/i.test(name);
  if (preferredSymbol || nonCommonName) return undefined;
  return name.length > 0 ? { exchange, symbol, name, assetType: 'EQUITY' } : undefined;
}
