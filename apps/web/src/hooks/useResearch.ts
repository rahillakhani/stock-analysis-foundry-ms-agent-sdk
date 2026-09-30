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
  | { kind: 'analyzing'; instrument: Instrument; instrumentKey: string; runId: string; phase: 'PENDING' | 'RUNNING' }
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
  reset: () => void;
}

export interface ResearchOptions {
  pollIntervalMs?: number;
}

type Action = { type: 'set'; state: ResearchState };

const reducer = (_state: ResearchState, action: Action): ResearchState => action.state;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * Drives the spec's flow: lookup (step 1) -> confirm re-analysis when a record exists -> analyze (202) -> poll the
 * run -> show the result with its timeline. Each operation owns an AbortController; starting a new one cancels
 * the previous, and everything is aborted on unmount.
 */
export function useResearch(api: ApiClient, options: ResearchOptions = {}): [ResearchState, ResearchActions] {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' });
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  // analyze() re-enters lookup when a record appeared meanwhile; a ref breaks the callback cycle.
  const lookupRef = useRef<(query: string) => Promise<void>>(() => Promise.resolve());

  const set = useCallback((next: ResearchState) => {
    stateRef.current = next;
    dispatch({ type: 'set', state: next });
  }, []);

  /** Cancels any in-flight operation and returns a fresh signal for the next one. */
  const begin = useCallback((): AbortSignal => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const showResult = useCallback(
    async (instrument: Instrument, instrumentKey: string, signal: AbortSignal) => {
      // Re-read via lookup so the timeline and age include the run that just finished.
      const lookup = await api.lookup(instrumentKey, signal);
      if (lookup.status !== 'RESOLVED' || !lookup.existing) {
        throw new Error('Completed analysis was not found on lookup');
      }
      const run = lookup.existing.latestRun;
      if (run.status !== 'SUCCEEDED' && run.status !== 'PARTIAL') throw new Error('Unexpected run state');
      set({
        kind: 'result',
        instrument,
        instrumentKey,
        run,
        timeline: lookup.existing.timeline,
        ageSeconds: lookup.existing.ageSeconds,
      });
    },
    [api, set],
  );

  const poll = useCallback(
    async (instrument: Instrument, instrumentKey: string, runId: string, signal: AbortSignal) => {
      for (;;) {
        const run = await api.getRun(runId, signal);
        if (run.status === 'PENDING' || run.status === 'RUNNING') {
          set({ kind: 'analyzing', instrument, instrumentKey, runId, phase: run.status });
          await sleep(pollIntervalMs, signal);
          continue;
        }
        if (run.status === 'FAILED') {
          set({ kind: 'run-failed', instrument, instrumentKey, run });
          return;
        }
        await showResult(instrument, instrumentKey, signal);
        return;
      }
    },
    [api, pollIntervalMs, set, showResult],
  );

  const analyze = useCallback(
    async (instrument: Instrument, instrumentKey: string, force: boolean) => {
      const signal = begin();
      try {
        let runId: string;
        try {
          runId = (await api.analyze(instrumentKey, force, signal)).runId;
        } catch (err) {
          // Someone else already started this analysis: follow it instead of failing.
          if (err instanceof ApiError && err.code === 'RUN_IN_FLIGHT' && err.runId) runId = err.runId;
          else throw err;
        }
        set({ kind: 'analyzing', instrument, instrumentKey, runId, phase: 'PENDING' });
        await poll(instrument, instrumentKey, runId, signal);
      } catch (err) {
        // Our own cancellation (new search, stop waiting, unmount): not an error. Checking the signal is robust across
        // fetch implementations whose AbortError classes differ.
        if (signal.aborted) return;
        // A record appeared since lookup (e.g. another tab): go back through the confirmation.
        if (err instanceof ApiError && err.code === 'ANALYSIS_EXISTS') {
          void lookupRef.current(instrumentKey);
          return;
        }
        set({ kind: 'error', message: describeError(err), retry: 'analyze', instrumentKey });
      }
    },
    [api, begin, poll, set],
  );

  const lookupQuery = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      const signal = begin();
      set({ kind: 'looking-up', query: trimmed });
      try {
        const result = await api.lookup(trimmed, signal);
        if (result.status === 'NOT_FOUND') return set({ kind: 'not-found', query: trimmed });
        if (result.status === 'AMBIGUOUS') {
          return set({ kind: 'ambiguous', query: trimmed, candidates: result.candidates });
        }
        if (result.existing) {
          return set({
            kind: 'confirm',
            instrument: result.instrument,
            instrumentKey: result.instrumentKey,
            existing: result.existing,
          });
        }
        // Spec step 1: no record, so proceed straight to research.
        await analyze(result.instrument, result.instrumentKey, false);
      } catch (err) {
        if (signal.aborted) return;
        set({ kind: 'error', message: describeError(err), retry: 'lookup', query: trimmed });
      }
    },
    [analyze, api, begin, set],
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
      if (current.kind === 'error' && current.retry === 'lookup' && current.query) void lookupQuery(current.query);
      if (current.kind === 'error' && current.retry === 'analyze' && current.instrumentKey) {
        void lookupQuery(current.instrumentKey);
      }
    },
    stopWaiting: () => {
      controllerRef.current?.abort();
      set({ kind: 'idle', notice: 'Stopped waiting. The analysis continues on the server; search again to see it.' });
    },
    reset: () => {
      controllerRef.current?.abort();
      set({ kind: 'idle' });
    },
  };

  return [state, actions];
}
