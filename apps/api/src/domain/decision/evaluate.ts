import type {
  DecisionFactor,
  DecisionIndicator,
  DecisionResult,
  ResearchSnapshot,
  RiskReward,
} from '@stock-analysis/shared';
import { CHECKS_V1, read, type CheckDefinition, type CheckOutcome } from './checks.ts';
import type { DecisionPolicy, Section } from './policy.ts';

interface EvaluatedCheck {
  definition: CheckDefinition;
  outcome: CheckOutcome;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const clampScore = (value: number) => round(Math.min(100, Math.max(0, value)), 1);

/**
 * Deterministic decision for one research snapshot under one policy version (docs/decision-policy-v1.md).
 * Pure: no I/O, no randomness; `now` is used only for `evaluatedAt`. Same snapshot + policy -> same decision.
 */
export function evaluate(
  snapshot: ResearchSnapshot,
  policy: DecisionPolicy,
  now: Date,
  checks: readonly CheckDefinition[] = CHECKS_V1,
): DecisionResult {
  const evaluated: EvaluatedCheck[] = checks.map((definition) => ({
    definition,
    outcome: definition.run({ snapshot, policy }),
  }));
  const applicable = evaluated.filter((c) => c.outcome.state !== 'NOT_APPLICABLE');

  const failedVetoes = applicable.filter((c) => c.definition.veto && c.outcome.state === 'FAIL');
  const buyGate = applicable.filter((c) => c.definition.requiredForBuy || c.definition.veto);
  // BUY needs positive evidence: at least one applicable BUY criterion, never a vacuous "all of nothing passed".
  const canBuy =
    applicable.some((c) => c.definition.requiredForBuy) && buyGate.every((c) => c.outcome.state === 'PASS');
  const indicator: DecisionIndicator = failedVetoes.length > 0 ? 'DONT_BUY' : canBuy ? 'BUY' : 'NEUTRAL';

  const subscores = {
    fundamental: subscore(applicable, 'fundamentals') ?? 0,
    technical: subscore(applicable, 'technicals') ?? 0,
    derivatives: subscore(applicable, 'derivatives'),
    sentiment: subscore(applicable, 'sentiment') ?? 0,
  };

  const usable = applicable.filter((c) => c.outcome.state === 'PASS' || c.outcome.state === 'FAIL');
  const completeness = applicable.length === 0 ? 0 : usable.length / applicable.length;
  const confidenceScore = clampScore(completeness * strength(indicator, subscores, failedVetoes.length, policy));

  return {
    indicator,
    confidenceScore,
    subscores,
    riskReward: riskReward(snapshot, policy),
    reasons: factors(applicable, ['PASS']),
    riskFactors: factors(applicable, ['FAIL', 'UNAVAILABLE']),
    policyVersion: policy.version,
    evaluatedAt: now.toISOString(),
  };
}

/** 100 × passing scored checks / applicable scored checks; null when none apply (e.g. no F&O contract). */
function subscore(applicable: EvaluatedCheck[], section: Section): number | null {
  const scored = applicable.filter((c) => c.definition.scored && c.definition.section === section);
  if (scored.length === 0) return null;
  return clampScore((100 * scored.filter((c) => c.outcome.state === 'PASS').length) / scored.length);
}

function strength(
  indicator: DecisionIndicator,
  subscores: { fundamental: number; technical: number; derivatives: number | null; sentiment: number },
  failedVetoCount: number,
  policy: DecisionPolicy,
): number {
  if (indicator === 'DONT_BUY') {
    return Math.min(100, policy.confidence.vetoBase + policy.confidence.vetoStep * failedVetoCount);
  }
  if (indicator === 'NEUTRAL') return policy.confidence.neutralBase;
  const values = [subscores.fundamental, subscores.technical, subscores.derivatives, subscores.sentiment].filter(
    (v): v is number => v !== null,
  );
  // Never empty: only the derivatives subscore can be null.
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Factors in check order; failures before unavailable within risk factors. */
function factors(applicable: EvaluatedCheck[], states: readonly ('PASS' | 'FAIL' | 'UNAVAILABLE')[]): DecisionFactor[] {
  return states.flatMap((state) =>
    applicable.flatMap(({ definition, outcome }): DecisionFactor[] => {
      if (outcome.state !== state) return [];
      const code =
        state === 'PASS' ? definition.code : state === 'FAIL' ? definition.failCode : `${definition.code}_UNAVAILABLE`;
      return [{ code, message: outcome.message, sourceIds: outcome.sourceIds }];
    }),
  );
}

/** Long-setup estimate from ATR, with an EMA50 support stop when it is tighter. See policy §5. */
function riskReward(snapshot: ResearchSnapshot, policy: DecisionPolicy): RiskReward | null {
  const price = read(snapshot.technicals.lastPrice, 'technicals', policy, snapshot.asOf);
  const atr = read(snapshot.technicals.atr14, 'technicals', policy, snapshot.asOf);
  if (price.kind !== 'USABLE' || atr.kind !== 'USABLE' || atr.value <= 0) return null;

  const { stopAtrMultiple, targetAtrMultiple, supportBufferAtr } = policy.riskReward;
  const entry = round(price.value, 2);
  const atrStop = entry - stopAtrMultiple * atr.value;
  const ema50 = read(snapshot.technicals.ema50, 'technicals', policy, snapshot.asOf);
  const useSupport = ema50.kind === 'USABLE' && ema50.value > atrStop && ema50.value < entry;
  const supportStop = useSupport ? ema50.value - supportBufferAtr * atr.value : atrStop;
  // The buffer can push the support stop below the ATR stop; never loosen beyond the ATR stop.
  const stop = round(Math.max(atrStop, supportStop), 2);
  const target = round(entry + targetAtrMultiple * atr.value, 2);
  if (stop <= 0 || stop >= entry || target <= entry) return null;

  const method =
    useSupport && supportStop > atrStop
      ? `Stop ${supportBufferAtr}×ATR14 below EMA50 support, target ${targetAtrMultiple}×ATR14 above entry.`
      : `Stop ${stopAtrMultiple}×ATR14 below entry, target ${targetAtrMultiple}×ATR14 above entry.`;
  return { ratio: round((target - entry) / (entry - stop), 2), entry, stop, target, method };
}
