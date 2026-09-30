/** Research sections the engine evaluates. */
export type Section = 'fundamentals' | 'technicals' | 'derivatives' | 'sentiment';

/**
 * All tunable numbers for one policy version. See docs/decision-policy-v1.md. Never edit a released policy's
 * values: add a new version instead so historical runs stay reproducible.
 */
export interface DecisionPolicy {
  readonly version: string;
  readonly maxAgeDays: Readonly<Record<Section, number>>;
  readonly thresholds: {
    readonly roeMinPct: number;
    readonly debtToEquityMax: number;
    readonly pledgeMaxPct: number;
    readonly rsiLow: number;
    readonly rsiHigh: number;
    readonly volumeSurgeRatio: number;
    readonly shrinkingQuarters: number;
  };
  readonly riskReward: {
    readonly stopAtrMultiple: number;
    readonly targetAtrMultiple: number;
    readonly supportBufferAtr: number;
  };
  readonly confidence: {
    readonly neutralBase: number;
    readonly vetoBase: number;
    readonly vetoStep: number;
  };
}

export const POLICY_V1: DecisionPolicy = Object.freeze({
  version: 'v1',
  maxAgeDays: Object.freeze({ fundamentals: 200, technicals: 4, derivatives: 4, sentiment: 10 }),
  thresholds: Object.freeze({
    roeMinPct: 15,
    debtToEquityMax: 0.5,
    pledgeMaxPct: 15,
    rsiLow: 40,
    rsiHigh: 70,
    volumeSurgeRatio: 1.5,
    shrinkingQuarters: 3,
  }),
  riskReward: Object.freeze({ stopAtrMultiple: 2, targetAtrMultiple: 4, supportBufferAtr: 0.25 }),
  confidence: Object.freeze({ neutralBase: 50, vetoBase: 50, vetoStep: 25 }),
});
