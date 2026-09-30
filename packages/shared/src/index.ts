// Domain vocabulary shared by api and web. Zod contracts are added in Phase 3.

export const DECISION_INDICATORS = ['BUY', 'DONT_BUY', 'NEUTRAL'] as const;
export type DecisionIndicator = (typeof DECISION_INDICATORS)[number];

export const ASSET_TYPES = ['EQUITY', 'FUTURE', 'INDEX'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export function isDecisionIndicator(value: unknown): value is DecisionIndicator {
  return typeof value === 'string' && (DECISION_INDICATORS as readonly string[]).includes(value);
}
