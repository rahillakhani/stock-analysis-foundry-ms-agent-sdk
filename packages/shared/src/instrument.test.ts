import { describe, expect, it } from 'vitest';
import {
  currencyFor,
  Instrument,
  InstrumentKey,
  instrumentKey,
  isIndianExchange,
  parseInstrumentKey,
  TradingSymbol,
} from './instrument.ts';
import { equity, niftyFuture } from './test-support/fixtures.ts';

describe('TradingSymbol', () => {
  it.each(['TATASTEEL', 'M&M', 'BAJAJ-AUTO', 'NIFTY', '3MINDIA'])('accepts %s', (symbol) => {
    expect(TradingSymbol.safeParse(symbol).success).toBe(true);
  });

  it.each(['tatasteel', 'TATA STEEL', '', '-ABC', 'A'.repeat(21), 'RELIANCE.NS'])('rejects %j', (symbol) => {
    expect(TradingSymbol.safeParse(symbol).success).toBe(false);
  });
});

describe('Instrument', () => {
  it('accepts an equity, an index, and a future with contract details', () => {
    expect(Instrument.parse(equity)).toEqual(equity);
    expect(Instrument.parse({ ...equity, assetType: 'INDEX' }).assetType).toBe('INDEX');
    expect(Instrument.parse(niftyFuture)).toEqual(niftyFuture);
  });

  it('rejects a future without contract details', () => {
    expect(Instrument.safeParse({ ...equity, assetType: 'FUTURE' }).success).toBe(false);
  });

  it('rejects an equity that carries contract details instead of silently dropping them', () => {
    expect(Instrument.safeParse({ ...equity, contract: niftyFuture.contract }).success).toBe(false);
  });

  it.each([
    ['unsupported exchange', { ...equity, exchange: 'LSE' }],
    ['invalid expiry date', { ...niftyFuture, contract: { ...niftyFuture.contract, expiry: '2026-02-30' } }],
    ['zero lot size', { ...niftyFuture, contract: { ...niftyFuture.contract, lotSize: 0 } }],
    ['empty name', { ...equity, name: '' }],
    ['unknown extra field', { ...equity, isin: 'INE081A01020' }],
  ])('rejects %s', (_label, input) => {
    expect(Instrument.safeParse(input).success).toBe(false);
  });
});

describe('instrumentKey', () => {
  it('uses EXCHANGE:SYMBOL for equities and appends the expiry for futures', () => {
    expect(instrumentKey(equity)).toBe('NSE:TATASTEEL');
    expect(instrumentKey(niftyFuture)).toBe('NSE:NIFTY:FUT:2026-10-27');
  });

  it('round-trips through parseInstrumentKey', () => {
    expect(parseInstrumentKey(instrumentKey(equity))).toEqual({
      exchange: 'NSE',
      symbol: 'TATASTEEL',
      futureExpiry: undefined,
    });
    expect(parseInstrumentKey(instrumentKey(niftyFuture))).toEqual({
      exchange: 'NSE',
      symbol: 'NIFTY',
      futureExpiry: '2026-10-27',
    });
    expect(parseInstrumentKey('garbage')).toBeUndefined();
  });

  it('produces keys that satisfy the InstrumentKey schema', () => {
    expect(InstrumentKey.safeParse(instrumentKey(equity)).success).toBe(true);
    expect(InstrumentKey.safeParse(instrumentKey(niftyFuture)).success).toBe(true);
  });

  it.each(['NASDAQ:MMYT', 'NYSE:IBM', 'BSE:MRF', 'BSE:SENSEX:FUT:2026-10-29'])('InstrumentKey accepts %j', (key) => {
    expect(InstrumentKey.safeParse(key).success).toBe(true);
  });

  it.each([
    'LSE:VOD',
    'NASDAQ:MMYT:FUT:2026-10-27',
    'NYSE:IBM:FUT:2026-10-27',
    'NSE:tatasteel',
    'TATASTEEL',
    'NSE:NIFTY:FUT:2026-1-1',
    'NSE:NIFTY:FUT',
    'NSE:M&M ',
    'NSE:NIFTY:FUT:2026-99-99',
    'NSE:NIFTY:FUT:2026-02-30',
  ])('InstrumentKey rejects %j', (key) => {
    expect(InstrumentKey.safeParse(key).success).toBe(false);
  });
});

describe('exchange helpers', () => {
  it.each([
    ['NSE', true, 'INR'],
    ['BSE', true, 'INR'],
    ['NASDAQ', false, 'USD'],
    ['NYSE', false, 'USD'],
  ] as const)('%s: indian=%s currency=%s', (exchange, indian, currency) => {
    expect(isIndianExchange(exchange)).toBe(indian);
    expect(currencyFor(exchange)).toBe(currency);
  });
});
