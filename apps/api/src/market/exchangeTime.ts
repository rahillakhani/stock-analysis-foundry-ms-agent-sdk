import { timeZoneFor, type Exchange } from '@stock-analysis/shared';

/** Calendar date (YYYY-MM-DD) of an instant in the exchange's own time zone. */
export function exchangeDate(instant: Date, exchange: Exchange): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZoneFor(exchange),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
