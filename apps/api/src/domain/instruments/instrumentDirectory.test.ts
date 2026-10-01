import { instrumentKey } from '@stock-analysis/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeMarketData } from '../../test-support/fakeMarket.ts';
import { FIXTURE_INSTRUMENTS } from './fixtureInstruments.ts';
import { InstrumentDirectory, InstrumentLookupUnavailableError } from './instrumentDirectory.ts';
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

describe('InstrumentDirectory: web results only resolve on unambiguous intent', () => {
  it('never lets a web match override built-in candidates ("sun" is not Sunoco)', async () => {
    const result = await setup().directory.resolve('sun');
    expect(result.status).toBe('AMBIGUOUS');
    expect(keyOf(result)).toContain('NSE:SUNPHARMA');
  });

  it('treats a lowercase dictionary word that is also a ticker as a search, not a pick', async () => {
    expect(keyOf(await setup().directory.resolve('gold'))).toBe('AMBIGUOUS(NYSE:GOLD,NYSE:NEM)');
  });

  it.each([
    ['GOLD', 'NYSE:GOLD'],
    ['NYSE:GOLD', 'NYSE:GOLD'],
  ])('resolves %j typed as a ticker', async (query, expected) => {
    expect(keyOf(await setup().directory.resolve(query))).toBe(expected);
  });

  it('reports an outage on byKey distinctly from an unknown instrument', async () => {
    const { directory, market } = setup();
    market.failQuote = true;
    await expect(directory.byKey('NASDAQ:MMYT')).rejects.toBeInstanceOf(InstrumentLookupUnavailableError);
  });
});
