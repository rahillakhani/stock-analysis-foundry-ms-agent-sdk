import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatAge } from '../lib/format.ts';
import { DecisionBadge } from './DecisionBadge.tsx';
import { MetricsGrid } from './MetricsGrid.tsx';

describe('DecisionBadge', () => {
  it.each([
    ['BUY', 'BUY'],
    ['DONT_BUY', "DON'T BUY"],
    ['NEUTRAL', 'NEUTRAL'],
  ] as const)('labels %s as text, not colour alone', (indicator, label) => {
    render(<DecisionBadge indicator={indicator} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('MetricsGrid', () => {
  it('renders each subscore as a labelled meter and F&O as N/A without a contract', () => {
    render(<MetricsGrid subscores={{ fundamental: 80, technical: 42.9, derivatives: null, sentiment: 0 }} />);
    expect(screen.getByRole('meter', { name: 'Fundamentals score' })).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByRole('meter', { name: 'Sentiment score' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.queryByRole('meter', { name: 'F&O score' })).not.toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });
});

describe('formatAge', () => {
  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [7200, '2 hours ago'],
    [86_400, 'yesterday'],
    [3 * 86_400, '3 days ago'],
  ])('%s seconds -> %s', (seconds, expected) => {
    expect(formatAge(seconds)).toBe(expected);
  });
});
