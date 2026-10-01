import type { Instrument } from '@stock-analysis/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V1, POLICY_V2 } from '../domain/decision/policy.ts';
import { FakeMarketData, QUARTERLY } from '../test-support/fakeMarket.ts';
import {
  annualRatios,
  MarketResearchProvider,
  quarterLabel,
  quarterlyOperatingMargins,
  trailingRatios,
} from './marketResearchProvider.ts';

const round4 = (v: number) => Number(v.toFixed(4));
import { aggregateResearch } from './researchAggregator.ts';

const AS_OF = new Date('2026-10-01T10:00:00.000Z');
const MRF: Instrument = { exchange: 'NSE', symbol: 'MRF', name: 'MRF Limited', assetType: 'EQUITY' };
const MMYT: Instrument = { exchange: 'NASDAQ', symbol: 'MMYT', name: 'MakeMyTrip Limited', assetType: 'EQUITY' };
const research = (instrument: Instrument, market = new FakeMarketData(AS_OF)) =>
  aggregateResearch(new MarketResearchProvider(market), instrument, AS_OF, new AbortController().signal);

describe('trailingRatios (TTM from quarterly statements)', () => {
  it('sums the last four consecutive quarters and uses the latest balance sheet', () => {
    expect(trailingRatios(QUARTERLY)).toEqual({
      income: { periodEnd: '2026-06-30', values: { netMarginPct: 15.7895, revenueGrowthYoYPct: 20 } },
      balance: { periodEnd: '2026-06-30', values: { roePct: 20, debtToEquity: 0.3, rocePct: 23.6364 } },
    });
  });

  it('dates balance-sheet ratios to the older balance sheet (Indian half-yearly reporting)', () => {
    const rows = QUARTERLY.map((r) =>
      r.periodEnd === '2026-06-30'
        ? { ...r, stockholdersEquity: undefined }
        : r.periodEnd === '2026-03-31'
          ? { ...r, stockholdersEquity: 900, totalDebt: 270 }
          : r,
    );
    expect(trailingRatios(rows)?.balance?.periodEnd).toBe('2026-03-31');
  });

  it('refuses non-consecutive quarters', () => {
    expect(trailingRatios(QUARTERLY.filter((r) => r.periodEnd !== '2025-12-31'))).toBeUndefined();
  });

  it('keeps the newest row when two rows fall in the same quarter', () => {
    const latest = QUARTERLY[QUARTERLY.length - 1];
    const rows = [...QUARTERLY, { ...latest, periodEnd: '2026-06-29', netIncome: 90 }];
    expect(trailingRatios(rows)?.income.values.netMarginPct).toBe(round4((100 * 225) / 1140));
  });

  it('omits ROE and D/E for zero or negative equity', () => {
    const rows = QUARTERLY.map((r) => (r.periodEnd === '2026-06-30' ? { ...r, stockholdersEquity: -67 } : r));
    expect(trailingRatios(rows)?.balance).toBeUndefined();
  });
});

describe('annualRatios (fallback)', () => {
  it('uses the latest annual statement and the directly preceding year for growth', () => {
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
      income: { periodEnd: '2026-03-31', values: { netMarginPct: 16.3636, revenueGrowthYoYPct: 10 } },
      balance: { periodEnd: '2026-03-31', values: { roePct: 20, debtToEquity: 0.3, rocePct: 23.6364 } },
    });
  });

  it('does not call a two-year gap year-over-year growth', () => {
    const ratios = annualRatios([
      { periodEnd: '2023-03-31', totalRevenue: 800 },
      { periodEnd: '2025-03-31', totalRevenue: 1000, netIncome: 50 },
    ]);
    expect(ratios?.income.values.revenueGrowthYoYPct).toBeUndefined();
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
    // TTM ratio, dated to the latest quarter rather than the fiscal year end.
    expect(snapshot.fundamentals.roePct).toMatchObject({
      status: 'OK',
      value: 20,
      observedAt: '2026-06-30T00:00:00.000Z',
    });
    expect(snapshot.fundamentals.promoterPledgePct.status).toBe('MISSING');
    expect(snapshot.technicals.ema200.status).toBe('OK');
    expect(snapshot.technicals.rsiDivergence).toMatchObject({ value: { lookbackBars: 30 } });
    // Today's (possibly partial) session bar is excluded: the latest bar used is from an earlier day.
    const price = snapshot.technicals.lastPrice;
    expect(price.status === 'OK' && price.observedAt < '2026-10-01').toBe(true);
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

  it('falls back to annual ratios when quarterly data is insufficient', async () => {
    const { snapshot } = await research(MRF, new FakeMarketData(AS_OF, { quarterly: [] }));
    expect(snapshot.fundamentals.roePct).toMatchObject({
      status: 'OK',
      value: 20,
      observedAt: '2026-03-31T00:00:00.000Z',
    });
  });

  it('reports ROE and D/E as missing for negative equity', async () => {
    const market = new FakeMarketData(AS_OF, {
      quarterly: [],
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
