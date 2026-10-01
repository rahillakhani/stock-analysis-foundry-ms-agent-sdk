import { describe, expect, it } from 'vitest';
import { instrumentFromYahoo, yahooSymbolFor } from './symbols.ts';

describe('yahooSymbolFor', () => {
  it.each([
    ['NSE', 'MRF', 'MRF.NS'],
    ['BSE', 'MRF', 'MRF.BO'],
    ['NSE', 'M&M', 'M&M.NS'],
    ['NASDAQ', 'MMYT', 'MMYT'],
    ['NYSE', 'BRK-B', 'BRK-B'],
    ['NSE', 'NIFTY', '^NSEI'],
    ['NSE', 'BANKNIFTY', '^NSEBANK'],
  ] as const)('%s:%s -> %s', (exchange, symbol, expected) => {
    expect(yahooSymbolFor(exchange, symbol)).toBe(expected);
  });
});

describe('instrumentFromYahoo', () => {
  const hit = (vendorSymbol: string, exchangeCode: string, quoteType = 'EQUITY', name = 'X Ltd') => ({
    vendorSymbol,
    exchangeCode,
    quoteType,
    name,
  });

  it.each([
    [hit('MRF.NS', 'NSI', 'EQUITY', 'MRF Limited'), { exchange: 'NSE', symbol: 'MRF', name: 'MRF Limited' }],
    [hit('MRF.BO', 'BSE'), { exchange: 'BSE', symbol: 'MRF' }],
    [hit('MMYT', 'NMS', 'EQUITY', 'MakeMyTrip Limited'), { exchange: 'NASDAQ', symbol: 'MMYT' }],
    [hit('IBM', 'NYQ'), { exchange: 'NYSE', symbol: 'IBM' }],
    [hit('BRK-B', 'NYQ', 'EQUITY', 'Berkshire Hathaway Inc.'), { exchange: 'NYSE', symbol: 'BRK-B' }],
  ])('maps %j', (input, expected) => {
    expect(instrumentFromYahoo(input)).toMatchObject({ ...expected, assetType: 'EQUITY' });
  });

  it.each([
    ['another exchange', hit('MRF.JO', 'JNB')],
    ['a mutual fund', hit('MRFOX', 'NAS', 'MUTUALFUND')],
    ['an option', hit('MMYT261120C00050000', 'OPR', 'OPTION')],
    ['an unmapped index', hit('^CRSLDX', 'NSI', 'INDEX')],
    ['a suffix that disagrees with the exchange', hit('MRF.BO', 'NSI')],
    ['a symbol outside our grammar', hit('BRK.B', 'NYQ')],
    ['an empty name', hit('MMYT', 'NMS', 'EQUITY', '  ')],
    ['a US preferred share', hit('F-PB', 'NYQ', 'EQUITY', 'Ford Motor Company 6.20% Notes')],
    ['an Indian ETF', hit('HDFCSILVER.NS', 'NSI', 'EQUITY', 'HDFC Silver ETF')],
  ])('skips %s', (_label, input) => {
    expect(instrumentFromYahoo(input)).toBeUndefined();
  });
});
