import type { AnalysedStock } from '@stock-analysis/shared';
import { Loader2 } from 'lucide-react';
import { useCallback } from 'react';
import { describeError, type ApiClient } from '../api/client.ts';
import { usePolled } from '../hooks/usePolled.ts';
import { ageSince, formatAge, formatDateTime } from '../lib/format.ts';
import { DecisionBadge } from './DecisionBadge.tsx';

interface Props {
  api: ApiClient;
  onSelect: (instrumentKey: string) => void;
  /** Changes whenever an analysis completes, so the list picks up the new or updated stock at once. */
  refreshToken?: string;
  refreshMs?: number;
}

const REFRESH_MS = 60_000;

/** Right column: stocks analysed before, newest first, each with its latest signal. Selecting one looks it up. */
export function RecentStocks({ api, onSelect, refreshToken = '', refreshMs = REFRESH_MS }: Props) {
  // refreshToken is part of the loader identity so a new token reloads immediately (keeping the current list).
  const load = useCallback((signal: AbortSignal) => api.stocks(signal), [api, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = usePolled(load, refreshMs, 'stocks');

  return (
    <section aria-labelledby="recent-heading" className="rounded-lg border border-border p-4 text-sm">
      <h2 id="recent-heading" className="font-semibold text-ink">
        Searched stocks
      </h2>

      {loading && !data && (
        <p className="mt-3 flex items-center gap-2 text-ink-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {!loading && !data && (
        <div className="mt-3" role="alert">
          <p className="text-ink-2">{describeError(error)}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-2 rounded-md border border-border px-3 py-1 text-ink hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      )}

      {data?.length === 0 && (
        <p className="mt-2 text-ink-3">Stocks you analyse appear here with their latest signal.</p>
      )}

      {data && data.length > 0 && (
        <>
          {error !== undefined && <p className="mt-2 text-xs text-ink-3">Could not refresh; showing the last list.</p>}
          <ul className="mt-2 space-y-1">
            {data.map((stock) => (
              <li key={stock.instrumentKey}>
                <StockRow stock={stock} onSelect={onSelect} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">
            Signals are as of each stock&apos;s last analysis. Not investment advice.
          </p>
        </>
      )}
    </section>
  );
}

function StockRow({ stock, onSelect }: { stock: AnalysedStock; onSelect: (key: string) => void }) {
  const age = formatAge(ageSince(stock.lastAnalysedAt));
  return (
    <button
      type="button"
      onClick={() => onSelect(stock.instrumentKey)}
      className="w-full rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-ink">{stock.name}</span>
        <DecisionBadge indicator={stock.indicator} size="sm" />
      </span>
      <span className="mt-0.5 flex justify-between gap-2 text-xs text-ink-3">
        <span className="font-mono">{stock.instrumentKey}</span>
        <span>
          {stock.confidenceScore}% confidence ·{' '}
          <time dateTime={stock.lastAnalysedAt} title={formatDateTime(stock.lastAnalysedAt)}>
            {age}
          </time>
        </span>
      </span>
    </button>
  );
}
