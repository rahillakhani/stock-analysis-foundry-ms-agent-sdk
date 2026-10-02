import type { Watchlist } from '@stock-analysis/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, type ApiClient } from '../api/client.ts';
import { usePolled, type Polled } from './usePolled.ts';

export interface WatchlistState extends Polled<Watchlist> {
  isPinned(instrumentKey: string): boolean;
  isBusy(instrumentKey: string): boolean;
  /** The last pin/unpin failure, as a user-facing message, and its key (cleared by the next success). */
  actionError: { key: string; message: string } | undefined;
  toggle(instrumentKey: string): void;
}

const REFRESH_MS = 30_000;

/**
 * The watchlist, shared by the pin button and the watchlist panel. A pin/unpin response (the whole updated list)
 * is shown at once and then replaced by a fresh load, which also brings prices and analyses.
 *
 * Ordering: the list from the latest *sent* request that has answered wins; an older response arriving later is
 * ignored. A confirmed list stays until polled data newer than that response arrives; reload() aborts any poll
 * that was already in flight, so a stale poll can't overwrite it.
 */
export function useWatchlist(api: ApiClient, refreshMs: number | null = REFRESH_MS): WatchlistState {
  const load = useCallback((signal: AbortSignal) => api.watchlist(signal), [api]);
  const polled = usePolled(load, refreshMs, 'watchlist');
  const { data, reload } = polled;

  const latestData = useRef(data);
  useEffect(() => {
    latestData.current = data;
  }, [data]);
  const sent = useRef(0);
  const applied = useRef(0);

  const [confirmed, setConfirmed] = useState<{ list: Watchlist; basis: Watchlist | undefined } | undefined>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<WatchlistState['actionError']>();

  const current = confirmed && confirmed.basis === data ? confirmed.list : data;
  const isPinned = useCallback(
    (key: string) => current?.items.some((item) => item.instrumentKey === key) ?? false,
    [current],
  );
  const isBusy = useCallback((key: string) => busy.has(key), [busy]);

  const toggle = useCallback(
    (key: string) => {
      const request = (sent.current += 1);
      const done = () =>
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      setBusy((prev) => new Set(prev).add(key));
      (isPinned(key) ? api.unpin(key) : api.pin(key)).then(
        (list) => {
          done();
          if (request < applied.current) return;
          applied.current = request;
          setActionError(undefined);
          setConfirmed({ list, basis: latestData.current });
          reload();
        },
        (err: unknown) => {
          done();
          setActionError({ key, message: describeError(err) });
        },
      );
    },
    [api, isPinned, reload],
  );

  return { ...polled, data: current, isPinned, isBusy, actionError, toggle };
}
