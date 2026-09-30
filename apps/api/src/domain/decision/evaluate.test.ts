import { DecisionResult, ResearchSnapshot } from '@stock-analysis/shared';
import { describe, expect, it } from 'vitest';
import {
  AS_OF,
  daysBefore,
  ok,
  SRC_FIN,
  SRC_FLOWS,
  SRC_FNO,
  SRC_QUOTE,
  strongEquity,
  strongFuture,
} from '../../test-support/snapshots.ts';
import { CHECKS_V1, classifyOiBuildUp } from './checks.ts';
import { evaluate } from './evaluate.ts';
import { POLICY_V1 } from './policy.ts';

const NOW = new Date('2026-09-30T10:05:00.000Z');
const run = (snapshot: ResearchSnapshot) => evaluate(ResearchSnapshot.parse(snapshot), POLICY_V1, NOW);
const codes = (factors: { code: string }[]) => factors.map((f) => f.code);

type Mutation = (s: ResearchSnapshot) => void;
const withEquity = (mutate: Mutation) => {
  const s = strongEquity();
  mutate(s);
  return run(s);
};
const withFuture = (mutate: Mutation) => {
  const s = strongFuture();
  mutate(s);
  return run(s);
};

describe('evaluate: baseline', () => {
  it('rates a strong non-F&O equity BUY with full confidence and a null derivatives subscore', () => {
    const result = run(strongEquity());

    expect(result).toMatchObject({
      indicator: 'BUY',
      confidenceScore: 100,
      subscores: { fundamental: 100, technical: 100, derivatives: null, sentiment: 100 },
      policyVersion: 'v1',
      evaluatedAt: '2026-09-30T10:05:00.000Z',
    });
    expect(result.riskFactors).toEqual([]);
    expect(codes(result.reasons)).toContain('ROE_ABOVE_MIN');
    expect(codes(result.reasons)).not.toContain('LONG_BUILD_UP');
  });

  it('rates a strong future BUY with a derivatives subscore', () => {
    const result = run(strongFuture());
    expect(result.indicator).toBe('BUY');
    expect(result.subscores.derivatives).toBe(100);
    expect(codes(result.reasons)).toEqual(expect.arrayContaining(['LONG_BUILD_UP', 'NOT_IN_FNO_BAN']));
  });

  it('always produces output that satisfies the shared DecisionResult schema', () => {
    const variants: ResearchSnapshot[] = [strongEquity(), strongFuture()];
    const bad = strongFuture();
    bad.fundamentals.promoterPledgePct = ok(40, SRC_FIN);
    bad.technicals.lastPrice = { status: 'MISSING', value: null };
    variants.push(bad);
    for (const snapshot of variants) {
      expect(DecisionResult.safeParse(run(snapshot)).success).toBe(true);
    }
  });

  it('only cites sources present in the snapshot', () => {
    const snapshot = strongFuture();
    const known = new Set(snapshot.sources.map((s) => s.id));
    const result = run(snapshot);
    for (const factor of [...result.reasons, ...result.riskFactors]) {
      for (const id of factor.sourceIds) expect(known.has(id), id).toBe(true);
    }
    expect(result.reasons.find((f) => f.code === 'PRICE_ABOVE_EMA50')?.sourceIds).toEqual([SRC_QUOTE]);
  });

  it('is deterministic: same snapshot and policy give byte-identical output', () => {
    const a = JSON.stringify(run(strongFuture()));
    const b = JSON.stringify(run(strongFuture()));
    expect(a).toBe(b);
  });

  it('does not mutate its input', () => {
    const snapshot = ResearchSnapshot.parse(strongFuture());
    const before = JSON.stringify(snapshot);
    evaluate(snapshot, POLICY_V1, NOW);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('uses the clock only for evaluatedAt', () => {
    const a = evaluate(ResearchSnapshot.parse(strongEquity()), POLICY_V1, new Date('2030-01-01T00:00:00.000Z'));
    const b = run(strongEquity());
    expect({ ...a, evaluatedAt: '' }).toEqual({ ...b, evaluatedAt: '' });
  });
});

describe('evaluate: BUY criteria boundaries (strictly-greater / strictly-less per the spec)', () => {
  it.each<[string, Mutation, string]>([
    ['ROE exactly 15%', (s) => void (s.fundamentals.roePct = ok(15, SRC_FIN)), 'NEUTRAL'],
    ['ROE 15.01%', (s) => void (s.fundamentals.roePct = ok(15.01, SRC_FIN)), 'BUY'],
    ['D/E exactly 0.5', (s) => void (s.fundamentals.debtToEquity = ok(0.5, SRC_FIN)), 'NEUTRAL'],
    ['D/E 0.49', (s) => void (s.fundamentals.debtToEquity = ok(0.49, SRC_FIN)), 'BUY'],
    ['pledging 14.99%', (s) => void (s.fundamentals.promoterPledgePct = ok(14.99, SRC_FIN)), 'BUY'],
    ['pledging exactly 15%', (s) => void (s.fundamentals.promoterPledgePct = ok(15, SRC_FIN)), 'NEUTRAL'],
    ['pledging 15.01%', (s) => void (s.fundamentals.promoterPledgePct = ok(15.01, SRC_FIN)), 'DONT_BUY'],
    ['price equal to EMA50', (s) => void (s.technicals.lastPrice = ok(100, SRC_QUOTE)), 'NEUTRAL'],
    ['price just above EMA50', (s) => void (s.technicals.lastPrice = ok(100.01, SRC_QUOTE)), 'BUY'],
  ])('%s -> %s', (_label, mutate, expected) => {
    expect(withEquity(mutate).indicator).toBe(expected);
  });

  it('records why an exact-15% pledge is NEUTRAL: fails the BUY limit, passes the veto', () => {
    const result = withEquity((s) => void (s.fundamentals.promoterPledgePct = ok(15, SRC_FIN)));
    expect(codes(result.riskFactors)).toEqual(['PLEDGE_NOT_BELOW_MAX']);
    expect(codes(result.reasons)).toContain('PLEDGE_NOT_EXCESSIVE');
  });
});

describe('evaluate: DON’T BUY vetoes', () => {
  it.each<[string, Mutation, string]>([
    ['pledging above 15%', (s) => void (s.fundamentals.promoterPledgePct = ok(40, SRC_FIN)), 'PLEDGE_EXCESSIVE'],
    [
      'operating margins shrinking for 3 quarters',
      (s) =>
        void (s.fundamentals.operatingMarginPctQuarterly = ok(
          [
            { period: '2026-Q1', valuePct: 13 },
            { period: '2026-Q2', valuePct: 12 },
            { period: '2026-Q3', valuePct: 11 },
          ],
          SRC_FIN,
        )),
      'OPERATING_MARGIN_SHRINKING',
    ],
    [
      'bearish RSI divergence',
      (s) => void (s.technicals.rsiDivergence = ok({ kind: 'BEARISH' as const, lookbackBars: 14 }, SRC_QUOTE)),
      'BEARISH_RSI_DIVERGENCE',
    ],
  ])('%s -> DONT_BUY (%s)', (_label, mutate, code) => {
    const result = withEquity(mutate);
    expect(result.indicator).toBe('DONT_BUY');
    expect(codes(result.riskFactors)).toContain(code);
  });

  it.each<[string, Mutation, string]>([
    ['F&O ban', (s) => void (s.derivatives.inFnoBan = ok(true, SRC_FNO)), 'IN_FNO_BAN'],
    [
      'short build-up (price down, OI up)',
      (s) => {
        s.derivatives.priceChangePct = ok(-1, SRC_FNO);
        s.derivatives.oiChangePct = ok(3, SRC_FNO);
      },
      'SHORT_BUILD_UP',
    ],
  ])('future with %s -> DONT_BUY (%s)', (_label, mutate, code) => {
    const result = withFuture(mutate);
    expect(result.indicator).toBe('DONT_BUY');
    expect(codes(result.riskFactors)).toContain(code);
  });

  it('does not treat a margin dip that recovers as shrinking', () => {
    const result = withEquity(
      (s) =>
        void (s.fundamentals.operatingMarginPctQuarterly = ok(
          [
            { period: '2026-Q1', valuePct: 13 },
            { period: '2026-Q2', valuePct: 11 },
            { period: '2026-Q3', valuePct: 12 },
          ],
          SRC_FIN,
        )),
    );
    expect(result.indicator).toBe('BUY');
  });

  it('lets a veto override otherwise perfect BUY criteria (conflicting signals)', () => {
    const result = withFuture((s) => void (s.derivatives.inFnoBan = ok(true, SRC_FNO)));
    expect(result.indicator).toBe('DONT_BUY');
    expect(codes(result.reasons)).toEqual(expect.arrayContaining(['ROE_ABOVE_MIN', 'LONG_BUILD_UP']));
  });
});

describe('evaluate: futures without long build-up', () => {
  it.each<[string, number, number]>([
    ['short covering (price up, OI down)', 1, -2],
    ['long unwinding (price down, OI down)', -1, -2],
    ['unclassified (flat price)', 0, 4],
  ])('%s -> NEUTRAL', (_label, price, oi) => {
    const result = withFuture((s) => {
      s.derivatives.priceChangePct = ok(price, SRC_FNO);
      s.derivatives.oiChangePct = ok(oi, SRC_FNO);
    });
    expect(result.indicator).toBe('NEUTRAL');
    expect(codes(result.riskFactors)).toContain('NO_LONG_BUILD_UP');
  });

  it('scores negative basis (backwardation) as a derivatives miss without blocking BUY', () => {
    const result = withFuture((s) => void (s.derivatives.basisPct = ok(-0.2, SRC_FNO)));
    expect(result.indicator).toBe('BUY');
    expect(result.subscores.derivatives).toBe(66.7);
    expect(result.riskFactors.find((f) => f.code === 'BASIS_NEGATIVE')?.message).toContain('backwardation');
  });
});

describe('evaluate: missing and stale data never count as positive evidence', () => {
  it('turns a missing BUY input into NEUTRAL with lower confidence', () => {
    const result = withEquity((s) => void (s.fundamentals.roePct = { status: 'MISSING', value: null }));
    expect(result.indicator).toBe('NEUTRAL');
    expect(codes(result.riskFactors)).toEqual(['ROE_ABOVE_MIN_UNAVAILABLE']);
    expect(result.subscores.fundamental).toBe(85.7);
    expect(result.confidenceScore).toBeLessThan(50);
  });

  it('treats a provider ERROR like missing data', () => {
    const result = withEquity(
      (s) => void (s.technicals.ema50 = { status: 'ERROR', value: null, reason: 'timeout', sourceId: SRC_QUOTE }),
    );
    expect(result.indicator).toBe('NEUTRAL');
    expect(result.riskFactors[0]).toMatchObject({ code: 'PRICE_ABOVE_EMA50_UNAVAILABLE', sourceIds: [SRC_QUOTE] });
  });

  it('cannot BUY when a veto input is unavailable (absence of the veto is unconfirmed)', () => {
    const result = withEquity((s) => void (s.technicals.rsiDivergence = { status: 'MISSING', value: null }));
    expect(result.indicator).toBe('NEUTRAL');
    expect(codes(result.riskFactors)).toEqual(['NO_BEARISH_DIVERGENCE_UNAVAILABLE']);
  });

  it('does not fire a veto on stale data', () => {
    const result = withEquity((s) => void (s.fundamentals.promoterPledgePct = ok(40, SRC_FIN, daysBefore(201))));
    expect(result.indicator).toBe('NEUTRAL');
    expect(result.riskFactors.map((f) => f.message).join(' ')).toMatch(/stale \(observed 2026-03-13\)/);
  });

  it.each<[string, Mutation, 'BUY' | 'NEUTRAL']>([
    [
      'fundamentals 200 days old (limit)',
      (s) => void (s.fundamentals.roePct = ok(18, SRC_FIN, daysBefore(200))),
      'BUY',
    ],
    ['fundamentals 201 days old', (s) => void (s.fundamentals.roePct = ok(18, SRC_FIN, daysBefore(201))), 'NEUTRAL'],
    ['price 4 days old (limit)', (s) => void (s.technicals.lastPrice = ok(110, SRC_QUOTE, daysBefore(4))), 'BUY'],
    ['price 4.01 days old', (s) => void (s.technicals.lastPrice = ok(110, SRC_QUOTE, daysBefore(4.01))), 'NEUTRAL'],
  ])('freshness: %s -> %s', (_label, mutate, expected) => {
    expect(withEquity(mutate).indicator).toBe(expected);
  });

  it('needs at least 3 quarters to judge the margin trend', () => {
    const result = withEquity(
      (s) => void (s.fundamentals.operatingMarginPctQuarterly = ok([{ period: '2026-Q3', valuePct: 13 }], SRC_FIN)),
    );
    expect(result.indicator).toBe('NEUTRAL');
    expect(result.riskFactors[0]).toMatchObject({
      code: 'OPERATING_MARGIN_STABLE_UNAVAILABLE',
      message: 'Operating margin trend: not enough data to decide.',
    });
  });

  it('gives zero confidence when nothing is usable', () => {
    const s = strongEquity();
    for (const section of [s.fundamentals, s.technicals, s.sentiment] as Record<string, unknown>[]) {
      for (const key of Object.keys(section)) section[key] = { status: 'MISSING', value: null };
    }
    const result = run(s);
    expect(result).toMatchObject({
      indicator: 'NEUTRAL',
      confidenceScore: 0,
      subscores: { fundamental: 0, technical: 0, derivatives: null, sentiment: 0 },
      riskReward: null,
      reasons: [],
    });
  });

  it('lists failures before unavailable data in risk factors', () => {
    const result = withEquity((s) => {
      s.fundamentals.roePct = { status: 'MISSING', value: null };
      s.fundamentals.revenueGrowthYoYPct = ok(-5, SRC_FIN);
    });
    expect(codes(result.riskFactors)).toEqual(['REVENUE_NOT_GROWING', 'ROE_ABOVE_MIN_UNAVAILABLE']);
  });
});

describe('evaluate: subscores and confidence', () => {
  it('scores each section as the share of passing scored checks', () => {
    const result = withEquity((s) => {
      s.sentiment.fiiNetFlow = ok({ netInrCr: -20, lookbackDays: 30 }, SRC_FLOWS);
      s.technicals.volumeRatio20d = ok(1.5, SRC_QUOTE);
      s.technicals.rsi14 = ok(75, SRC_QUOTE);
    });
    expect(result.indicator).toBe('BUY');
    expect(result.subscores).toEqual({ fundamental: 100, technical: 71.4, derivatives: null, sentiment: 66.7 });
    expect(result.confidenceScore).toBe(79.4);
  });

  it('counts net selling in bulk/block deals against sentiment', () => {
    const result = withEquity(
      (s) =>
        void (s.sentiment.bulkBlockDeals30d = ok(
          [
            { date: '2026-09-20', kind: 'BULK' as const, side: 'BUY' as const, quantity: 100, price: 105 },
            { date: '2026-09-21', kind: 'BLOCK' as const, side: 'SELL' as const, quantity: 500, price: 104 },
          ],
          SRC_FLOWS,
        )),
    );
    expect(result.subscores.sentiment).toBe(66.7);
    expect(result.riskFactors[0]?.message).toBe('Bulk/block deals: 100 bought vs 500 sold (30 days).');
  });

  it.each<[string, Mutation[], number]>([
    ['one veto', [(s) => void (s.fundamentals.promoterPledgePct = ok(40, SRC_FIN))], 75],
    [
      'two vetoes',
      [
        (s) => void (s.fundamentals.promoterPledgePct = ok(40, SRC_FIN)),
        (s) => void (s.technicals.rsiDivergence = ok({ kind: 'BEARISH' as const, lookbackBars: 14 }, SRC_QUOTE)),
      ],
      100,
    ],
    [
      'three vetoes (capped at 100)',
      [
        (s) => void (s.fundamentals.promoterPledgePct = ok(40, SRC_FIN)),
        (s) => void (s.technicals.rsiDivergence = ok({ kind: 'BEARISH' as const, lookbackBars: 14 }, SRC_QUOTE)),
        (s) => void (s.derivatives.inFnoBan = ok(true, SRC_FNO)),
      ],
      100,
    ],
  ])('DONT_BUY confidence with %s = %s × completeness', (_label, mutations, expected) => {
    const result = withFuture((s) => mutations.forEach((mutate) => mutate(s)));
    expect(result.indicator).toBe('DONT_BUY');
    expect(result.confidenceScore).toBe(expected);
  });

  it('NEUTRAL confidence is 50 × completeness', () => {
    const result = withEquity((s) => void (s.fundamentals.roePct = ok(10, SRC_FIN)));
    expect(result.indicator).toBe('NEUTRAL');
    expect(result.confidenceScore).toBe(50);
  });
});

describe('evaluate: risk-to-reward', () => {
  it('uses a 2×ATR stop and 4×ATR target when EMA50 support is far below', () => {
    expect(run(strongEquity()).riskReward).toEqual({
      ratio: 2,
      entry: 110,
      stop: 106,
      target: 118,
      method: 'Stop 2×ATR14 below entry, target 4×ATR14 above entry.',
    });
  });

  it('tightens the stop to just under EMA50 support when it sits between the ATR stop and entry', () => {
    const result = withEquity((s) => {
      s.technicals.atr14 = ok(4, SRC_QUOTE);
      s.technicals.ema50 = ok(105, SRC_QUOTE);
    });
    expect(result.riskReward).toEqual({
      ratio: 2.67, // (126 - 110) / (110 - 104)
      entry: 110,
      stop: 104,
      target: 126,
      method: 'Stop 0.25×ATR14 below EMA50 support, target 4×ATR14 above entry.',
    });
  });

  it('never loosens the stop beyond the ATR stop', () => {
    const result = withEquity((s) => {
      s.technicals.atr14 = ok(4, SRC_QUOTE);
      s.technicals.ema50 = ok(102.5, SRC_QUOTE);
    });
    expect(result.riskReward).toMatchObject({ stop: 102, ratio: 2 });
  });

  it.each<[string, Mutation]>([
    ['price missing', (s) => void (s.technicals.lastPrice = { status: 'MISSING', value: null })],
    ['ATR zero', (s) => void (s.technicals.atr14 = ok(0, SRC_QUOTE))],
    ['ATR stale', (s) => void (s.technicals.atr14 = ok(2, SRC_QUOTE, daysBefore(10)))],
    [
      'stop at or below zero',
      (s) => {
        s.technicals.lastPrice = ok(5, SRC_QUOTE);
        s.technicals.atr14 = ok(3, SRC_QUOTE);
      },
    ],
  ])('is null when %s', (_label, mutate) => {
    expect(withEquity(mutate).riskReward).toBeNull();
  });
});

describe('evaluate: remaining check messages', () => {
  it('reports a missing breakout and a flat basis', () => {
    const result = withFuture((s) => {
      s.technicals.consolidationBreakout = ok({ brokeOutUp: false, rangeWeeks: 8 }, SRC_QUOTE);
      s.derivatives.basisPct = ok(0, SRC_FNO);
    });
    expect(result.indicator).toBe('BUY');
    expect(result.riskFactors.find((f) => f.code === 'NO_CONSOLIDATION_BREAKOUT')?.message).toBe(
      'No breakout from the 8-week consolidation range.',
    );
    expect(result.reasons.find((f) => f.code === 'BASIS_NON_NEGATIVE')?.message).toBe('Futures basis 0% (flat).');
  });
});

describe('evaluate: custom check sets (engine invariants beyond v1)', () => {
  const only = (...codes: string[]) => CHECKS_V1.filter((c) => codes.includes(c.code));

  it('is NEUTRAL with zero confidence when no check applies (no vacuous BUY)', () => {
    const result = evaluate(ResearchSnapshot.parse(strongEquity()), POLICY_V1, NOW, only('LONG_BUILD_UP'));
    expect(result).toMatchObject({
      indicator: 'NEUTRAL',
      confidenceScore: 0,
      subscores: { fundamental: 0, technical: 0, derivatives: null, sentiment: 0 },
    });
  });

  it('cannot BUY on vetoes alone, without any BUY criterion', () => {
    const result = evaluate(ResearchSnapshot.parse(strongEquity()), POLICY_V1, NOW, only('PLEDGE_NOT_EXCESSIVE'));
    expect(result.indicator).toBe('NEUTRAL');
  });

  it('reports 0 for a section with no scored checks, and BUY confidence 0 when nothing is scored', () => {
    const result = evaluate(ResearchSnapshot.parse(strongEquity()), POLICY_V1, NOW, [
      { ...CHECKS_V1[0]!, scored: false },
    ]);
    expect(result).toMatchObject({
      indicator: 'BUY',
      confidenceScore: 0,
      subscores: { fundamental: 0, technical: 0, derivatives: null, sentiment: 0 },
    });
  });
});

describe('classifyOiBuildUp', () => {
  it.each<[number, number, string | undefined]>([
    [1, 1, 'LONG_BUILD_UP'],
    [-1, 1, 'SHORT_BUILD_UP'],
    [1, -1, 'SHORT_COVERING'],
    [-1, -1, 'LONG_UNWINDING'],
    [0, 1, undefined],
    [1, 0, undefined],
  ])('price %s, OI %s -> %s', (price, oi, expected) => {
    expect(classifyOiBuildUp(price, oi)).toBe(expected);
  });
});

describe('evaluate: timestamps', () => {
  it('measures freshness against the snapshot asOf, not the wall clock', () => {
    const farFuture = evaluate(ResearchSnapshot.parse(strongEquity()), POLICY_V1, new Date('2031-01-01T00:00:00.000Z'));
    expect(farFuture.indicator).toBe('BUY');
    expect(AS_OF).toBe('2026-09-30T10:00:00.000Z');
  });
});
