import {
  currencyFor,
  isIndianExchange,
  type DecisionFactor,
  type Instrument,
  type TimelineEntryView,
} from '@stock-analysis/shared';
import { AlertTriangle, FlaskConical, Globe, RefreshCw } from 'lucide-react';
import type { CompletedRun } from '../hooks/useResearch.ts';
import { DIMENSION_LABEL, formatAge, formatDateTime, formatPrice } from '../lib/format.ts';
import { DecisionBadge } from './DecisionBadge.tsx';
import { Disclaimer } from './Disclaimer.tsx';
import { MetricsGrid } from './MetricsGrid.tsx';
import { TimelineView } from './TimelineView.tsx';

interface Props {
  instrument: Instrument;
  instrumentKey: string;
  run: CompletedRun;
  timeline: TimelineEntryView[];
  ageSeconds: number;
  onReanalyze: () => void;
}

function FactorList({ title, factors, empty }: { title: string; factors: DecisionFactor[]; empty: string }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      {factors.length === 0 ? (
        <p className="text-sm text-ink-3">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-sm text-ink-2">
          {factors.map((factor) => (
            <li key={factor.code} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
              <span>{factor.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One completed analysis. A decision is never shown without its timestamp, confidence, data freshness, source
 * context, and the disclaimer.
 */
export function ResultView({ instrument, instrumentKey, run, timeline, ageSeconds, onReanalyze }: Props) {
  const { decision } = run;
  const synthetic = run.sources.some((source) => source.provider === 'fixture');
  const live = run.sources.some((source) => source.provider === 'yahoo-finance');
  const currency = currencyFor(instrument.exchange);
  const providers = [...new Set(run.sources.map((source) => source.provider))];

  return (
    <article className="space-y-6" aria-label={`Analysis of ${instrument.name}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink">{instrument.name}</h2>
          <p className="font-mono text-sm text-ink-2">{instrumentKey}</p>
        </div>
        <button
          type="button"
          onClick={onReanalyze}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Re-analyse
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <DecisionBadge indicator={decision.indicator} />
        <span className="text-lg font-semibold tabular-nums text-ink">{decision.confidenceScore}% confidence</span>
        <span className="text-sm text-ink-2">
          Analysed <time dateTime={run.completedAt}>{formatDateTime(run.completedAt)}</time> ({formatAge(ageSeconds)}) ·
          policy {decision.policyVersion}
        </span>
      </div>

      {synthetic && (
        <p
          className="flex items-start gap-2 rounded-lg border border-border bg-warning-tint p-3 text-sm text-ink"
          role="note"
        >
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Sample data.</strong> This analysis uses generated demo data, not real
            market data. No market-data provider is connected yet.
          </span>
        </p>
      )}

      {live && (
        <p
          className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3 text-sm text-ink"
          role="note"
        >
          <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Live data from Yahoo Finance</strong> (unofficial, may be delayed).
            Indicators are computed from daily prices; ratios from the latest reported statements.
            {isIndianExchange(instrument.exchange) &&
              ' F&O open interest, promoter pledging, and FII/DII flows are not connected yet, so Indian stocks can be at most NEUTRAL.'}
          </span>
        </p>
      )}

      {run.status === 'PARTIAL' && (
        <p
          className="flex items-start gap-2 rounded-lg border border-border bg-critical-tint p-3 text-sm text-ink"
          role="note"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Partial research.</strong> Unavailable:{' '}
            {run.unavailableDimensions.map((d) => DIMENSION_LABEL[d]).join(', ')}. Missing data lowers confidence and
            never counts in favour of BUY.
          </span>
        </p>
      )}

      <MetricsGrid subscores={decision.subscores} />

      {decision.riskReward && (
        <section aria-label="Risk to reward" className="rounded-lg border border-border p-3 text-sm">
          <h3 className="mb-1 font-semibold text-ink">
            Risk-to-reward (hypothetical long entry): {decision.riskReward.ratio}
          </h3>
          <p className="tabular-nums text-ink-2">
            Entry {formatPrice(decision.riskReward.entry, currency)} · Stop{' '}
            {formatPrice(decision.riskReward.stop, currency)} · Target{' '}
            {formatPrice(decision.riskReward.target, currency)}
          </p>
          <p className="mt-1 text-xs text-ink-3">{decision.riskReward.method}</p>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <FactorList title="Supporting factors" factors={decision.reasons} empty="None." />
        <FactorList title="Risks and missing data" factors={decision.riskFactors} empty="None identified." />
      </div>

      <section aria-label="History">
        <h3 className="mb-3 text-sm font-semibold text-ink">History</h3>
        <TimelineView entries={timeline} currentRunId={run.id} />
      </section>

      <p className="text-xs text-ink-3">
        Sources: {providers.join(', ')} · {run.sources.length} source{run.sources.length === 1 ? '' : 's'} cited
      </p>
      <Disclaimer />
    </article>
  );
}
