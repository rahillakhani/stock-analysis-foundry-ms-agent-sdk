import { useCallback, useEffect, useState } from 'react';

export interface Polled<T> {
  /** The latest successful result for the current `resetKey` (kept while refreshing, and after a failed refresh). */
  data: T | undefined;
  /** The latest failure, cleared by the next success. */
  error: unknown;
  /** True until the first result (or failure) for the current `resetKey`. */
  loading: boolean;
  /** Loads again now (e.g. a Retry button). */
  reload: () => void;
}

interface Slot<T> {
  resetKey: string;
  data?: T;
  error?: unknown;
  settled: boolean;
}

/**
 * Loads now and then every `intervalMs` (null: load once), skipping ticks while the tab is hidden. A new `load`
 * function reloads immediately; a new `resetKey` also discards the previous data so a different subject (another
 * stock, another interval) never shows stale values. In-flight requests are aborted on change and unmount.
 */
export function usePolled<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  resetKey: string,
): Polled<T> {
  const [slot, setSlot] = useState<Slot<T>>({ resetKey, settled: false });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let controller: AbortController | undefined;
    const run = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      load(current.signal).then(
        (data) => {
          if (!current.signal.aborted) setSlot({ resetKey, data, settled: true });
        },
        (error: unknown) => {
          if (current.signal.aborted) return;
          setSlot((prev) => ({
            resetKey,
            data: prev.resetKey === resetKey ? prev.data : undefined,
            error,
            settled: true,
          }));
        },
      );
    };
    run();
    const timer =
      intervalMs === null
        ? undefined
        : setInterval(() => {
            if (!document.hidden) run();
          }, intervalMs);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [load, intervalMs, resetKey, attempt]);

  const fresh = slot.resetKey === resetKey;
  return {
    data: fresh ? slot.data : undefined,
    error: fresh ? slot.error : undefined,
    loading: !fresh || !slot.settled,
    reload,
  };
}
