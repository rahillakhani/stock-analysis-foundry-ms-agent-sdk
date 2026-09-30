import { z } from 'zod';

/**
 * UTC timestamp in exactly the `Date#toISOString()` format (`2026-09-30T10:00:00.000Z`). One spelling per instant
 * keeps stored output byte-identical and makes string comparison match time order.
 */
export const IsoDateTime = z.iso.datetime({ precision: 3 });

/** Calendar date `YYYY-MM-DD` (e.g. a futures expiry). */
export const IsoDate = z.iso.date();

/** Percentage on a 0–100 scale (holdings, pledging, RSI-style bounded values). */
export const Percent0To100 = z.number().min(0).max(100);

/** Score on a 0–100 scale produced by the decision engine. */
export const Score = z.number().min(0).max(100);

/** True when every element is strictly greater than the previous one (sorted, no duplicates). */
export function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

/** True when no element appears twice. */
export function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
