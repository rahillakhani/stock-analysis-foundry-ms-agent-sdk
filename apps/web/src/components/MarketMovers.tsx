import type { Mover } from '@stock-analysis/shared';
import { Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback } from 'react';
import { describeMarketError, type ApiClient } from '../api/client.ts';
import { usePolled } from '../hooks/usePolled.ts';
import { cn } from '../lib/cn.ts';
import { formatDateTime, formatPercent, formatPrice, MARKET_STATE_LABEL } from '../lib/format.ts';

interface Props {
  api: ApiClient;
  onSelect: (instrumentKey: string) => void;
  refreshMs?: number;
}

const REFRESH_MS = 60_000;

/** Left column: the day's top NIFTY 50 gainers and losers. Selecting one looks it up. */
export function MarketMovers({ api, onSelect, refreshMs = REFRESH_MS }: Props) {
  const load = useCallback((signal: AbortSignal) => api.movers(signal), [api]);
  const { data, error, loading, reload } = usePolled(load, refreshMs, 'movers');

  return (
    <section aria-labelledby="movers-heading" className="rounded-lg border border-border p-4 text-sm">
      <h2 id="movers-heading" className="font-semibold text-ink">
        Top movers in India
      </h2>
      {data ? (
        <p className="mt-0.5 text-xs text-ink-3">
          {data.universe} · {MARKET_STATE_LABEL[data.marketState]} · as of {formatDateTime(data.asOf)}
        </p>
      ) : null}

      {loading && !data && (
        <p className="mt-3 flex items-center gap-2 text-ink-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Loading movers…
        </p>
      )}

      {!loading && !data && (
        <div className="mt-3" role="alert">
          <p className="text-ink-2">{describeMarketError(error)}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-2 rounded-md border border-border px-3 py-1 text-ink hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          {error !== undefined && <p className="mt-2 text-xs text-ink-3">Could not refresh; showing the last data.</p>}
          <MoverList title="Top gainers" movers={data.gainers} direction="up" onSelect={onSelect} />
          <MoverList title="Top losers" movers={data.losers} direction="down" onSelect={onSelect} />
        </>
      )}
    </section>
  );
}

function MoverList({
  title,
  movers,
  direction,
  onSelect,
}: {
  title: string;
  movers: Mover[];
  direction: 'up' | 'down';
  onSelect: (instrumentKey: string) => void;
}) {
  const Icon = direction === 'up' ? TrendingUp : TrendingDown;
  return (
    <section aria-label={title} className="mt-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">
        <Icon aria-hidden="true" className={cn('size-3.5', direction === 'up' ? 'text-up' : 'text-down')} />
        {title}
      </h3>
      {movers.length === 0 ? (
        <p className="text-xs text-ink-3">None today.</p>
      ) : (
        <ol>
          {movers.map((mover) => (
            <li key={mover.instrumentKey}>
              <button
                type="button"
                onClick={() => onSelect(mover.instrumentKey)}
                aria-label={`${mover.name}, ${formatPercent(mover.changePct)}. Look up`}
                className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{mover.symbol}</span>
                  <span className="block truncate text-xs text-ink-3">{mover.name}</span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-ink">{formatPrice(mover.price)}</span>
                  <span className={cn('block text-xs font-medium', direction === 'up' ? 'text-up' : 'text-down')}>
                    {formatPercent(mover.changePct)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
