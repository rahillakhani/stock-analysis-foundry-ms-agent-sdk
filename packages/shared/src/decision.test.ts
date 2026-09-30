import { describe, expect, it } from 'vitest';
import { DECISION_INDICATORS, DecisionResult, decisionSourceIds, isDecisionIndicator, RiskReward } from './decision.ts';
import { decision, SRC_FIN } from './test-support/fixtures.ts';

describe('isDecisionIndicator', () => {
  it.each(DECISION_INDICATORS)('accepts %s', (value) => {
    expect(isDecisionIndicator(value)).toBe(true);
  });

  it.each([["DON'T BUY"], ['buy'], [''], [null], [undefined], [1], [{}]])('rejects %j', (value) => {
    expect(isDecisionIndicator(value)).toBe(false);
  });
});

describe('DecisionResult', () => {
  it('accepts a complete decision, including a null derivatives subscore', () => {
    expect(DecisionResult.parse(decision())).toEqual(decision());
  });

  it('accepts a decision without a risk-to-reward estimate', () => {
    expect(DecisionResult.safeParse({ ...decision(), riskReward: null }).success).toBe(true);
  });

  it.each([
    ['confidence above 100', { ...decision(), confidenceScore: 100.1 }],
    ['negative confidence', { ...decision(), confidenceScore: -1 }],
    ['subscore above 100', { ...decision(), subscores: { ...decision().subscores, technical: 101 } }],
    ['unknown indicator', { ...decision(), indicator: 'STRONG_BUY' }],
    ['non-integer policy version', { ...decision(), policyVersion: 'v1.1' }],
    ['lowercase factor code', { ...decision(), reasons: [{ code: 'roe_ok', message: 'x', sourceIds: [] }] }],
    ['missing evaluatedAt', { ...decision(), evaluatedAt: undefined }],
  ])('rejects %s', (_label, input) => {
    expect(DecisionResult.safeParse(input).success).toBe(false);
  });

  it('collects every cited source id', () => {
    expect(decisionSourceIds(decision())).toEqual([SRC_FIN]);
  });
});

describe('RiskReward', () => {
  const valid = { ratio: 2, entry: 100, stop: 95, target: 110, method: 'ATR' };

  it('accepts stop < entry < target with a matching ratio', () => {
    expect(RiskReward.safeParse(valid).success).toBe(true);
  });

  it('accepts a ratio within 1% of the computed value', () => {
    expect(RiskReward.safeParse({ ...valid, ratio: 2.019 }).success).toBe(true);
  });

  it.each([
    ['stop equal to entry', { ...valid, stop: 100 }],
    ['stop above entry', { ...valid, stop: 101 }],
    ['target equal to entry', { ...valid, target: 100 }],
    ['target below entry', { ...valid, target: 99 }],
    ['ratio not matching prices', { ...valid, ratio: 50 }],
    ['ratio just over 1% off', { ...valid, ratio: 2.021 }],
    ['zero ratio', { ...valid, ratio: 0 }],
    ['empty method', { ...valid, method: '' }],
  ])('rejects %s', (_label, input) => {
    expect(RiskReward.safeParse(input).success).toBe(false);
  });
});
