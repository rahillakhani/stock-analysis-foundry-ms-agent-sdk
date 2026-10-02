import { MarketMovers as MoversContract, type RiskReward as RiskRewardData } from '@stock-analysis/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api/client.ts';
import type { WatchlistState } from '../hooks/useWatchlist.ts';
import { watchlistWith } from '../test/fixtures.ts';
import { API, marketHandlers } from '../test/marketHandlers.ts';
import { CollapsiblePanel } from './CollapsiblePanel.tsx';
import { MarketMovers } from './MarketMovers.tsx';
import { RiskReward } from './RiskReward.tsx';
import { PinButton, WatchlistPanel } from './WatchlistPanel.tsx';

const server = setupServer(...marketHandlers);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const api = createApiClient((input, init) => fetch(input, init));

const mover = (i: number, sign: 1 | -1) => ({
  instrumentKey: `NSE:CO${i}`,
  symbol: `CO${i}`,
  name: `Company ${i}`,
  price: 100 + i,
  change: sign * (10 - i),
  changePct: sign * (10 - i),
});

describe('CollapsiblePanel', () => {
  it('collapses and expands from its heading, and remembers the choice', async () => {
    const { unmount } = render(
      <CollapsiblePanel storageKey="test" title="Things">
        <p>Body</p>
      </CollapsiblePanel>,
    );
    const toggle = screen.getByRole('button', { name: 'Things' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Body')).toBeVisible();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Body')).not.toBeVisible();
    // The region keeps its name while collapsed.
    expect(screen.getByRole('region', { name: 'Things' })).toBeInTheDocument();

    unmount();
    render(
      <CollapsiblePanel storageKey="test" title="Things">
        <p>Body</p>
      </CollapsiblePanel>,
    );
    expect(screen.getByRole('button', { name: 'Things' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('View more', () => {
  it('shows 5 movers per list, then all of them', async () => {
    server.use(
      http.get(`${API}/market/movers`, () =>
        HttpResponse.json(
          MoversContract.parse({
            universe: 'NIFTY 50',
            marketState: 'REGULAR',
            asOf: '2026-10-01T10:00:00.000Z',
            gainers: Array.from({ length: 10 }, (_, i) => mover(i, 1)),
            losers: Array.from({ length: 10 }, (_, i) => mover(i + 10, -1)),
          }),
        ),
      ),
    );
    render(<MarketMovers api={api} onSelect={vi.fn()} />);
    const gainers = await screen.findByRole('region', { name: 'Top gainers' });
    expect(within(gainers).getAllByRole('listitem')).toHaveLength(5);

    await userEvent.click(within(gainers).getByRole('button', { name: 'View more (5)' }));
    expect(within(gainers).getAllByRole('listitem')).toHaveLength(10);
    await userEvent.click(within(gainers).getByRole('button', { name: 'View less' }));
    expect(within(gainers).getAllByRole('listitem')).toHaveLength(5);
  });

  it('shows 5 watchlist items with a View more button, and none when all fit', () => {
    const watchlist = (count: number): WatchlistState => ({
      data: watchlistWith(...Array.from({ length: count }, (_, i) => `NSE:W${i}`)),
      error: undefined,
      loading: false,
      reload: vi.fn(),
      isPinned: () => true,
      isBusy: () => false,
      actionError: undefined,
      toggle: vi.fn(),
    });
    const { unmount } = render(<WatchlistPanel watchlist={watchlist(7)} onSelect={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Unpin/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'View more (2)' })).toHaveAttribute('aria-expanded', 'false');
    unmount();

    render(<WatchlistPanel watchlist={watchlist(3)} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /View more/ })).not.toBeInTheDocument();
  });
});

describe('PinButton', () => {
  it('shows its own failure next to it, and the panel does not repeat it', () => {
    const state: WatchlistState = {
      data: watchlistWith(),
      error: undefined,
      loading: false,
      reload: vi.fn(),
      isPinned: () => false,
      isBusy: () => false,
      actionError: { key: 'NSE:TATASTEEL', message: 'The watchlist holds at most 50 instruments' },
      toggle: vi.fn(),
    };
    render(
      <>
        <PinButton watchlist={state} instrumentKey="NSE:TATASTEEL" name="Tata Steel Ltd" />
        <WatchlistPanel watchlist={state} onSelect={vi.fn()} viewingKey="NSE:TATASTEEL" />
      </>,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('at most 50');
  });
});

describe('RiskReward', () => {
  const rr: RiskRewardData = {
    ratio: 2,
    entry: 152.3,
    stop: 144.5,
    target: 167.9,
    method: 'Stop 2×ATR14 below entry.',
  };

  it('highlights entry, stop and target with their distance from the entry, and the ratio', () => {
    render(<RiskReward riskReward={rr} currency="INR" />);
    const section = screen.getByRole('region', { name: 'Risk-to-reward (hypothetical long entry)' });
    expect(section).toHaveTextContent('1 : 2');
    expect(section).toHaveTextContent('The potential reward is 2× the risk');
    expect(within(section).getByText('Stop').closest('div')).toHaveTextContent('₹144.50−5.1%');
    expect(within(section).getByText('Entry').closest('div')).toHaveTextContent('₹152.30');
    expect(within(section).getByText('Target').closest('div')).toHaveTextContent('₹167.90+10.2%');
    expect(section).toHaveTextContent('not a recommendation to trade');
  });
});
