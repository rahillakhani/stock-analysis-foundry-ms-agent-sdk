import type { TimelineEntryView } from '@stock-analysis/shared';
import { formatDateTime } from '../lib/format.ts';
import { DecisionBadge } from './DecisionBadge.tsx';

const EVENT_LABEL = { INITIAL_RESEARCH: 'Initial research', RE_ANALYSIS: 'Re-analysis' } as const;

/** Decision history, newest first, as a vertical timeline. */
export function TimelineView({ entries, currentRunId }: { entries: TimelineEntryView[]; currentRunId: string }) {
  if (entries.length === 0) return <p className="text-sm text-ink-3">No previous analyses.</p>;
  const newestFirst = [...entries].reverse();
  return (
    <ol className="relative ms-2 border-s border-border" aria-label="Analysis history">
      {newestFirst.map((entry) => (
        <li key={entry.id} className="ms-5 pb-4 last:pb-0">
          <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-surface bg-ink-3" />
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge indicator={entry.indicator} size="sm" />
            <span className="text-sm tabular-nums text-ink">{entry.confidenceScore}% confidence</span>
            {entry.runId === currentRunId && (
              <span className="rounded bg-surface-2 px-1.5 text-xs text-ink-2">shown</span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-3">
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time> · {EVENT_LABEL[entry.eventType]} ·
            policy {entry.policyVersion}
          </p>
        </li>
      ))}
    </ol>
  );
}
