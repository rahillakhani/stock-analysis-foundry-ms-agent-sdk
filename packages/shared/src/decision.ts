import { z } from 'zod';
import { IsoDateTime, Score } from './common.ts';
import { SourceId } from './source.ts';

export const DECISION_INDICATORS = ['BUY', 'DONT_BUY', 'NEUTRAL'] as const;
export const DecisionIndicator = z.enum(DECISION_INDICATORS);
export type DecisionIndicator = z.infer<typeof DecisionIndicator>;

export function isDecisionIndicator(value: unknown): value is DecisionIndicator {
  return DecisionIndicator.safeParse(value).success;
}

/** Policy versions are immutable once released; a behavior change means a new version. */
export const PolicyVersion = z.string().regex(/^v\d+$/, 'must look like v1');

/** One rule outcome. `code` is stable (e.g. `PLEDGE_ABOVE_LIMIT`); `sourceIds` may be empty for missing-data notes. */
export const DecisionFactor = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  message: z.string().min(1).max(500),
  sourceIds: z.array(SourceId).max(50),
});
export type DecisionFactor = z.infer<typeof DecisionFactor>;

const RATIO_TOLERANCE = 0.01;

/**
 * Risk-to-reward estimate for a hypothetical long entry, with the assumptions that produced it. It is always a long
 * setup (the app never recommends shorting): DONT_BUY means "don't enter long", and the estimate shows why.
 * `ratio` must equal (target − entry) / (entry − stop) within 1%.
 */
export const RiskReward = z
  .object({
    ratio: z.number().positive(),
    entry: z.number().positive(),
    stop: z.number().positive(),
    target: z.number().positive(),
    method: z.string().min(1).max(200),
  })
  .refine((rr) => rr.stop < rr.entry && rr.entry < rr.target, {
    message: 'long setup requires stop < entry < target',
  })
  .refine(
    (rr) => {
      const expected = (rr.target - rr.entry) / (rr.entry - rr.stop);
      return Math.abs(rr.ratio - expected) <= RATIO_TOLERANCE * expected;
    },
    { message: 'ratio must equal (target - entry) / (entry - stop)', path: ['ratio'] },
  );
export type RiskReward = z.infer<typeof RiskReward>;

/** Output of the deterministic decision engine. The LLM never produces or modifies this object. */
export const DecisionResult = z.object({
  indicator: DecisionIndicator,
  confidenceScore: Score,
  subscores: z.object({
    fundamental: Score,
    technical: Score,
    /** null when the instrument has no F&O contract. */
    derivatives: Score.nullable(),
    /** null when no sentiment check applies to the listing (policy v2: India-only flows for a US stock). */
    sentiment: Score.nullable(),
  }),
  /** null when the inputs needed for an estimate (price, ATR) are unavailable. */
  riskReward: RiskReward.nullable(),
  reasons: z.array(DecisionFactor).max(50),
  riskFactors: z.array(DecisionFactor).max(50),
  policyVersion: PolicyVersion,
  evaluatedAt: IsoDateTime,
});
export type DecisionResult = z.infer<typeof DecisionResult>;

/** Every source id cited by a decision's reasons and risk factors. */
export function decisionSourceIds(decision: DecisionResult): string[] {
  return [...decision.reasons, ...decision.riskFactors].flatMap((factor) => factor.sourceIds);
}
