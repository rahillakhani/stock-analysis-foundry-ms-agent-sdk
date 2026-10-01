import {
  ResearchSnapshot,
  type DecisionFactor,
  type DecisionIndicator,
  type DecisionResult,
  type RiskReward,
} from '@stock-analysis/shared';
import { checksFor, createReader, type CheckDefinition, type CheckOutcome, type Reader } from './checks.ts';
import type { DecisionPolicy, Section } from './policy.ts';

interface EvaluatedCheck {
  definition: CheckDefinition;
  outcome: CheckOutcome;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const clamp = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Deterministic decision for one research snapshot under one policy version (docs/decision-policy-v1.md).
 * Pure: no I/O, no randomness; `now` is used only for `evaluatedAt`. Same snapshot + policy -> same decision.
 * The snapshot is validated on entry, so unvalidated input can't produce a decision. `checks` overrides the
 * version's registered check set and exists for engine-invariant tests.
 */
export function evaluate(
  input: ResearchSnapshot,
  policy: DecisionPolicy,
  now: Date,
  checks: readonly CheckDefinition[] = checksFor(policy),
): DecisionResult {
  if (Number.isNaN(now.getTime())) throw new RangeError('evaluate: invalid clock time');
  const snapshot = ResearchSnapshot.parse(input);
  const read = createReader(snapshot, policy);

  const evaluated: EvaluatedCheck[] = checks.map((definition) => ({
    definition,
    outcome:
      definition.appliesTo && !definition.appliesTo(snapshot.instrument)
        ? { state: 'NOT_APPLICABLE' as const }
        : definition.run({ snapshot, policy, read }),
  }));
  const applicable = evaluated.filter((c) => c.outcome.state !== 'NOT_APPLICABLE');

  const failedVetoes = applicable.filter((c) => c.definition.veto && c.outcome.state === 'FAIL');
  const buyGate = applicable.filter((c) => c.definition.requiredForBuy || c.definition.veto);
  // BUY needs positive evidence: at least one applicable BUY criterion, never a vacuous "all of nothing passed".
  const canBuy =
    applicable.some((c) => c.definition.requiredForBuy) && buyGate.every((c) => c.outcome.state === 'PASS');
  const indicator: DecisionIndicator = failedVetoes.length > 0 ? 'DONT_BUY' : canBuy ? 'BUY' : 'NEUTRAL';

  const raw = {
    fundamental: subscore(applicable, 'fundamentals'),
    technical: subscore(applicable, 'technicals'),
    derivatives: subscore(applicable, 'derivatives'),
    sentiment: subscore(applicable, 'sentiment'),
  };
  const usable = applicable.filter((c) => c.outcome.state === 'PASS' || c.outcome.state === 'FAIL');
  const completeness = applicable.length === 0 ? 0 : usable.length / applicable.length;
  const confidence = completeness * strength(indicator, Object.values(raw), failedVetoes.length, policy);

  const display = (value: number | null) => (value === null ? null : round(clamp(value), 1));
  return {
    indicator,
    confidenceScore: round(clamp(confidence), 1),
    subscores: {
      fundamental: display(raw.fundamental) ?? 0,
      technical: display(raw.technical) ?? 0,
      derivatives: display(raw.derivatives),
      sentiment: display(raw.sentiment),
    },
    riskReward: riskReward(snapshot, policy, read),
    reasons: factors(applicable, ['PASS']),
    riskFactors: factors(applicable, ['FAIL', 'UNAVAILABLE']),
    policyVersion: policy.version,
    evaluatedAt: now.toISOString(),
  };
}

/** Unrounded 100 × passing / applicable scored checks; null when none apply to the section. */
function subscore(applicable: EvaluatedCheck[], section: Section): number | null {
  const scored = applicable.filter((c) => c.definition.scored && c.definition.section === section);
  if (scored.length === 0) return null;
  return (100 * scored.filter((c) => c.outcome.state === 'PASS').length) / scored.length;
}

function strength(
  indicator: DecisionIndicator,
  subscores: (number | null)[],
  failedVetoCount: number,
  policy: DecisionPolicy,
): number {
  if (indicator === 'DONT_BUY') {
    return Math.min(100, policy.confidence.vetoBase + policy.confidence.vetoStep * failedVetoCount);
  }
  if (indicator === 'NEUTRAL') return policy.confidence.neutralBase;
  // Sections without applicable scored checks are excluded from the mean, not counted as 0.
  const present = subscores.filter((v): v is number => v !== null);
  return present.length === 0 ? 0 : present.reduce((sum, v) => sum + v, 0) / present.length;
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
function riskReward(snapshot: ResearchSnapshot, policy: DecisionPolicy, read: Reader): RiskReward | null {
  const price = read('technicals', snapshot.technicals.lastPrice);
  const atr = read('technicals', snapshot.technicals.atr14);
  if (price.kind !== 'USABLE' || atr.kind !== 'USABLE' || atr.value <= 0) return null;

  const { stopAtrMultiple, targetAtrMultiple, supportBufferAtr } = policy.riskReward;
  const entry = round(price.value, 2);
  const atrStop = entry - stopAtrMultiple * atr.value;
  const ema50 = read('technicals', snapshot.technicals.ema50);
  const supportStop =
    ema50.kind === 'USABLE' && ema50.value > atrStop && ema50.value < entry
      ? ema50.value - supportBufferAtr * atr.value
      : atrStop;
  // The buffer can push the support stop below the ATR stop; never loosen beyond the ATR stop.
  const usesSupport = supportStop > atrStop;
  const stop = round(usesSupport ? supportStop : atrStop, 2);
  const target = round(entry + targetAtrMultiple * atr.value, 2);
  if (stop <= 0 || stop >= entry || target <= entry) return null;

  const method = usesSupport
    ? `Stop ${supportBufferAtr}×ATR14 below EMA50 support, target ${targetAtrMultiple}×ATR14 above entry.`
    : `Stop ${stopAtrMultiple}×ATR14 below entry, target ${targetAtrMultiple}×ATR14 above entry.`;
  return { ratio: round((target - entry) / (entry - stop), 2), entry, stop, target, method };
}
