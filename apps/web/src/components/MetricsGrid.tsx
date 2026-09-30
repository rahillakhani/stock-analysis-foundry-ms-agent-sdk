import type { DecisionResult } from '@stock-analysis/shared';

const ROWS: { key: keyof DecisionResult['subscores']; label: string }[] = [
  { key: 'fundamental', label: 'Fundamentals' },
  { key: 'technical', label: 'Technicals' },
  { key: 'derivatives', label: 'F&O' },
  { key: 'sentiment', label: 'Sentiment' },
];

/** Section subscores (0–100) as single-hue meters with the value in text; F&O shows N/A without a contract. */
export function MetricsGrid({ subscores }: { subscores: DecisionResult['subscores'] }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {ROWS.map(({ key, label }) => {
        const value = subscores[key];
        return (
          <div key={key} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-baseline justify-between">
              <dt className="text-sm text-ink-2">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">{value === null ? 'N/A' : value}</dd>
            </div>
            {value === null ? (
              <p className="mt-2 text-xs text-ink-3">No F&amp;O contract for this instrument.</p>
            ) : (
              <div
                role="meter"
                aria-label={`${label} score`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
                className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
              >
                <div className="h-full rounded-full bg-series-1" style={{ width: `${value}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </dl>
  );
}
