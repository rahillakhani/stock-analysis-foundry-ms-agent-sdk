import type { InstrumentRecord } from './instrumentMaster.ts';

// Synthetic MVP symbol list for local development and tests. NOT an authoritative symbol master: names are common
// listings, lot sizes are illustrative, and futures expiries are last-Tuesday dates computed for Sep 2026 – Apr 2027
// without exchange-holiday adjustment (e.g. 2027-01-26 is a market holiday). Replace with a licensed master (Phase 12).

const MONTHLY_EXPIRIES = [
  '2026-09-29',
  '2026-10-27',
  '2026-11-24',
  '2026-12-29',
  '2027-01-26',
  '2027-02-23',
  '2027-03-30',
  '2027-04-27',
] as const;

const nse = (symbol: string, name: string, aliases: string[] = [], fno?: { lotSize: number }): InstrumentRecord => ({
  exchange: 'NSE',
  symbol,
  name,
  assetType: 'EQUITY',
  aliases,
  ...(fno ? { futuresExpiries: MONTHLY_EXPIRIES, futuresLotSize: fno.lotSize } : {}),
});

export const FIXTURE_INSTRUMENTS: readonly InstrumentRecord[] = [
  {
    exchange: 'NSE',
    symbol: 'NIFTY',
    name: 'Nifty 50',
    assetType: 'INDEX',
    aliases: ['Nifty', 'Nifty 50 Index'],
    futuresExpiries: MONTHLY_EXPIRIES,
    futuresLotSize: 75,
  },
  {
    exchange: 'NSE',
    symbol: 'BANKNIFTY',
    name: 'Nifty Bank',
    assetType: 'INDEX',
    aliases: ['Bank Nifty', 'Nifty Bank Index'],
    futuresExpiries: MONTHLY_EXPIRIES,
    futuresLotSize: 35,
  },
  nse('RELIANCE', 'Reliance Industries Ltd', ['Reliance', 'RIL'], { lotSize: 500 }),
  nse('TCS', 'Tata Consultancy Services Ltd', ['Tata Consultancy'], { lotSize: 175 }),
  nse('INFY', 'Infosys Ltd', ['Infosys'], { lotSize: 400 }),
  nse('HDFCBANK', 'HDFC Bank Ltd', ['HDFC Bank'], { lotSize: 550 }),
  nse('ICICIBANK', 'ICICI Bank Ltd', ['ICICI Bank'], { lotSize: 700 }),
  nse('SBIN', 'State Bank of India', ['SBI'], { lotSize: 750 }),
  nse('ITC', 'ITC Ltd'),
  nse('LT', 'Larsen & Toubro Ltd', ['L&T', 'Larsen and Toubro']),
  nse('HINDUNILVR', 'Hindustan Unilever Ltd', ['HUL', 'Hindustan Unilever']),
  nse('BHARTIARTL', 'Bharti Airtel Ltd', ['Airtel', 'Bharti Airtel']),
  nse('KOTAKBANK', 'Kotak Mahindra Bank Ltd', ['Kotak Bank', 'Kotak Mahindra Bank']),
  nse('AXISBANK', 'Axis Bank Ltd', ['Axis Bank']),
  nse('TATASTEEL', 'Tata Steel Ltd', ['Tata Steel'], { lotSize: 5500 }),
  nse('TATAPOWER', 'Tata Power Company Ltd', ['Tata Power']),
  nse('TATACONSUM', 'Tata Consumer Products Ltd', ['Tata Consumer']),
  nse('WIPRO', 'Wipro Ltd'),
  nse('HCLTECH', 'HCL Technologies Ltd', ['HCL Tech', 'HCL Technologies']),
  nse('TECHM', 'Tech Mahindra Ltd', ['Tech Mahindra']),
  nse('MARUTI', 'Maruti Suzuki India Ltd', ['Maruti Suzuki', 'Maruti']),
  nse('M&M', 'Mahindra & Mahindra Ltd', ['Mahindra and Mahindra', 'M and M']),
  nse('BAJAJ-AUTO', 'Bajaj Auto Ltd', ['Bajaj Auto']),
  nse('BAJFINANCE', 'Bajaj Finance Ltd', ['Bajaj Finance']),
  nse('SUNPHARMA', 'Sun Pharmaceutical Industries Ltd', ['Sun Pharma']),
  nse('ASIANPAINT', 'Asian Paints Ltd', ['Asian Paints']),
  nse('TITAN', 'Titan Company Ltd', ['Titan']),
  nse('ULTRACEMCO', 'UltraTech Cement Ltd', ['UltraTech', 'Ultratech Cement']),
  nse('NTPC', 'NTPC Ltd'),
  nse('POWERGRID', 'Power Grid Corporation of India Ltd', ['Power Grid']),
  nse('ONGC', 'Oil and Natural Gas Corporation Ltd', ['Oil and Natural Gas']),
  nse('COALINDIA', 'Coal India Ltd', ['Coal India']),
  nse('JSWSTEEL', 'JSW Steel Ltd', ['JSW Steel']),
  nse('HINDALCO', 'Hindalco Industries Ltd', ['Hindalco']),
  { exchange: 'BSE', symbol: 'RELIANCE', name: 'Reliance Industries Ltd', assetType: 'EQUITY', aliases: ['Reliance'] },
  { exchange: 'BSE', symbol: 'TATASTEEL', name: 'Tata Steel Ltd', assetType: 'EQUITY', aliases: ['Tata Steel'] },
];
