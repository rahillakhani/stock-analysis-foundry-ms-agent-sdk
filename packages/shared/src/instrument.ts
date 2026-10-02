import { z } from 'zod';
import { IsoDate } from './common.ts';

export const ASSET_TYPES = ['EQUITY', 'FUTURE', 'INDEX'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Indian exchanges (with F&O and India-specific rules) and US exchanges. */
export const EXCHANGES = ['NSE', 'BSE', 'NASDAQ', 'NYSE'] as const;
export const Exchange = z.enum(EXCHANGES);
export type Exchange = z.infer<typeof Exchange>;

export const INDIAN_EXCHANGES: readonly Exchange[] = ['NSE', 'BSE'];

export function isIndianExchange(exchange: Exchange): boolean {
  return INDIAN_EXCHANGES.includes(exchange);
}

/** ISO 4217 trading currency of an exchange. */
export function currencyFor(exchange: Exchange): 'INR' | 'USD' {
  return isIndianExchange(exchange) ? 'INR' : 'USD';
}

/** IANA time zone an exchange's sessions are held in. */
export function timeZoneFor(exchange: Exchange): 'Asia/Kolkata' | 'America/New_York' {
  return isIndianExchange(exchange) ? 'Asia/Kolkata' : 'America/New_York';
}

/** Exchange trading symbol, e.g. `TATASTEEL`, `M&M`, `BAJAJ-AUTO`, `NIFTY`. For a future, its underlying. */
export const TradingSymbol = z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,19}$/, 'must be an uppercase exchange symbol');

const instrumentBase = {
  exchange: Exchange,
  symbol: TradingSymbol,
  /** Display name, e.g. "Tata Steel Ltd". */
  name: z.string().min(1).max(200),
};

export const FutureContract = z.object({
  expiry: IsoDate,
  lotSize: z.number().int().positive(),
});
export type FutureContract = z.infer<typeof FutureContract>;

/**
 * A FUTURE always has contract details; other asset types never do. Strict, so a stray `contract` is rejected
 * rather than silently dropped. API and web deploy together from this monorepo, so strictness can't cause version
 * skew between them.
 */
export const Instrument = z.discriminatedUnion('assetType', [
  z.strictObject({ ...instrumentBase, assetType: z.literal('EQUITY') }),
  z.strictObject({ ...instrumentBase, assetType: z.literal('INDEX') }),
  z.strictObject({ ...instrumentBase, assetType: z.literal('FUTURE'), contract: FutureContract }),
]);
export type Instrument = z.infer<typeof Instrument>;

const KEY_PATTERN = /^(NSE|BSE|NASDAQ|NYSE):([A-Z0-9][A-Z0-9&-]{0,19})(?::FUT:(\d{4}-\d{2}-\d{2}))?$/;

/**
 * Canonical instrument key used across API, DB, and UI.
 * Equity/index: `NSE:TATASTEEL`. Future: `NSE:NIFTY:FUT:2026-10-27` (expiry makes each contract distinct).
 */
export const InstrumentKey = z
  .string()
  .regex(KEY_PATTERN, 'must look like NSE:SYMBOL or NSE:SYMBOL:FUT:YYYY-MM-DD')
  .refine((key) => {
    const expiry = KEY_PATTERN.exec(key)?.[3];
    return expiry === undefined || IsoDate.safeParse(expiry).success;
  }, 'expiry must be a real calendar date')
  .refine((key) => {
    const match = KEY_PATTERN.exec(key);
    // Indian exchange-traded futures only: NSE (e.g. NIFTY) and BSE (e.g. SENSEX).
    return match?.[3] === undefined || match[1] === 'NSE' || match[1] === 'BSE';
  }, 'futures contracts are NSE/BSE-only');
export type InstrumentKey = z.infer<typeof InstrumentKey>;

export function instrumentKey(instrument: Instrument): InstrumentKey {
  const base = `${instrument.exchange}:${instrument.symbol}`;
  return instrument.assetType === 'FUTURE' ? `${base}:FUT:${instrument.contract.expiry}` : base;
}

/** Splits a key that already passed `InstrumentKey`. Returns undefined for anything else. */
export function parseInstrumentKey(
  key: string,
): { exchange: Exchange; symbol: string; futureExpiry: string | undefined } | undefined {
  const match = KEY_PATTERN.exec(key);
  if (!match) return undefined;
  return { exchange: match[1] as Exchange, symbol: match[2] ?? '', futureExpiry: match[3] };
}
