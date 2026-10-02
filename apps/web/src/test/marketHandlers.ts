import { http, HttpResponse } from 'msw';
import type { CandleChart, CandleChartFactory } from '../components/PriceChart.tsx';
import type { Candle } from '../lib/candles.ts';
import { intradayChart, liveQuote, movers } from './fixtures.ts';

export const API = 'http://localhost:3000/api/v1';

/** Default responses for the market panels, so tests about research flows don't have to mention them. */
export const marketHandlers = [
  http.get(`${API}/market/movers`, () => HttpResponse.json(movers)),
  http.get(`${API}/stocks`, () => HttpResponse.json({ stocks: [] })),
  http.get(`${API}/market/chart/:key`, () => HttpResponse.json(intradayChart)),
  http.get(`${API}/market/quote/:key`, () => HttpResponse.json(liveQuote())),
];

/** Records what the chart was asked to draw (jsdom has no canvas). */
export function recordingChart() {
  const record = { created: 0, removed: 0, data: [] as Candle[][], updates: [] as Candle[], intraday: [] as boolean[] };
  const factory: CandleChartFactory = (_container, { intraday }) => {
    record.created += 1;
    record.intraday.push(intraday);
    const chart: CandleChart = {
      setData: (candles) => void record.data.push(candles),
      update: (candle) => void record.updates.push(candle),
      remove: () => void (record.removed += 1),
    };
    return Promise.resolve(chart);
  };
  return { record, factory };
}
