import { ResearchSnapshot } from '@stock-analysis/shared';
import { describe, expect, it } from 'vitest';
import { strongEquity, SRC_FIN } from '../../test-support/snapshots.ts';
import { evaluate } from './evaluate.ts';
import { buyGuidance } from './guidance.ts';
import { POLICY_V1, POLICY_V2 } from './policy.ts';

const AT = new Date('2026-09-30T10:00:00.000Z');
const decide = (mutate: (s: ResearchSnapshot) => void = () => undefined, policy = POLICY_V1) => {
  const snapshot = ResearchSnapshot.parse(strongEquity());
  mutate(snapshot);
  return evaluate(snapshot, policy, AT);
};
const missing = { status: 'MISSING' as const, value: null, sourceId: SRC_FIN };

describe('buyGuidance', () => {
  it('has no blockers for a BUY, with full data completeness', () => {
    const decision = decide();
    expect(decision.indicator).toBe('BUY');
    expect(buyGuidance(decision)).toMatchObject({ blockers: [], dataCompletenessPct: 100 });
  });

  it('lists failed vetoes first, then buy rules without data, and counts completeness', () => {
    const decision = decide((s) => {
      s.fundamentals.promoterPledgePct = { ...s.fundamentals.promoterPledgePct, value: 30 } as never;
      s.fundamentals.roePct = missing;
    });
    const guidance = buyGuidance(decision);

    expect(decision.indicator).toBe('DONT_BUY');
    // Vetoes first, then buy rules in the policy's check order.
    expect(guidance.blockers.map((b) => [b.code, b.role, b.cause])).toEqual([
      ['PLEDGE_EXCESSIVE', 'VETO', 'FAILED'],
      ['PLEDGE_NOT_BELOW_MAX', 'BUY_RULE', 'FAILED'],
      ['ROE_ABOVE_MIN_UNAVAILABLE', 'BUY_RULE', 'NO_DATA'],
    ]);
    expect(guidance.usableChecks).toBe(guidance.applicableChecks - 1);
    expect(guidance.dataCompletenessPct).toBeLessThan(100);
    // The engine's own message travels with each blocker.
    expect(guidance.blockers[0]?.message).toMatch(/Promoter pledging 30/);
  });

  it('reports failed scored-only checks as improvements, not blockers', () => {
    const decision = decide((s) => {
      s.fundamentals.revenueGrowthYoYPct = { ...s.fundamentals.revenueGrowthYoYPct, value: -5 } as never;
    });
    const guidance = buyGuidance(decision);
    expect(guidance.blockers).toEqual([]);
    expect(guidance.improvements.map((f) => f.code)).toEqual(['REVENUE_NOT_GROWING']);
  });

  it('counts a scored-only check without data against completeness only', () => {
    const guidance = buyGuidance(decide((s) => void (s.fundamentals.revenueGrowthYoYPct = missing as never)));
    expect(guidance).toMatchObject({ blockers: [], improvements: [] });
    expect(guidance.usableChecks).toBe(guidance.applicableChecks - 1);
  });

  it("uses the decision's own policy version, and excludes not-applicable checks", () => {
    const us = decide((s) => {
      s.instrument = { exchange: 'NASDAQ', symbol: 'TESTCO', name: 'Test Co', assetType: 'EQUITY' };
    }, POLICY_V2);
    expect(buyGuidance(us).applicableChecks).toBeLessThan(buyGuidance(decide()).applicableChecks);
  });

  it('ignores factor codes the policy does not define, and reports 0% with no applicable checks', () => {
    const base = decide();
    const odd = { code: 'SOMETHING_ELSE', message: 'x', sourceIds: [] };
    expect(buyGuidance({ ...base, riskFactors: [odd, { ...odd, code: 'UNKNOWN_CHECK_UNAVAILABLE' }] })).toMatchObject({
      blockers: [],
      improvements: [],
    });
    expect(buyGuidance({ ...base, reasons: [], riskFactors: [] })).toMatchObject({
      dataCompletenessPct: 0,
      applicableChecks: 0,
    });
  });

  it('rejects an unknown policy version', () => {
    expect(() => buyGuidance({ ...decide(), policyVersion: 'v99' })).toThrow(/v99/);
  });
});
