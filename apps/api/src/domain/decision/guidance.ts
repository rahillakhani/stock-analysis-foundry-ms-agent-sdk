import type { BuyGuidance, DecisionResult } from '@stock-analysis/shared';
import { checksForVersion, type CheckDefinition } from './checks.ts';

const UNAVAILABLE_SUFFIX = '_UNAVAILABLE';

/**
 * "When would the rules say BUY?" for a recorded decision. Pure: reads only the decision and the check definitions
 * of the decision's own policy version, so it is reproducible and can't drift from what the engine evaluated.
 * Every applicable check produced exactly one factor: its pass code in `reasons`, or its fail code or
 * `<code>_UNAVAILABLE` in `riskFactors` (NOT_APPLICABLE checks produce none).
 */
export function buyGuidance(decision: DecisionResult): BuyGuidance {
  const checks = checksForVersion(decision.policyVersion);
  const byFailCode = new Map(checks.map((c) => [c.failCode, c]));
  const byCode = new Map(checks.map((c) => [c.code, c]));

  const blockers: BuyGuidance['blockers'] = [];
  const improvements: BuyGuidance['improvements'] = [];
  let unavailable = 0;
  for (const factor of decision.riskFactors) {
    const noData = factor.code.endsWith(UNAVAILABLE_SUFFIX);
    const check: CheckDefinition | undefined = noData
      ? byCode.get(factor.code.slice(0, -UNAVAILABLE_SUFFIX.length))
      : byFailCode.get(factor.code);
    if (noData) unavailable += 1;
    if (!check) continue;
    if (check.veto || check.requiredForBuy) {
      blockers.push({ ...factor, role: check.veto ? 'VETO' : 'BUY_RULE', cause: noData ? 'NO_DATA' : 'FAILED' });
    } else if (!noData) {
      improvements.push(factor);
    }
  }

  const applicableChecks = decision.reasons.length + decision.riskFactors.length;
  const usableChecks = applicableChecks - unavailable;
  return {
    // Vetoes first: they decide DON'T BUY regardless of anything else.
    blockers: [...blockers.filter((b) => b.role === 'VETO'), ...blockers.filter((b) => b.role === 'BUY_RULE')],
    improvements,
    dataCompletenessPct: applicableChecks === 0 ? 0 : Math.round((1000 * usableChecks) / applicableChecks) / 10,
    usableChecks,
    applicableChecks,
  };
}
