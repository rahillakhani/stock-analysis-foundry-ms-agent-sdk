import type { Watchlist } from '@stock-analysis/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { watchlistWith } from '../test/fixtures.ts';
import { useWatchlist } from './useWatchlist.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function stubApi(overrides: Partial<ApiClient>): ApiClient {
  return overrides as ApiClient;
}

describe('useWatchlist', () => {
  it('shows a confirmed pin even when a poll with the old list lands while the request is in flight', async () => {
    let server: Watchlist = watchlistWith();
    const put = deferred<Watchlist>();
    const api = stubApi({ watchlist: vi.fn(() => Promise.resolve(server)), pin: vi.fn(() => put.promise) });
    const { result } = renderHook(() => useWatchlist(api, 10));
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => result.current.toggle('NSE:TATASTEEL'));
    expect(result.current.isBusy('NSE:TATASTEEL')).toBe(true);
    // Several polls (still without the pin) land before the PUT answers.
    await new Promise((r) => setTimeout(r, 40));
    server = watchlistWith('NSE:TATASTEEL');
    await act(async () => {
      put.resolve(server);
      await put.promise;
    });

    expect(result.current.isPinned('NSE:TATASTEEL')).toBe(true);
    expect(result.current.isBusy('NSE:TATASTEEL')).toBe(false);
  });

  it('ignores an older response that arrives after a newer one', async () => {
    const first = deferred<Watchlist>();
    const second = deferred<Watchlist>();
    const pin = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = stubApi({ watchlist: vi.fn(() => new Promise<Watchlist>(() => undefined)), pin });
    const { result } = renderHook(() => useWatchlist(api, null));

    act(() => result.current.toggle('NSE:AAA'));
    act(() => result.current.toggle('NSE:BBB'));
    expect(result.current.isBusy('NSE:AAA') && result.current.isBusy('NSE:BBB')).toBe(true);

    await act(async () => {
      second.resolve(watchlistWith('NSE:AAA', 'NSE:BBB'));
      await second.promise;
    });
    await act(async () => {
      first.resolve(watchlistWith('NSE:AAA'));
      await first.promise;
    });
    expect(result.current.isPinned('NSE:BBB')).toBe(true);
    expect(result.current.isBusy('NSE:AAA')).toBe(false);
  });

  it('reports a failure and clears it after the next success', async () => {
    const pin = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(watchlistWith('NSE:AAA'));
    const api = stubApi({ watchlist: vi.fn(() => Promise.resolve(watchlistWith())), pin });
    const { result } = renderHook(() => useWatchlist(api, 60_000));
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => result.current.toggle('NSE:AAA'));
    await waitFor(() =>
      expect(result.current.actionError).toBe('Could not reach the server. Check that the API is running.'),
    );
    act(() => result.current.toggle('NSE:AAA'));
    await waitFor(() => expect(result.current.actionError).toBeUndefined());
  });
});
