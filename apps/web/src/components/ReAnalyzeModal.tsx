import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { AnalysisRunView } from '@stock-analysis/shared';
import { formatAge, formatDateTime } from '../lib/format.ts';
import { DecisionBadge } from './DecisionBadge.tsx';
import { Disclaimer } from './Disclaimer.tsx';

interface Props {
  open: boolean;
  name: string;
  ageSeconds: number;
  latestRun: AnalysisRunView;
  onViewExisting: () => void;
  onReanalyze: () => void;
}

/** Spec step 1 prompt: an analysis exists — review it, or run a fresh re-analysis. Escape keeps the existing one. */
export function ReAnalyzeModal({ open, name, ageSeconds, latestRun, onViewExisting, onReanalyze }: Props) {
  const decision = 'decision' in latestRun ? latestRun.decision : null;
  const completedAt = 'completedAt' in latestRun ? latestRun.completedAt : null;
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onViewExisting()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl">
          <AlertDialog.Title className="text-lg font-semibold text-ink">Record found for {name}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-ink-2">
            Last analysed {formatAge(ageSeconds)}
            {completedAt ? ` (${formatDateTime(completedAt)})` : ''}. Would you like to review the existing analysis or
            run a fresh re-analysis?
          </AlertDialog.Description>
          {decision && (
            <div className="mt-4 flex items-center gap-2 text-sm text-ink-2">
              Previous decision: <DecisionBadge indicator={decision.indicator} size="sm" />
              <span className="tabular-nums">{decision.confidenceScore}% confidence</span>
            </div>
          )}
          {decision && (
            <div className="mt-4">
              <Disclaimer />
            </div>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
              >
                View existing
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onReanalyze}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Run fresh re-analysis
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
