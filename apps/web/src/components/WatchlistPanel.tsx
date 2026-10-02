import type { WatchlistItem } from '@stock-analysis/shared';
import { Loader2, Minus, Star, TrendingDown, TrendingUp, X } from 'lucide-react';
import type { WatchlistState } from '../hooks/useWatchlist.ts';
import { describeError } from '../api/client.ts';
import { cn } from '../lib/cn.ts';
import { ageSince, formatAge, formatDateTime, formatPercent, formatPrice } from '../lib/format.ts';
import { CollapsiblePanel, PANEL_PREVIEW_ITEMS, useViewMore } from './CollapsiblePanel.tsx';
import { DecisionBadge } from './DecisionBadge.tsx';

interface Props {
  watchlist: WatchlistState;
  onSelect: (instrumentKey: string) => void;
  /** The instrument whose pin button is on screen: its errors are shown there instead. */
  viewingKey?: string | undefined;
}

const NO_ITEMS: readonly WatchlistItem[] = [];

/** Right column, top: pinned instruments with live price and latest signal. */
export function WatchlistPanel({ watchlist, onSelect, viewingKey }: Props) {
  const { data, error, loading, reload, actionError } = watchlist;
  const { visible, button, listId } = useViewMore(data?.items ?? NO_ITEMS, PANEL_PREVIEW_ITEMS);

  return (
    <CollapsiblePanel storageKey="watchlist" title="Watchlist" icon={<Star aria-hidden="true" className="size-4" />}>
      {actionError && actionError.key !== viewingKey && (
        <p role="alert" className="text-xs text-ink-2">
          {actionError.message}
        </p>
      )}

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

      {data?.items.length === 0 && (
        <p className="mt-2 text-ink-3">Pin a stock with “Pin to watchlist” above its chart to follow it here.</p>
      )}

      {data && data.items.length > 0 && (
        <>
          {error !== undefined && <p className="mt-2 text-xs text-ink-3">Could not refresh; showing the last list.</p>}
          <ul id={listId} className="mt-2 space-y-1">
            {visible.map((item) => (
              <li key={item.instrumentKey} className="flex items-start gap-1">
                <WatchRow item={item} onSelect={onSelect} />
                <button
                  type="button"
                  onClick={() => watchlist.toggle(item.instrumentKey)}
                  disabled={watchlist.isBusy(item.instrumentKey)}
                  aria-label={`Unpin ${item.name}`}
                  title="Unpin"
                  className="mt-0.5 rounded p-2.5 text-ink-3 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {button}
          {data.items.some((i) => i.latest) && (
            <p className="mt-3 text-xs text-ink-3">
              Signals are as of each stock&apos;s last analysis. Not investment advice.
            </p>
          )}
        </>
      )}
    </CollapsiblePanel>
  );
}

function WatchRow({ item, onSelect }: { item: WatchlistItem; onSelect: (key: string) => void }) {
  const { quote, latest } = item;
  const direction = !quote ? undefined : quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'unchanged';
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.instrumentKey)}
      disabled={item.expired}
      className="min-w-0 flex-1 rounded-md disabled:cursor-default disabled:opacity-60 px-1.5 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-ink">{item.name}</span>
        {quote && (
          <span className="shrink-0 tabular-nums text-ink">
            {formatPrice(quote.price, quote.currency === 'USD' ? 'USD' : 'INR')}
          </span>
        )}
      </span>
      <span className="flex items-center justify-between gap-2 text-xs text-ink-3">
        <span className="font-mono break-all">{item.instrumentKey}</span>
        {quote && direction && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-0.5 font-medium tabular-nums',
              { up: 'text-up', down: 'text-down', unchanged: 'text-ink-2' }[direction],
            )}
          >
            <Icon aria-hidden="true" className="size-3" />
            {formatPercent(quote.changePct)}
            <span className="sr-only">{direction} today</span>
          </span>
        )}
      </span>
      {item.expired ? (
        <span className="mt-1 block text-xs text-ink-2">Contract expired. Unpin it.</span>
      ) : latest ? (
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
          <DecisionBadge indicator={latest.indicator} size="sm" />
          <span>
            {latest.confidenceScore}% confidence · policy {latest.policyVersion}
            {latest.runStatus === 'PARTIAL' ? ' · partial data' : ''} ·{' '}
            <time dateTime={latest.lastAnalysedAt} title={formatDateTime(latest.lastAnalysedAt)}>
              {formatAge(ageSince(latest.lastAnalysedAt))}
            </time>
          </span>
        </span>
      ) : (
        <span className="mt-1 block text-xs text-ink-3">Not analysed yet</span>
      )}
    </button>
  );
}

/** Pin/unpin toggle for the instrument being viewed. */
export function PinButton({
  watchlist,
  instrumentKey,
  name,
}: {
  watchlist: WatchlistState;
  instrumentKey: string;
  name: string;
}) {
  const pinned = watchlist.isPinned(instrumentKey);
  const busy = watchlist.isBusy(instrumentKey);
  const failure = watchlist.actionError?.key === instrumentKey ? watchlist.actionError.message : undefined;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => watchlist.toggle(instrumentKey)}
        disabled={busy || (watchlist.loading && !watchlist.data)}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${name} from watchlist` : `Pin ${name} to watchlist`}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Star aria-hidden="true" className={cn('size-4', pinned && 'fill-current')} />
        )}
        {pinned ? 'Pinned' : 'Pin to watchlist'}
      </button>
      {failure && (
        <p role="alert" className="text-xs text-ink-2">
          {failure}
        </p>
      )}
    </div>
  );
}
