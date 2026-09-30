import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import {
  completedRun,
  failedRun,
  inFlight,
  OTHER_RUN_ID,
  resolvedExisting,
  resolvedNew,
  RUN_ID,
  timelineEntry,
} from './test/fixtures.ts';

const API = 'http://localhost:3000/api/v1';
const server = setupServer();
const calls: { method: string; path: string; body?: unknown }[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', async ({ request }) => {
    const url = new URL(request.url);
    const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined;
    calls.push({ method: request.method, path: url.pathname + url.search, body });
  });
});
afterEach(() => {
  server.resetHandlers();
  calls.length = 0;
});
afterAll(() => server.close());

const renderApp = () => render(<App pollIntervalMs={5} searchDebounceMs={5} />);

async function submit(query: string) {
  const user = userEvent.setup();
  const input = screen.getByRole('combobox', { name: /stock symbol or company name/i });
  await user.clear(input);
  await user.type(input, query);
  await user.click(screen.getByRole('button', { name: 'Analyse' }));
  return user;
}

/** Lookup returns `first` until an analysis completes, then `after` (the re-read that includes the new run). */
function lookupSequence(...responses: unknown[]) {
  let index = 0;
  return http.post(`${API}/stock/lookup`, () =>
    HttpResponse.json(responses[Math.min(index++, responses.length - 1)] as object),
  );
}

const noSuggestions = http.get(`${API}/stock/search`, () => HttpResponse.json({ candidates: [] }));

describe('App: analysing a new stock (spec steps 1–4)', () => {
  it('runs research for an unseen stock, polls, and shows the full result with context', async () => {
    let polls = 0;
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew, resolvedExisting(completedRun(), [timelineEntry()], 3)),
      http.post(`${API}/stock/analyze`, () => HttpResponse.json({ runId: RUN_ID, status: 'PENDING' }, { status: 202 })),
      http.get(`${API}/analysis-runs/${RUN_ID}`, () =>
        HttpResponse.json(polls++ < 2 ? inFlight('RUNNING') : completedRun()),
      ),
    );
    renderApp();
    await submit('Tata Steel');

    const result = await screen.findByRole('article', { name: /analysis of tata steel ltd/i });
    // The headline badge comes first; the same label also appears in the history timeline.
    expect(within(result).getAllByText("DON'T BUY")[0]).toBeInTheDocument();
    expect(within(result).getAllByText('75% confidence')[0]).toBeInTheDocument();
    expect(within(result).getByText(/analysed/i)).toHaveTextContent(/just now/);
    expect(within(result).getByRole('note')).toHaveTextContent(/sample data/i);
    expect(within(result).getByText(/not investment advice/i)).toBeInTheDocument();
    expect(within(result).getByRole('meter', { name: 'Fundamentals score' })).toHaveAttribute('aria-valuenow', '71.4');
    expect(within(result).getByText('No F&O contract for this instrument.')).toBeInTheDocument();
    expect(within(result).getByText('Operating margin shrinking for 3 quarters.')).toBeInTheDocument();
    expect(within(result).getByRole('list', { name: 'Analysis history' })).toHaveTextContent(/initial research/i);
    expect(calls.find((c) => c.path.endsWith('/stock/analyze'))?.body).toEqual({
      instrumentKey: 'NSE:TATASTEEL',
      force: false,
    });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('shows a PARTIAL warning naming the unavailable dimension', async () => {
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew, resolvedExisting(completedRun({ status: 'PARTIAL' }))),
      http.post(`${API}/stock/analyze`, () => HttpResponse.json({ runId: RUN_ID, status: 'PENDING' }, { status: 202 })),
      http.get(`${API}/analysis-runs/${RUN_ID}`, () => HttpResponse.json(completedRun({ status: 'PARTIAL' }))),
    );
    renderApp();
    await submit('TATASTEEL');
    expect(await screen.findByText(/partial research/i)).toBeInTheDocument();
    expect(screen.getByText(/unavailable: sentiment/i)).toBeInTheDocument();
  });

  it('follows the running analysis when one is already in flight (409 RUN_IN_FLIGHT)', async () => {
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew, resolvedExisting(completedRun({ id: OTHER_RUN_ID }))),
      http.post(`${API}/stock/analyze`, () =>
        HttpResponse.json(
          { status: 409, code: 'RUN_IN_FLIGHT', runId: OTHER_RUN_ID, detail: 'running' },
          { status: 409 },
        ),
      ),
      http.get(`${API}/analysis-runs/${OTHER_RUN_ID}`, () => HttpResponse.json(completedRun({ id: OTHER_RUN_ID }))),
    );
    renderApp();
    await submit('TATASTEEL');
    expect(await screen.findByRole('article')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith(`/analysis-runs/${OTHER_RUN_ID}`))).toBe(true);
  });

  it('shows a failed run with its safe message and lets the user try again', async () => {
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew),
      http.post(`${API}/stock/analyze`, () => HttpResponse.json({ runId: RUN_ID, status: 'PENDING' }, { status: 202 })),
      http.get(`${API}/analysis-runs/${RUN_ID}`, () => HttpResponse.json(failedRun)),
    );
    renderApp();
    const user = await submit('TATASTEEL');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The analysis could not be completed. Please try again.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/stock/analyze'))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith('/stock/analyze'))[1]?.body).toEqual({
      instrumentKey: 'NSE:TATASTEEL',
      force: true,
    });
  });

  it('stops polling when the user stops waiting', async () => {
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew),
      http.post(`${API}/stock/analyze`, () => HttpResponse.json({ runId: RUN_ID, status: 'PENDING' }, { status: 202 })),
      http.get(`${API}/analysis-runs/${RUN_ID}`, () => HttpResponse.json(inFlight('RUNNING'))),
    );
    renderApp();
    const user = await submit('TATASTEEL');

    await user.click(await screen.findByRole('button', { name: 'Stop waiting' }));
    expect(screen.getByText(/stopped waiting/i)).toBeInTheDocument();
    const pollsAfterStop = calls.filter((c) => c.path.includes('/analysis-runs/')).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.path.includes('/analysis-runs/')).length).toBe(pollsAfterStop);
  });

  it('stops polling when unmounted', async () => {
    server.use(
      noSuggestions,
      lookupSequence(resolvedNew),
      http.post(`${API}/stock/analyze`, () => HttpResponse.json({ runId: RUN_ID, status: 'PENDING' }, { status: 202 })),
      http.get(`${API}/analysis-runs/${RUN_ID}`, () => HttpResponse.json(inFlight('PENDING'))),
    );
    const { unmount } = renderApp();
    await submit('TATASTEEL');
    await screen.findByRole('region', { name: 'Analysis in progress' });
    unmount();
    const count = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(count);
  });
});

describe('App: an existing analysis (spec step 1 prompt)', () => {
  it('asks before re-analysing and shows the existing analysis on "View existing" without a new run', async () => {
    server.use(noSuggestions, lookupSequence(resolvedExisting()));
    renderApp();
    const user = await submit('Tata Steel');

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/record found for tata steel ltd/i);
    expect(dialog).toHaveTextContent(/last analysed 2 hours ago/i);
    await user.click(within(dialog).getByRole('button', { name: 'View existing' }));

    expect(await screen.findByRole('article')).toHaveTextContent(/2 hours ago/);
    expect(calls.some((c) => c.path.endsWith('/stock/analyze'))).toBe(false);
  });

  it('runs a forced re-analysis on confirmation and shows the grown timeline', async () => {
    const second = completedRun({ id: OTHER_RUN_ID, indicator: 'NEUTRAL' });
    server.use(
      noSuggestions,
      lookupSequence(
        resolvedExisting(),
        resolvedExisting(second, [timelineEntry(), timelineEntry(OTHER_RUN_ID, 'RE_ANALYSIS')], 1),
      ),
      http.post(`${API}/stock/analyze`, () =>
        HttpResponse.json({ runId: OTHER_RUN_ID, status: 'PENDING' }, { status: 202 }),
      ),
      http.get(`${API}/analysis-runs/${OTHER_RUN_ID}`, () => HttpResponse.json(second)),
    );
    renderApp();
    const user = await submit('Tata Steel');
    await user.click(await screen.findByRole('button', { name: 'Run fresh re-analysis' }));

    const result = await screen.findByRole('article');
    expect(within(result).getAllByText('NEUTRAL')[0]).toBeInTheDocument();
    expect(within(result).getByRole('list', { name: 'Analysis history' }).children).toHaveLength(2);
    expect(calls.find((c) => c.path.endsWith('/stock/analyze'))?.body).toEqual({
      instrumentKey: 'NSE:TATASTEEL',
      force: true,
    });
  });
});

describe('App: lookup outcomes and errors', () => {
  it('offers candidates for partial input and looks up the chosen key', async () => {
    server.use(
      noSuggestions,
      lookupSequence(
        {
          status: 'AMBIGUOUS',
          candidates: [
            { key: 'NSE:TATASTEEL', exchange: 'NSE', symbol: 'TATASTEEL', assetType: 'EQUITY', name: 'Tata Steel Ltd' },
            { key: 'NSE:TATAPOWER', exchange: 'NSE', symbol: 'TATAPOWER', assetType: 'EQUITY', name: 'Tata Power' },
          ],
        },
        resolvedExisting(),
      ),
    );
    renderApp();
    const user = await submit('tata');

    const list = await screen.findByRole('region', { name: 'Did you mean' });
    await user.click(within(list).getByRole('button', { name: /tata steel ltd/i }));
    await screen.findByRole('alertdialog');
    expect(calls.filter((c) => c.path.endsWith('/stock/lookup')).map((c) => c.body)).toEqual([
      { query: 'tata' },
      { query: 'NSE:TATASTEEL' },
    ]);
  });

  it('says so when nothing matches', async () => {
    server.use(noSuggestions, lookupSequence({ status: 'NOT_FOUND' }));
    renderApp();
    await submit('ZZZNOTREAL');
    expect(await screen.findByText(/no instrument matches “zzznotreal”/i)).toBeInTheDocument();
  });

  it('shows a generic message for server errors and retries the lookup', async () => {
    let attempts = 0;
    server.use(
      noSuggestions,
      http.post(`${API}/stock/lookup`, () =>
        attempts++ === 0
          ? HttpResponse.json({ status: 500, detail: 'db connection string leaked?' }, { status: 500 })
          : HttpResponse.json({ status: 'NOT_FOUND' }),
      ),
    );
    renderApp();
    const user = await submit('INFY');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server had a problem. Please try again.');
    expect(alert).not.toHaveTextContent(/leaked/);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/no instrument matches/i)).toBeInTheDocument();
  });

  it('explains when the server is unreachable', async () => {
    server.use(
      noSuggestions,
      http.post(`${API}/stock/lookup`, () => HttpResponse.error()),
    );
    renderApp();
    await submit('INFY');
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
  });
});

describe('SearchBar autocomplete', () => {
  it('suggests matches and submits the highlighted key with the keyboard', async () => {
    server.use(
      http.get(`${API}/stock/search`, () =>
        HttpResponse.json({
          candidates: [
            {
              key: 'NSE:NIFTY:FUT:2026-10-27',
              exchange: 'NSE',
              symbol: 'NIFTY',
              assetType: 'FUTURE',
              name: 'Nifty 50 Futures 2026-10-27',
            },
          ],
        }),
      ),
      lookupSequence({ status: 'NOT_FOUND' }),
    );
    renderApp();
    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.type(input, 'nifty fut');

    const option = await screen.findByRole('option', { name: /nifty 50 futures/i });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}');
    expect(option).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/stock/lookup'))?.body).toEqual({ query: 'NSE:NIFTY:FUT:2026-10-27' }),
    );
  });

  it('closes suggestions on Escape and degrades gracefully when search fails', async () => {
    server.use(
      http.get(`${API}/stock/search`, () => HttpResponse.json({ status: 500 }, { status: 500 })),
      lookupSequence({ status: 'NOT_FOUND' }),
    );
    renderApp();
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'tata');

    expect(await screen.findByText(/suggestions unavailable/i)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
