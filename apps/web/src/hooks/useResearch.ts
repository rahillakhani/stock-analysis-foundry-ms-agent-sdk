import type {
  AnalysisRunView,
  Instrument,
  InstrumentSummary,
  LookupResponse,
  TimelineEntryView,
} from '@stock-analysis/shared';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError, describeError, type ApiClient } from '../api/client.ts';

type Existing = NonNullable<Extract<LookupResponse, { status: 'RESOLVED' }>['existing']>;
export type CompletedRun = Extract<AnalysisRunView, { status: 'SUCCEEDED' | 'PARTIAL' }>;
export type FailedRun = Extract<AnalysisRunView, { status: 'FAILED' }>;

/** Every screen the research flow can be on. Exactly one at a time, so impossible combinations can't render. */
export type ResearchState =
  | { kind: 'idle'; notice?: string }
  | { kind: 'looking-up'; query: string }
  | { kind: 'not-found'; query: string }
  | { kind: 'ambiguous'; query: string; candidates: InstrumentSummary[] }
  | { kind: 'confirm'; instrument: Instrument; instrumentKey: string; existing: Existing }
  | {
      kind: 'analyzing';
      instrument: Instrument;
      instrumentKey: string;
      /** STARTING until the API has accepted the run. */
      phase: 'STARTING' | 'PENDING' | 'RUNNING';
      runId?: string;
    }
  | {
      kind: 'result';
      instrument: Instrument;
      instrumentKey: string;
      run: CompletedRun;
      timeline: TimelineEntryView[];
      ageSeconds: number;
    }
  | { kind: 'run-failed'; instrument: Instrument; instrumentKey: string; run: FailedRun }
  | { kind: 'error'; message: string; retry: 'lookup' | 'analyze'; query?: string; instrumentKey?: string };

export interface ResearchActions {
  lookup: (query: string) => void;
  viewExisting: () => void;
  reanalyze: () => void;
  retry: () => void;
  stopWaiting: () => void;
}

export interface ResearchOptions {
  /** First poll delay; later polls back off ×1.5 up to maxPollIntervalMs. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Give up waiting (the server keeps running) after this long. */
  maxWaitMs?: number;
  /** Consecutive failed polls tolerated (network blips, 5xx) before showing an error. */
  maxPollErrors?: number;
}

const reducer = (_state: ResearchState, next: ResearchState): ResearchState => next;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Poll failures worth retrying: network errors and server-side (5xx) errors. */
const isTransient = (err: unknown) => !(err instanceof ApiError) || err.status >= 500;

/**
 * Drives the spec's flow: lookup (step 1) -> confirm re-analysis when a record exists -> analyze (202) -> poll the
 * run -> show the result with its timeline. Each operation owns an AbortController; starting a new one cancels the
 * previous, everything is aborted on unmount, and every state update is dropped once its operation was cancelled,
 * so a stale response can never overwrite newer state.
 */
export function useResearch(api: ApiClient, options: ResearchOptions = {}): [ResearchState, ResearchActions] {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 5000;
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  const maxPollErrors = options.maxPollErrors ?? 3;
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' });
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  // analyze() re-enters lookup when a record appeared meanwhile; a ref breaks the callback cycle.
  const lookupRef = useRef<(query: string) => Promise<void>>(() => Promise.resolve());

  const set = useCallback((next: ResearchState) => {
    stateRef.current = next;
    dispatch(next);
  }, []);

  /** Cancels any in-flight operation and returns a state setter bound to the new operation. */
  const begin = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const update = (next: ResearchState) => {
      if (!signal.aborted) set(next);
    };
    return { signal, update };
  }, [set]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const analyze = useCallback(
    async (instrument: Instrument, instrumentKey: string, force: boolean) => {
      const { signal, update } = begin();
      // Leave the previous screen immediately: never show old data while a new analysis starts.
      update({ kind: 'analyzing', instrument, instrumentKey, phase: 'STARTING' });
      try {
        let runId: string;
        try {
          runId = (await api.analyze(instrumentKey, force, signal)).runId;
        } catch (err) {
          // Someone else already started this analysis: follow it instead of failing.
          if (err instanceof ApiError && err.code === 'RUN_IN_FLIGHT' && err.runId) runId = err.runId;
          else throw err;
        }

        const deadline = Date.now() + maxWaitMs;
        let delay = pollIntervalMs;
        let pollErrors = 0;
        for (;;) {
          let run: AnalysisRunView;
          try {
            run = await api.getRun(runId, signal);
            pollErrors = 0;
          } catch (err) {
            if (signal.aborted || !isTransient(err) || ++pollErrors >= maxPollErrors) throw err;
            await sleep(delay, signal);
            continue;
          }
          if (run.status === 'FAILED') return update({ kind: 'run-failed', instrument, instrumentKey, run });
          if (run.status === 'SUCCEEDED' || run.status === 'PARTIAL') break;
          update({ kind: 'analyzing', instrument, instrumentKey, runId, phase: run.status });
          if (Date.now() + delay > deadline) {
            return update({
              kind: 'idle',
              notice: 'This analysis is taking longer than expected. It continues on the server; search again later.',
            });
          }
          await sleep(delay, signal);
          delay = Math.min(maxPollIntervalMs, Math.round(delay * 1.5));
        }

        // Re-read via lookup so the timeline and age include the run that just finished.
        const lookup = await api.lookup(instrumentKey, signal);
        const run = lookup.status === 'RESOLVED' ? lookup.existing?.latestRun : undefined;
        if (lookup.status !== 'RESOLVED' || !lookup.existing || !run || !('decision' in run)) {
          throw new Error('Completed analysis was not found on lookup');
        }
        update({
          kind: 'result',
          instrument,
          instrumentKey,
          run,
          timeline: lookup.existing.timeline,
          ageSeconds: lookup.existing.ageSeconds,
        });
      } catch (err) {
        // Our own cancellation (new search, stop waiting, unmount) is not an error. Checking the signal is robust
        // across fetch implementations whose AbortError classes differ.
        if (signal.aborted) return;
        // A record appeared since lookup (e.g. another tab): go back through the confirmation.
        if (err instanceof ApiError && err.code === 'ANALYSIS_EXISTS') {
          void lookupRef.current(instrumentKey);
          return;
        }
        update({ kind: 'error', message: describeError(err), retry: 'analyze', instrumentKey });
      }
    },
    [api, begin, maxPollErrors, maxPollIntervalMs, maxWaitMs, pollIntervalMs],
  );

  const lookupQuery = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      const { signal, update } = begin();
      update({ kind: 'looking-up', query: trimmed });
      try {
        const result = await api.lookup(trimmed, signal);
        if (result.status === 'NOT_FOUND') return update({ kind: 'not-found', query: trimmed });
        if (result.status === 'AMBIGUOUS') {
          return update({ kind: 'ambiguous', query: trimmed, candidates: result.candidates });
        }
        if (result.existing) {
          return update({
            kind: 'confirm',
            instrument: result.instrument,
            instrumentKey: result.instrumentKey,
            existing: result.existing,
          });
        }
        // Spec step 1: no record, so proceed straight to research (analyze starts its own operation).
        if (!signal.aborted) await analyze(result.instrument, result.instrumentKey, false);
      } catch (err) {
        if (signal.aborted) return;
        update({ kind: 'error', message: describeError(err), retry: 'lookup', query: trimmed });
      }
    },
    [analyze, api, begin],
  );

  useEffect(() => {
    lookupRef.current = lookupQuery;
  }, [lookupQuery]);

  const actions: ResearchActions = {
    lookup: (query) => void lookupQuery(query),
    viewExisting: () => {
      const current = stateRef.current;
      if (current.kind !== 'confirm') return;
      const run = current.existing.latestRun;
      if (run.status !== 'SUCCEEDED' && run.status !== 'PARTIAL') return;
      set({
        kind: 'result',
        instrument: current.instrument,
        instrumentKey: current.instrumentKey,
        run,
        timeline: current.existing.timeline,
        ageSeconds: current.existing.ageSeconds,
      });
    },
    reanalyze: () => {
      const current = stateRef.current;
      if (current.kind === 'confirm' || current.kind === 'result' || current.kind === 'run-failed') {
        void analyze(current.instrument, current.instrumentKey, true);
      }
    },
    retry: () => {
      const current = stateRef.current;
      if (current.kind !== 'error') return;
      const target = current.retry === 'lookup' ? current.query : current.instrumentKey;
      if (target) void lookupQuery(target);
    },
    stopWaiting: () => {
      controllerRef.current?.abort();
      set({ kind: 'idle', notice: 'Stopped waiting. The analysis continues on the server; search again to see it.' });
    },
  };

  return [state, actions];
}
