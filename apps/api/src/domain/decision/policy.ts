/** Research sections the engine evaluates. */
export type Section = 'fundamentals' | 'technicals' | 'derivatives' | 'sentiment';

interface Range {
  readonly min: number;
  readonly max: number;
}

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
    readonly revenueGrowthMinPct: number;
    readonly netMarginMinPct: number;
    readonly rsiLow: number;
    readonly rsiHigh: number;
    readonly volumeSurgeRatio: number;
    readonly shrinkingQuarters: number;
    readonly basisMinPct: number;
    readonly fiiNetFlowMinInrCr: number;
    readonly diiNetFlowMinInrCr: number;
  };
  /** Accepted provider windows; signals computed over other windows are treated as unavailable. */
  readonly windows: {
    readonly divergenceLookbackBars: Range;
    readonly breakoutRangeWeeks: Range;
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
    revenueGrowthMinPct: 0,
    netMarginMinPct: 0,
    rsiLow: 40,
    rsiHigh: 70,
    volumeSurgeRatio: 1.5,
    shrinkingQuarters: 3,
    basisMinPct: 0,
    fiiNetFlowMinInrCr: 0,
    diiNetFlowMinInrCr: 0,
  }),
  windows: Object.freeze({
    divergenceLookbackBars: Object.freeze({ min: 10, max: 30 }),
    breakoutRangeWeeks: Object.freeze({ min: 4, max: 26 }),
  }),
  riskReward: Object.freeze({ stopAtrMultiple: 2, targetAtrMultiple: 4, supportBufferAtr: 0.25 }),
  confidence: Object.freeze({ neutralBase: 50, vetoBase: 50, vetoStep: 25 }),
});

/** v2: same numbers as v1; India-only checks are scoped to NSE/BSE listings (see CHECKS_V2). */
export const POLICY_V2: DecisionPolicy = Object.freeze({ ...POLICY_V1, version: 'v2' });
