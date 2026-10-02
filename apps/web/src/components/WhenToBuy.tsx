import type { BuyGuidance, DecisionResult } from '@stock-analysis/shared';
import { CircleCheck, CircleSlash, HelpCircle, ShieldAlert } from 'lucide-react';
import { formatPrice } from '../lib/format.ts';

interface Props {
  decision: DecisionResult;
  guidance: BuyGuidance | undefined;
  currency: 'INR' | 'USD';
  /** Indian listings: some inputs (pledging, F&O, FII/DII flows) have no connected source yet. */
  indian: boolean;
}

const ROLE_LABEL = { VETO: 'Red flag', BUY_RULE: 'Buy rule' } as const;

/**
 * "When to buy" under the documented rules: what must change for the rules to say BUY, and the rule-based price
 * levels. Everything here is derived from the recorded decision; nothing is a forecast or a recommendation.
 */
export function WhenToBuy({ decision, guidance, currency, indian }: Props) {
  const rr = decision.riskReward;
  const noDataBlockers = guidance?.blockers.filter((b) => b.cause === 'NO_DATA') ?? [];

  return (
    <section aria-labelledby="when-to-buy" className="rounded-lg border border-border p-4 text-sm">
      <h3 id="when-to-buy" className="font-semibold text-ink">
        When to buy (by the rules)
      </h3>

      {decision.indicator === 'BUY' ? (
        <p className="mt-2 flex items-start gap-2 text-ink">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-up" />
          Every buy rule passes and no red flag is raised with the data available now.
        </p>
      ) : guidance && guidance.blockers.length > 0 ? (
        <>
          <p className="mt-2 text-ink-2">
            The rules would say BUY only once <strong className="text-ink">all</strong> of these clear:
          </p>
          <ul className="mt-2 space-y-1.5">
            {guidance.blockers.map((blocker) => {
              const Icon =
                blocker.cause === 'NO_DATA' ? HelpCircle : blocker.role === 'VETO' ? ShieldAlert : CircleSlash;
              return (
                <li key={blocker.code} className="flex items-start gap-2 text-ink-2">
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="font-medium text-ink">
                      {ROLE_LABEL[blocker.role]}
                      {blocker.cause === 'NO_DATA' ? ' (needs data)' : ''}:
                    </span>{' '}
                    {blocker.message}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-ink-2">Re-analyse to see which rules stand between this signal and BUY.</p>
      )}

      {guidance && guidance.improvements.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-ink-2">
            {guidance.improvements.length} scored check{guidance.improvements.length === 1 ? '' : 's'} would raise
            confidence
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
            {guidance.improvements.map((factor) => (
              <li key={factor.code}>{factor.message}</li>
            ))}
          </ul>
        </details>
      )}

      {rr && (
        <div className="mt-3 rounded-md bg-surface-2 p-3">
          <p className="font-medium text-ink">Rule-based levels (hypothetical long entry, risk-to-reward {rr.ratio})</p>
          <p className="mt-0.5 tabular-nums text-ink-2">
            Entry {formatPrice(rr.entry, currency)} · Stop {formatPrice(rr.stop, currency)} · Target{' '}
            {formatPrice(rr.target, currency)}
          </p>
          <p className="mt-1 text-xs text-ink-3">{rr.method}</p>
        </div>
      )}

      <h4 className="mt-3 font-medium text-ink">Pointers</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
        <li>
          Re-analyse after quarterly results, a large price move, or a few sessions: signals use the latest completed
          session.
        </li>
        {decision.indicator !== 'BUY' && rr && (
          <li>
            These levels come from the latest price and its volatility (ATR). If the signal turns BUY later, re-analyse
            for fresh levels instead of reusing these.
          </li>
        )}
        {noDataBlockers.length > 0 && (
          <li>
            {noDataBlockers.length} rule{noDataBlockers.length === 1 ? '' : 's'} can&apos;t clear until the data is
            available
            {indian
              ? ': promoter pledging, F&O and FII/DII flows have no connected source yet, so Indian stocks are at most NEUTRAL.'
              : '.'}
          </li>
        )}
        <li>The rules never consider your goals, horizon or position size. Use them as a checklist, not advice.</li>
      </ul>
    </section>
  );
}

/** What the confidence number means for this signal, with the data completeness behind it. */
export function ConfidenceExplainer({
  decision,
  guidance,
}: {
  decision: DecisionResult;
  guidance: BuyGuidance | undefined;
}) {
  const completeness = guidance
    ? `${guidance.dataCompletenessPct}% (${guidance.usableChecks} of ${guidance.applicableChecks} checks had usable data)`
    : undefined;
  const failedVetoes = guidance?.blockers.filter((b) => b.role === 'VETO' && b.cause === 'FAILED').length ?? 0;
  const byIndicator = {
    BUY: 'For BUY it is data completeness × the average section score: how much of the evidence was available and how much of it passed.',
    DONT_BUY: `For DON'T BUY it is data completeness × the weight of the red flags (50, plus 25 per red flag, at most 100; here ${failedVetoes} red flag${failedVetoes === 1 ? '' : 's'}): how firmly the data backs the warning.`,
    NEUTRAL:
      'For NEUTRAL it is data completeness × 50, so it never exceeds 50%. A low number mostly means data was missing, not that the stock is weak.',
  } as const;

  return (
    <details className="w-full text-sm">
      <summary className="cursor-pointer text-ink-2">What does {decision.confidenceScore}% confidence mean?</summary>
      <div className="mt-1 space-y-1 rounded-md bg-surface-2 p-3 text-ink-2">
        <p>
          <strong className="text-ink">It is not the chance that the price will rise</strong>, and it is not a buy
          rating. It says how strongly the available data supports the signal shown (
          {decision.indicator === 'DONT_BUY' ? "DON'T BUY" : decision.indicator}).
        </p>
        <p>{byIndicator[decision.indicator]}</p>
        {completeness && <p>Data completeness for this analysis: {completeness}.</p>}
      </div>
    </details>
  );
}
