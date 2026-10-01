import type { Instrument } from '@stock-analysis/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V1, POLICY_V2 } from '../domain/decision/policy.ts';
import { FakeMarketData } from '../test-support/fakeMarket.ts';
import {
  annualRatios,
  MarketResearchProvider,
  quarterLabel,
  quarterlyOperatingMargins,
} from './marketResearchProvider.ts';
import { aggregateResearch } from './researchAggregator.ts';

const AS_OF = new Date('2026-10-01T10:00:00.000Z');
const MRF: Instrument = { exchange: 'NSE', symbol: 'MRF', name: 'MRF Limited', assetType: 'EQUITY' };
const MMYT: Instrument = { exchange: 'NASDAQ', symbol: 'MMYT', name: 'MakeMyTrip Limited', assetType: 'EQUITY' };
const research = (instrument: Instrument, market = new FakeMarketData(AS_OF)) =>
  aggregateResearch(new MarketResearchProvider(market), instrument, AS_OF, new AbortController().signal);

describe('annualRatios', () => {
  it('computes ROE, D/E, margins, growth, and ROCE from the latest annual statement', () => {
    expect(
      annualRatios([
        { periodEnd: '2025-03-31', totalRevenue: 1000 },
        {
          periodEnd: '2026-03-31',
          totalRevenue: 1100,
          netIncome: 180,
          stockholdersEquity: 900,
          totalDebt: 270,
          ebit: 260,
          investedCapital: 1100,
        },
      ]),
    ).toEqual({
      periodEnd: '2026-03-31',
      roePct: 20,
      debtToEquity: 0.3,
      netMarginPct: 16.3636,
      revenueGrowthYoYPct: 10,
      rocePct: 23.6364,
    });
  });

  it('does not report ROE or D/E when equity is zero or negative', () => {
    const ratios = annualRatios([
      { periodEnd: '2026-03-31', totalRevenue: 1000, netIncome: 50, stockholdersEquity: -67, totalDebt: 1400 },
    ]);
    expect(ratios).toMatchObject({
      roePct: undefined,
      debtToEquity: undefined,
      netMarginPct: 5,
      revenueGrowthYoYPct: undefined,
    });
  });

  it('returns undefined without any revenue', () => {
    expect(annualRatios([{ periodEnd: '2026-03-31' }])).toBeUndefined();
  });
});

describe('quarterly operating margins', () => {
  it.each([
    ['2026-03-31', '2026-Q1'],
    ['2026-06-30', '2026-Q2'],
    ['2025-12-31', '2025-Q4'],
  ])('%s -> %s', (date, label) => {
    expect(quarterLabel(date)).toBe(label);
  });

  it('skips quarters without data and keeps calendar order', () => {
    expect(
      quarterlyOperatingMargins([
        { periodEnd: '2025-03-31' },
        { periodEnd: '2025-06-30', totalRevenue: 200, operatingIncome: 30 },
      ]),
    ).toEqual([{ period: '2025-Q2', periodEnd: '2025-06-30', valuePct: 15 }]);
  });
});

describe('MarketResearchProvider', () => {
  it('produces complete, contract-valid research for an Indian stock with India-only gaps marked MISSING', async () => {
    const { snapshot, unavailableDimensions } = await research(MRF);

    expect(unavailableDimensions).toEqual([]);
    expect(snapshot.currency).toBe('INR');
    expect(snapshot.fundamentals.roePct).toMatchObject({
      status: 'OK',
      value: 20,
      observedAt: '2026-03-31T00:00:00.000Z',
    });
    expect(snapshot.fundamentals.promoterPledgePct.status).toBe('MISSING');
    expect(snapshot.technicals.ema200.status).toBe('OK');
    expect(snapshot.technicals.rsiDivergence).toMatchObject({ value: { lookbackBars: 14 } });
    expect(snapshot.derivatives.inFnoBan.status).toBe('MISSING');
    expect(snapshot.sentiment.fiiNetFlow.status).toBe('MISSING');
    expect(
      snapshot.sources.every(
        (s) => s.provider === 'yahoo-finance' && s.url?.startsWith('https://finance.yahoo.com/quote/MRF.NS'),
      ),
    ).toBe(true);
  });

  it('marks India-only data NOT_APPLICABLE for a US stock and prices it in USD', async () => {
    const { snapshot } = await research(MMYT);
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.fundamentals.promoterPledgePct.status).toBe('NOT_APPLICABLE');
    expect(snapshot.derivatives.inFnoBan.status).toBe('NOT_APPLICABLE');
    expect(snapshot.sentiment.bulkBlockDeals30d.status).toBe('NOT_APPLICABLE');
  });

  it('drops news published after the snapshot time', async () => {
    const { snapshot } = await research(MMYT);
    expect(snapshot.sentiment.announcements.value?.map((n) => n.headline)).toEqual([
      'Company reports quarterly results',
    ]);
  });

  it('reports ROE and D/E as missing for negative equity', async () => {
    const market = new FakeMarketData(AS_OF, {
      annual: [
        { periodEnd: '2026-03-31', totalRevenue: 1000, netIncome: 50, stockholdersEquity: -67, totalDebt: 1400 },
      ],
    });
    const { snapshot } = await research(MMYT, market);
    expect(snapshot.fundamentals.roePct.status).toBe('MISSING');
    expect(snapshot.fundamentals.debtToEquity.status).toBe('MISSING');
    expect(snapshot.fundamentals.netMarginPct).toMatchObject({ status: 'OK', value: 5 });
  });

  it('has no company fundamentals for an index and no futures technicals', async () => {
    const nifty = await research({ exchange: 'NSE', symbol: 'NIFTY', name: 'Nifty 50', assetType: 'INDEX' });
    expect(nifty.snapshot.fundamentals.roePct.status).toBe('MISSING');
    const future = await research({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      name: 'Reliance Fut',
      assetType: 'FUTURE',
      contract: { expiry: '2026-10-27', lotSize: 500 },
    });
    expect(future.snapshot.technicals.lastPrice.status).toBe('MISSING');
  });
});

describe('decision policy v2 with live research', () => {
  it('lets a strong US stock reach BUY under v2, which v1 could never do', async () => {
    const { snapshot } = await research(MMYT);
    const v2 = evaluate(snapshot, POLICY_V2, AS_OF);
    const v1 = evaluate(snapshot, POLICY_V1, AS_OF);

    expect(v2).toMatchObject({ indicator: 'BUY', policyVersion: 'v2' });
    // No sentiment check applies to a US listing under v2: reported as not applicable, not as a zero score.
    expect(v2.subscores.sentiment).toBeNull();
    expect(v2.riskFactors.map((f) => f.code)).not.toContain('PLEDGE_BELOW_MAX_UNAVAILABLE');
    expect(v1.indicator).toBe('NEUTRAL');
    expect(v1.riskFactors.map((f) => f.code)).toContain('PLEDGE_BELOW_MAX_UNAVAILABLE');
  });

  it('keeps Indian stocks fail-closed: missing pledging and F&O data block BUY under v2', async () => {
    const { snapshot } = await research(MRF);
    const v2 = evaluate(snapshot, POLICY_V2, AS_OF);
    expect(v2.indicator).toBe('NEUTRAL');
    expect(v2.riskFactors.map((f) => f.code)).toEqual(
      expect.arrayContaining(['PLEDGE_BELOW_MAX_UNAVAILABLE', 'LONG_BUILD_UP_UNAVAILABLE']),
    );
  });
});
