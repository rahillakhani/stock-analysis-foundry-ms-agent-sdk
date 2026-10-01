import { instrumentKey } from '@stock-analysis/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeMarketData } from '../../test-support/fakeMarket.ts';
import { FIXTURE_INSTRUMENTS } from './fixtureInstruments.ts';
import { InstrumentDirectory } from './instrumentDirectory.ts';
import { InMemoryInstrumentMaster } from './instrumentMaster.ts';
import { InstrumentResolver, type Resolution } from './resolveInstrument.ts';

const NOW = new Date('2026-10-01T10:00:00.000Z');
const setup = () => {
  const market = new FakeMarketData(NOW);
  const resolver = new InstrumentResolver(new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS), () => NOW);
  return { market, directory: new InstrumentDirectory(resolver, market, pino({ level: 'silent' })) };
};
const keyOf = (r: Resolution) =>
  r.status === 'RESOLVED'
    ? instrumentKey(r.instrument)
    : r.status === 'AMBIGUOUS'
      ? `AMBIGUOUS(${r.candidates.map(instrumentKey).join(',')})`
      : 'NOT_FOUND';

describe('InstrumentDirectory.resolve', () => {
  it.each([
    ['MRF', 'NSE:MRF'],
    ['mrf', 'NSE:MRF'],
    ['MMYT', 'NASDAQ:MMYT'],
    ['makemytrip', 'NASDAQ:MMYT'],
    ['NASDAQ:MMYT', 'NASDAQ:MMYT'],
    ['BSE:MRF', 'BSE:MRF'],
  ])('finds %j on the web -> %s', async (query, expected) => {
    expect(keyOf(await setup().directory.resolve(query))).toBe(expected);
  });

  it('returns candidates, not a guess, for a partial name', async () => {
    expect(keyOf(await setup().directory.resolve('make'))).toBe('AMBIGUOUS(NASDAQ:MMYT,NASDAQ:MKTX)');
  });

  it('prefers the built-in list and does not search the web for an exact local match', async () => {
    const { directory, market } = setup();
    expect(keyOf(await directory.resolve('Tata Steel'))).toBe('NSE:TATASTEEL');
    expect(market.calls).toEqual([]);
  });

  it('keeps futures lookups local', async () => {
    const { directory, market } = setup();
    expect(keyOf(await directory.resolve('Nifty 50 Futures'))).toBe('NSE:NIFTY:FUT:2026-10-27');
    expect(market.calls).toEqual([]);
  });

  it('falls back to built-in results when the web search fails', async () => {
    const { directory, market } = setup();
    market.failSearch = true;
    expect(keyOf(await directory.resolve('MRF'))).toBe('NOT_FOUND');
    expect(keyOf(await directory.resolve('tata'))).toMatch(/^AMBIGUOUS\(NSE:TATACONSUM/);
  });

  it('returns NOT_FOUND when nothing matches anywhere', async () => {
    expect(keyOf(await setup().directory.resolve('zzznotreal'))).toBe('NOT_FOUND');
  });
});

describe('InstrumentDirectory.search and byKey', () => {
  it('adds web results to autocomplete without duplicates', async () => {
    const results = await setup().directory.search('mrf');
    expect(results.map(instrumentKey)).toEqual(['NSE:MRF']);
  });

  it('confirms a web-only key with a quote, and rejects unknown or mismatched keys', async () => {
    const { directory } = setup();
    expect(await directory.byKey('NASDAQ:MMYT')).toMatchObject({ name: 'MakeMyTrip Limited' });
    expect(await directory.byKey('NYSE:MMYT')).toBeUndefined();
    expect(await directory.byKey('NASDAQ:ZZZZ')).toBeUndefined();
    expect(await directory.byKey('NSE:TATASTEEL')).toMatchObject({ name: 'Tata Steel Ltd' });
  });
});
