import type { BuyGuidance, DecisionResult } from '@stock-analysis/shared';
import { CircleCheck, CircleSlash, HelpCircle, ShieldAlert } from 'lucide-react';

interface Props {
  decision: DecisionResult;
  guidance: BuyGuidance | undefined;
  /** Research came from the live source, which doesn't carry some Indian disclosures (pledging, F&O). */
  liveData: boolean;
}

const ROLE_LABEL = { VETO: 'Red flag', BUY_RULE: 'Buy rule' } as const;

/** Checks whose data the live Yahoo source doesn't carry (docs/decision-policy-v2.md §3), by blocker code. */
const UNSOURCED: Readonly<Record<string, string>> = {
  PLEDGE_BELOW_MAX_UNAVAILABLE: 'promoter pledging',
  PLEDGE_NOT_EXCESSIVE_UNAVAILABLE: 'promoter pledging',
  LONG_BUILD_UP_UNAVAILABLE: 'F&O data',
  NO_SHORT_BUILD_UP_UNAVAILABLE: 'F&O data',
  NOT_IN_FNO_BAN_UNAVAILABLE: 'F&O data',
};

/**
 * What must change for the documented rules to say BUY. Derived from the recorded decision; not a forecast, a
 * recommendation, or a price target (the hypothetical risk-to-reward levels stay in their own section).
 */
export function WhenToBuy({ decision, guidance, liveData }: Props) {
  const noData = guidance?.blockers.filter((b) => b.cause === 'NO_DATA') ?? [];
  // The engine's message says "data is stale (observed …)" for a stale reading, "data unavailable" otherwise.
  const staleBlockers = noData.filter((b) => b.message.includes('data is stale')).length;
  const missingBlockers = noData.length - staleBlockers;
  const unsourced = [...new Set(noData.flatMap((b) => (UNSOURCED[b.code] ? [UNSOURCED[b.code]] : [])))] as string[];

  return (
    <section aria-labelledby="when-to-buy" className="rounded-lg border border-border p-4 text-sm">
      <h3 id="when-to-buy" className="font-semibold text-ink">
        When the rules would say BUY
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
                      {blocker.cause === 'NO_DATA' ? ' (no usable data)' : ''}:
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
            {guidance.improvements.length} other check{guidance.improvements.length === 1 ? '' : 's'} failed (these
            lower the section scores but don&apos;t block BUY)
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
            {guidance.improvements.map((factor) => (
              <li key={factor.code}>{factor.message}</li>
            ))}
          </ul>
        </details>
      )}

      <h4 className="mt-3 font-medium text-ink">Pointers</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
        <li>
          Re-analyse after quarterly results, a large price move, or a few sessions: signals use the latest completed
          session.
        </li>
        {staleBlockers > 0 && (
          <li>
            {staleBlockers} rule{staleBlockers === 1 ? ' uses' : 's use'} stale data: the source itself is out of date,
            so re-analysing helps only once it publishes newer figures.
          </li>
        )}
        {missingBlockers > 0 && (
          <li>
            {missingBlockers} rule{missingBlockers === 1 ? ' has' : 's have'} no data from the current source
            {unsourced.length > 0 && liveData
              ? ` (${unsourced.join(', ')} ${unsourced.length === 1 ? 'is' : 'are'} not connected yet, so these can't clear for now)`
              : ''}
            .
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
  const failedVetoes = guidance?.blockers.filter((b) => b.role === 'VETO' && b.cause === 'FAILED').length;
  const byIndicator = {
    BUY: 'For BUY it is data completeness × the average section score: how much of the evidence was available and how much of it passed.',
    DONT_BUY: `For DON'T BUY it is data completeness × the weight of the red flags (50, plus 25 per red flag, at most 100${failedVetoes === undefined ? '' : `; here ${failedVetoes} red flag${failedVetoes === 1 ? '' : 's'}, so ${Math.min(100, 50 + 25 * failedVetoes)}`}): how firmly the data backs the warning.`,
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
