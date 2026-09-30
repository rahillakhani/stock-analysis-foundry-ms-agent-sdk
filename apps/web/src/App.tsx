import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { createApiClient, type ApiClient } from './api/client.ts';
import { ReAnalyzeModal } from './components/ReAnalyzeModal.tsx';
import { ResultView } from './components/ResultView.tsx';
import { SearchBar } from './components/SearchBar.tsx';
import { useResearch, type ResearchState } from './hooks/useResearch.ts';

interface Props {
  api?: ApiClient;
  pollIntervalMs?: number;
  searchDebounceMs?: number;
}

const panel = 'rounded-lg border border-border p-4 text-sm';

const PHASE_LABEL = { STARTING: 'Starting analysis of', PENDING: 'Queued:', RUNNING: 'Researching' } as const;

/** One short screen-reader announcement per state change (the whole result isn't re-read). */
function announcement(state: ResearchState): string {
  switch (state.kind) {
    case 'looking-up':
      return `Looking up ${state.query}`;
    case 'analyzing':
      return `Analysing ${state.instrument.name}`;
    case 'result':
      return `Analysis ready for ${state.instrument.name}`;
    case 'not-found':
      return `No match for ${state.query}`;
    case 'ambiguous':
      return `${state.candidates.length} possible matches`;
    case 'confirm':
      return `An analysis of ${state.instrument.name} already exists`;
    case 'run-failed':
    case 'error':
      return 'The request failed';
    case 'idle':
      return state.notice ?? '';
  }
}

export function App({ api: injected, pollIntervalMs, searchDebounceMs }: Props) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const [state, actions] = useResearch(api, { pollIntervalMs });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Stock &amp; Futures Research</h1>
        <p className="text-sm text-ink-2">
          Search an NSE/BSE stock, index, or futures contract to see a rule-based BUY / DON&apos;T BUY / NEUTRAL signal
          with its reasons.
        </p>
      </header>

      <SearchBar api={api} onSubmit={actions.lookup} debounceMs={searchDebounceMs} />

      <p className="sr-only" role="status" aria-live="polite">
        {announcement(state)}
      </p>

      <main className="mt-6">
        {state.kind === 'idle' && state.notice && <p className={panel}>{state.notice}</p>}

        {state.kind === 'looking-up' && (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Looking up “{state.query}”…
          </p>
        )}

        {state.kind === 'not-found' && (
          <p className={panel}>
            No instrument matches “{state.query}”. Try a symbol like TATASTEEL or a company name like Tata Steel.
          </p>
        )}

        {state.kind === 'ambiguous' && (
          <section className={panel} aria-label="Did you mean">
            <h2 className="mb-2 font-semibold text-ink">
              {state.candidates.length === 1 ? 'Did you mean' : 'Several instruments match'} “{state.query}”?
            </h2>
            <ul className="space-y-1">
              {state.candidates.map((candidate) => (
                <li key={candidate.key}>
                  <button
                    type="button"
                    onClick={() => actions.lookup(candidate.key)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <span className="text-ink">{candidate.name}</span>{' '}
                    <span className="font-mono text-xs text-ink-2">{candidate.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.kind === 'analyzing' && (
          <section className={panel} aria-label="Analysis in progress">
            <p className="flex items-center gap-2 text-ink">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              {PHASE_LABEL[state.phase]} {state.instrument.name}…
            </p>
            <p className="mt-1 text-xs text-ink-3">
              Gathering fundamentals, technicals, F&amp;O data, and sentiment, then applying the decision rules.
            </p>
            <button
              type="button"
              onClick={actions.stopWaiting}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
            >
              Stop waiting
            </button>
          </section>
        )}

        {state.kind === 'run-failed' && (
          <section className={panel} role="alert">
            <p className="font-semibold text-ink">The analysis of {state.instrument.name} failed.</p>
            <p className="mt-1 text-ink-2">{state.run.error.message}</p>
            <button
              type="button"
              onClick={actions.reanalyze}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              Try again
            </button>
          </section>
        )}

        {state.kind === 'error' && (
          <section className={panel} role="alert">
            <p className="text-ink">{state.message}</p>
            <button
              type="button"
              onClick={actions.retry}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              Retry
            </button>
          </section>
        )}

        {state.kind === 'result' && (
          <ResultView
            instrument={state.instrument}
            instrumentKey={state.instrumentKey}
            run={state.run}
            timeline={state.timeline}
            ageSeconds={state.ageSeconds}
            onReanalyze={actions.reanalyze}
          />
        )}

        {state.kind === 'confirm' && (
          <ReAnalyzeModal
            open
            name={state.instrument.name}
            ageSeconds={state.existing.ageSeconds}
            latestRun={state.existing.latestRun}
            onViewExisting={actions.viewExisting}
            onReanalyze={actions.reanalyze}
          />
        )}
      </main>
    </div>
  );
}
