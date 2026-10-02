import type { Watchlist } from '@stock-analysis/shared';
import { useCallback, useState } from 'react';
import { describeError, type ApiClient } from '../api/client.ts';
import { usePolled, type Polled } from './usePolled.ts';

export interface WatchlistState extends Polled<Watchlist> {
  isPinned(instrumentKey: string): boolean;
  /** The key being pinned or unpinned right now, if any. */
  busyKey: string | undefined;
  /** The last pin/unpin failure, as a user-facing message. */
  actionError: string | undefined;
  toggle(instrumentKey: string): void;
}

const REFRESH_MS = 30_000;

/**
 * The watchlist, shared by the pin button and the watchlist panel. A pin/unpin shows its result at once (the API
 * answers with the updated list's membership) and then reloads the list for prices and analyses.
 */
export function useWatchlist(api: ApiClient, refreshMs = REFRESH_MS): WatchlistState {
  const load = useCallback((signal: AbortSignal) => api.watchlist(signal), [api]);
  const polled = usePolled(load, refreshMs, 'watchlist');
  // Membership from the latest pin/unpin response, until a later reload replaces it.
  const [confirmed, setConfirmed] = useState<{ list: Watchlist; basis: Watchlist | undefined } | undefined>();
  const [busyKey, setBusyKey] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const { data, reload } = polled;

  // A response newer than the polled data wins until the poll moves on.
  const current = confirmed && confirmed.basis === data ? confirmed.list : data;
  const isPinned = useCallback(
    (key: string) => current?.items.some((item) => item.instrumentKey === key) ?? false,
    [current],
  );

  const toggle = useCallback(
    (key: string) => {
      const pinned = isPinned(key);
      setBusyKey(key);
      setActionError(undefined);
      (pinned ? api.unpin(key) : api.pin(key)).then(
        (list) => {
          setConfirmed({ list, basis: data });
          setBusyKey(undefined);
          reload();
        },
        (err: unknown) => {
          setActionError(describeError(err));
          setBusyKey(undefined);
        },
      );
    },
    [api, data, isPinned, reload],
  );

  return { ...polled, data: current, isPinned, busyKey, actionError, toggle };
}
