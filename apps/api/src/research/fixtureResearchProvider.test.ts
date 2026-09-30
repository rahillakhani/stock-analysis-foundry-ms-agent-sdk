import { instrumentKey, type Instrument } from '@stock-analysis/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V1 } from '../domain/decision/policy.ts';
import { FIXTURE_INSTRUMENTS } from '../domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { InstrumentResolver } from '../domain/instruments/resolveInstrument.ts';
import { FixtureResearchProvider } from './fixtureResearchProvider.ts';
import { aggregateResearch } from './researchAggregator.ts';

const AS_OF = new Date('2026-09-30T10:00:00.000Z');
const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
const fixture = new FixtureResearchProvider(master);
const resolver = new InstrumentResolver(master, () => AS_OF);
const signal = () => new AbortController().signal;

const instrument = (query: string): Instrument => {
  const resolution = resolver.resolve(query);
  if (resolution.status !== 'RESOLVED') throw new Error(`fixture query ${query} did not resolve`);
  return resolution.instrument;
};

describe('FixtureResearchProvider', () => {
  it('is deterministic for the same stock and day', async () => {
    const a = await aggregateResearch(fixture, instrument('TATASTEEL'), AS_OF, signal());
    const b = await aggregateResearch(fixture, instrument('TATASTEEL'), AS_OF, signal());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('varies by stock and by day', async () => {
    const tata = await aggregateResearch(fixture, instrument('TATASTEEL'), AS_OF, signal());
    const infy = await aggregateResearch(fixture, instrument('INFY'), AS_OF, signal());
    const nextDay = await aggregateResearch(
      fixture,
      instrument('TATASTEEL'),
      new Date('2026-10-01T10:00:00.000Z'),
      signal(),
    );
    expect(tata.snapshot.technicals.lastPrice).not.toEqual(infy.snapshot.technicals.lastPrice);
    expect(tata.snapshot.technicals.lastPrice).not.toEqual(nextDay.snapshot.technicals.lastPrice);
  });

  it('produces complete, valid research for every fixture instrument and its futures', async () => {
    const queries = FIXTURE_INSTRUMENTS.map((r) => `${r.exchange}:${r.symbol}`);
    const futures = FIXTURE_INSTRUMENTS.filter((r) => r.futuresExpiries).map((r) => `NSE:${r.symbol} FUT`);
    for (const query of [...queries, ...futures]) {
      const result = await aggregateResearch(fixture, instrument(query), AS_OF, signal());
      expect(result.unavailableDimensions, query).toEqual([]);
    }
  });

  it('marks derivatives NOT_APPLICABLE only for stocks without F&O, and fundamentals MISSING for indices', async () => {
    const itc = await aggregateResearch(fixture, instrument('ITC'), AS_OF, signal());
    const reliance = await aggregateResearch(fixture, instrument('RELIANCE'), AS_OF, signal());
    const nifty = await aggregateResearch(fixture, instrument('Nifty 50'), AS_OF, signal());

    expect(itc.snapshot.derivatives.inFnoBan.status).toBe('NOT_APPLICABLE');
    expect(reliance.snapshot.derivatives.inFnoBan.status).toBe('OK');
    // The nearest contract still trading on 2026-09-30 (September's expired on the 29th).
    expect(reliance.snapshot.derivatives.nearMonthExpiry.value).toBe('2026-10-27');
    expect(nifty.snapshot.fundamentals.roePct.status).toBe('MISSING');
  });

  it('gives stock futures company fundamentals and a contract price consistent with the futures data', async () => {
    const future = await aggregateResearch(fixture, instrument('RELIANCE FUT'), AS_OF, signal());
    expect(future.snapshot.fundamentals.roePct.status).toBe('OK');
    expect(future.snapshot.technicals.lastPrice.value).toBe(future.snapshot.derivatives.futuresPrice.value);
    const indexFuture = await aggregateResearch(fixture, instrument('NIFTY FUT'), AS_OF, signal());
    expect(indexFuture.snapshot.fundamentals.roePct.status).toBe('MISSING');
  });

  it('uses the last three completed calendar quarters', async () => {
    const result = await aggregateResearch(fixture, instrument('INFY'), AS_OF, signal());
    expect(result.snapshot.fundamentals.operatingMarginPctQuarterly.value?.map((q) => q.period)).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
    ]);
  });

  it('yields a mix of verdicts across the fixture list (useful for demos)', async () => {
    const indicators = new Set<string>();
    for (const record of FIXTURE_INSTRUMENTS.filter((r) => r.assetType === 'EQUITY')) {
      const { snapshot } = await aggregateResearch(
        fixture,
        instrument(`${record.exchange}:${record.symbol}`),
        AS_OF,
        signal(),
      );
      indicators.add(evaluate(snapshot, POLICY_V1, AS_OF).indicator);
    }
    expect(indicators.size).toBeGreaterThanOrEqual(2);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      fixture.fetch('fundamentals', instrument('INFY'), { asOf: AS_OF, signal: controller.signal }),
    ).rejects.toThrow('stop');
  });

  it('cites a per-dimension, per-day source id', async () => {
    const result = await aggregateResearch(fixture, instrument('M&M'), AS_OF, signal());
    expect(result.snapshot.sources.map((s) => s.id).sort()).toEqual([
      'fixture:derivatives:m-m:2026-09-30',
      'fixture:fundamentals:m-m:2026-09-30',
      'fixture:sentiment:m-m:2026-09-30',
      'fixture:technicals:m-m:2026-09-30',
    ]);
    expect(instrumentKey(result.snapshot.instrument)).toBe('NSE:M&M');
  });
});
