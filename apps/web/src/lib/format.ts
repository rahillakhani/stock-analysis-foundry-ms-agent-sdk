const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return 'just now';
  for (const [unit, seconds] of UNITS) {
    if (ageSeconds >= seconds) return relative.format(-Math.floor(ageSeconds / seconds), unit);
  }
  return 'just now';
}

/** Seconds between an ISO timestamp and now (never negative). */
export function ageSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
}

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** Price in the listing's currency, e.g. ₹1,23,715.00 or $47.76. */
export function formatPrice(value: number, currency: 'INR' | 'USD' = 'INR'): string {
  return value.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const INDICATOR_LABEL = { BUY: 'BUY', DONT_BUY: "DON'T BUY", NEUTRAL: 'NEUTRAL' } as const;

export const DIMENSION_LABEL = {
  fundamentals: 'Fundamentals',
  technicals: 'Technicals',
  derivatives: 'F&O',
  sentiment: 'Sentiment',
} as const;

/** "+1.40%" / "-1.40%" (the sign is always shown so direction never depends on colour). */
export function formatPercent(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
}

/** "+1,755.00" / "−1,755.00": a price change without a currency symbol. */
export function formatSignedPrice(value: number): string {
  const magnitude = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${magnitude}`;
}

export const MARKET_STATE_LABEL = {
  PRE: 'Pre-open',
  REGULAR: 'Market open',
  POST: 'Market closed (post-close session)',
  CLOSED: 'Market closed',
} as const;
