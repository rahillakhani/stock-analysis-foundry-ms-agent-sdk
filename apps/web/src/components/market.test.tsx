import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api/client.ts';
import { analysedStocks, intradayChart, liveQuote, TATA } from '../test/fixtures.ts';
import { API, marketHandlers, recordingChart } from '../test/marketHandlers.ts';
import { MarketMovers } from './MarketMovers.tsx';
import { PriceChart } from './PriceChart.tsx';
import { RecentStocks } from './RecentStocks.tsx';

const server = setupServer(...marketHandlers);
const requests: string[] = [];
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on(
    'request:start',
    ({ request }) => void requests.push(new URL(request.url).pathname + new URL(request.url).search),
  );
});
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => server.close());

// Resolve fetch per call: MSW patches the global after this module loads.
const api = createApiClient((input, init) => fetch(input, init));
const problem = (status: number, code?: string) =>
  HttpResponse.json({ type: 'about:blank', title: 'x', status, detail: 'x', ...(code ? { code } : {}) }, { status });

describe('MarketMovers', () => {
  it('lists gainers and losers with sign and market state, and looks one up on click', async () => {
    const onSelect = vi.fn();
    render(<MarketMovers api={api} onSelect={onSelect} />);

    const gainers = await screen.findByRole('region', { name: 'Top gainers' });
    expect(within(gainers).getByText('INFY')).toBeInTheDocument();
    expect(within(gainers).getByText('+4.11%')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Top losers' })).getByText('−7.62%')).toBeInTheDocument();
    expect(screen.getByText(/NIFTY 50 · Market closed \(post-close session\)/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Bajaj Auto Ltd\./ }));
    expect(onSelect).toHaveBeenCalledWith('NSE:BAJAJ-AUTO');
  });

  it('explains when live data is turned off, and retries on request', async () => {
    server.use(http.get(`${API}/market/movers`, () => problem(503, 'MARKET_DATA_DISABLED')));
    render(<MarketMovers api={api} onSelect={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Live market data is turned off');
    server.resetHandlers();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Top gainers' })).toBeInTheDocument();
  });

  it('shows loading again while a retry is in flight', async () => {
    server.use(http.get(`${API}/market/movers`, () => problem(503)));
    render(<MarketMovers api={api} onSelect={vi.fn()} />);
    await screen.findByRole('alert');
    server.use(http.get(`${API}/market/movers`, () => new Promise<never>(() => undefined)));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Loading movers…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the last movers when a refresh fails', async () => {
    render(<MarketMovers api={api} onSelect={vi.fn()} refreshMs={20} />);
    await screen.findByRole('region', { name: 'Top gainers' });
    server.use(http.get(`${API}/market/movers`, () => problem(503)));
    expect(await screen.findByText('Could not refresh; showing the last data.')).toBeInTheDocument();
    expect(screen.getByText('INFY')).toBeInTheDocument();
  });
});

describe('RecentStocks', () => {
  it('shows an empty state before anything is analysed', async () => {
    render(<RecentStocks api={api} onSelect={vi.fn()} />);
    expect(await screen.findByText(/Stocks you analyse appear here/)).toBeInTheDocument();
  });

  it('lists analysed stocks with signal, confidence and age, and reloads when a new analysis completes', async () => {
    server.use(http.get(`${API}/stocks`, () => HttpResponse.json(analysedStocks('BUY'))));
    const onSelect = vi.fn();
    const { rerender } = render(<RecentStocks api={api} onSelect={onSelect} refreshToken="run-1" />);

    const row = await screen.findByRole('button', { name: /Tata Steel Ltd/ });
    expect(row).toHaveTextContent('BUY');
    expect(row).toHaveTextContent('75% confidence');
    expect(row.querySelector('time')).toHaveAttribute('dateTime', '2026-09-30T10:00:02.000Z');
    expect(row).toHaveTextContent('policy v2');
    // Freshness at a glance: the fixture run was PARTIAL and is days old.
    expect(row).toHaveTextContent('partial data · may be out of date');
    expect(screen.getByText(/Not investment advice/)).toBeInTheDocument();

    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('NSE:TATASTEEL');

    const before = requests.filter((r) => r === '/api/v1/stocks').length;
    rerender(<RecentStocks api={api} onSelect={onSelect} refreshToken="run-2" />);
    await waitFor(() => expect(requests.filter((r) => r === '/api/v1/stocks').length).toBe(before + 1));
  });
});

describe('PriceChart', () => {
  const renderChart = (factory = recordingChart().factory, quoteIntervalMs = 60_000) =>
    render(
      <PriceChart
        api={api}
        instrument={TATA}
        instrumentKey="NSE:TATASTEEL"
        chartFactory={factory}
        quoteIntervalMs={quoteIntervalMs}
      />,
    );

  it('shows the live ticker and draws the latest session, then moves the last candle with the quote', async () => {
    const { record, factory } = recordingChart();
    renderChart(factory);

    expect(await screen.findByTestId('live-price')).toHaveTextContent('₹152.50');
    expect(screen.getByText(/\+2\.50 \(\+1\.67%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Market open · last trade 9:22 am IST/i)).toBeInTheDocument();
    await waitFor(() => expect(record.data).toHaveLength(1));
    expect(record.intraday).toEqual([true]);
    expect(record.data[0]).toHaveLength(2);
    // The 09:22 quote falls in the 09:20 candle: its close follows the ticker.
    await waitFor(() => expect(record.updates.at(-1)).toMatchObject({ close: 152.5, high: 153 }));
  });

  it('switches to a year of daily candles on a new chart', async () => {
    const { record, factory } = recordingChart();
    renderChart(factory);
    await waitFor(() => expect(record.created).toBe(1));

    await userEvent.click(screen.getByRole('button', { name: '1Y' }));
    expect(screen.getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(record.created).toBe(2));
    expect(record.removed).toBe(1);
    expect(record.intraday).toEqual([true, false]);
    expect(requests).toContain('/api/v1/market/chart/NSE%3ATATASTEEL?interval=1d');
  });

  it('never draws on a removed chart when the range is switched back quickly', async () => {
    const { record, factory } = recordingChart();
    const drawnAfterRemoval: number[] = [];
    const guarded: typeof factory = async (container, options) => {
      const chart = await factory(container, options);
      let removed = false;
      return {
        setData: (c) => (removed ? drawnAfterRemoval.push(1) : chart.setData(c)),
        update: (c) => (removed ? drawnAfterRemoval.push(1) : chart.update(c)),
        remove: () => {
          removed = true;
          chart.remove();
        },
      };
    };
    server.use(
      http.get(`${API}/market/chart/:key`, async ({ request }) => {
        if (new URL(request.url).searchParams.get('interval') === '1d') await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(intradayChart);
      }),
    );
    renderChart(guarded);
    await waitFor(() => expect(record.data).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: '1Y' }));
    await userEvent.click(screen.getByRole('button', { name: '1D' }));
    await waitFor(() => expect(record.data.length).toBeGreaterThanOrEqual(2));
    expect(drawnAfterRemoval).toEqual([]);
  });

  it('shows an unchanged price as neither up nor down', async () => {
    server.use(http.get(`${API}/market/quote/:key`, () => HttpResponse.json(liveQuote(150))));
    renderChart();
    expect(await screen.findByText('unchanged today')).toBeInTheDocument();
  });

  it('offers a retry when the chart cannot load', async () => {
    let fail = true;
    server.use(http.get(`${API}/market/chart/:key`, () => (fail ? problem(503) : HttpResponse.json(intradayChart))));
    const { record, factory } = recordingChart();
    renderChart(factory);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await userEvent.click(retry);
    await waitFor(() => expect(record.data).toHaveLength(1));
  });

  it('polls the ticker', async () => {
    let price = 152.5;
    server.use(http.get(`${API}/market/quote/:key`, () => HttpResponse.json(liveQuote((price += 1)))));
    renderChart(undefined, 20);
    await waitFor(() => expect(screen.getByTestId('live-price')).toHaveTextContent('₹155.50'));
  });

  it('shows why there is no chart or price when market data is unavailable', async () => {
    server.use(
      http.get(`${API}/market/chart/:key`, () => problem(503)),
      http.get(`${API}/market/quote/:key`, () => problem(503)),
    );
    renderChart();
    expect(await screen.findAllByText('Market data is unavailable right now.')).toHaveLength(2);
  });

  it('shows an empty state when there are no bars', async () => {
    server.use(
      http.get(`${API}/market/chart/:key`, () =>
        HttpResponse.json({ instrumentKey: 'NSE:TATASTEEL', currency: 'INR', interval: '5m', bars: [] }),
      ),
    );
    renderChart();
    expect(await screen.findByText('No price history is available for this range.')).toBeInTheDocument();
  });

  it('reports a chart that cannot be drawn', async () => {
    renderChart(() => Promise.reject(new Error('no canvas')));
    expect(await screen.findByText('The chart could not be drawn.')).toBeInTheDocument();
  });
});
