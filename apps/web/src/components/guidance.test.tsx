import type { BuyGuidance, Source } from '@stock-analysis/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { completedRun } from '../test/fixtures.ts';
import { SourceList } from './SourceList.tsx';
import { ConfidenceExplainer, WhenToBuy } from './WhenToBuy.tsx';

const decisionOf = (indicator: 'BUY' | 'DONT_BUY' | 'NEUTRAL') => {
  const run = completedRun({ indicator });
  if (!('decision' in run)) throw new Error('fixture is not completed');
  return run.decision;
};

const guidance: BuyGuidance = {
  blockers: [
    {
      code: 'OPERATING_MARGIN_SHRINKING',
      message: 'Operating margin shrinking for 3 quarters.',
      sourceIds: [],
      role: 'VETO',
      cause: 'FAILED',
    },
    {
      code: 'PLEDGE_BELOW_MAX_UNAVAILABLE',
      message: 'Promoter pledging: data unavailable.',
      sourceIds: [],
      role: 'BUY_RULE',
      cause: 'NO_DATA',
    },
  ],
  improvements: [{ code: 'NO_VOLUME_SURGE', message: 'Volume 0.9× average vs surge above 1.5×.', sourceIds: [] }],
  dataCompletenessPct: 81.8,
  usableChecks: 18,
  applicableChecks: 22,
};

describe('WhenToBuy', () => {
  it('lists what must clear before the rules say BUY, naming unsourced data only where it applies', async () => {
    render(<WhenToBuy decision={decisionOf('DONT_BUY')} guidance={guidance} liveData />);
    const section = screen.getByRole('region', { name: 'When the rules would say BUY' });

    expect(section).toHaveTextContent('The rules would say BUY only once all of these clear');
    const items = within(section).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Red flag: Operating margin shrinking for 3 quarters.');
    expect(items[1]).toHaveTextContent('Buy rule (no usable data): Promoter pledging: data unavailable.');
    expect(section).toHaveTextContent(
      /1 rule has no data from the current source \(promoter pledging is not connected yet/,
    );
    // Price levels live in their own risk-to-reward section, not under this heading.
    expect(section).not.toHaveTextContent('Entry');

    // Failed scored checks lower the section scores; they don't change NEUTRAL/DON'T BUY confidence.
    await userEvent.click(
      screen.getByText(/1 other check failed \(these lower the section scores but don't block BUY\)/),
    );
    expect(screen.getByText('Volume 0.9× average vs surge above 1.5×.')).toBeVisible();
    expect(section).not.toHaveTextContent('raise confidence');
  });

  it('says a stale source must update before re-analysing helps', () => {
    const stale: BuyGuidance = {
      ...guidance,
      blockers: [
        {
          code: 'ROE_ABOVE_MIN_UNAVAILABLE',
          message: 'ROE: data is stale (observed 2025-03-31).',
          sourceIds: [],
          role: 'BUY_RULE',
          cause: 'NO_DATA',
        },
      ],
    };
    render(<WhenToBuy decision={decisionOf('NEUTRAL')} guidance={stale} liveData />);
    expect(screen.getByText(/1 rule uses stale data/)).toBeInTheDocument();
    expect(screen.queryByText(/no data from the current source/)).not.toBeInTheDocument();
  });

  it('does not claim a source is missing for sample data', () => {
    render(<WhenToBuy decision={decisionOf('DONT_BUY')} guidance={guidance} liveData={false} />);
    expect(screen.getByText(/1 rule has no data from the current source\s*\./)).toBeInTheDocument();
  });

  it('says every rule passes for a BUY', () => {
    render(
      <WhenToBuy decision={decisionOf('BUY')} guidance={{ ...guidance, blockers: [], improvements: [] }} liveData />,
    );
    expect(screen.getByText(/Every buy rule passes/)).toBeInTheDocument();
  });

  it('degrades when guidance is missing', () => {
    render(<WhenToBuy decision={decisionOf('NEUTRAL')} guidance={undefined} liveData />);
    expect(screen.getByText(/Re-analyse to see which rules/)).toBeInTheDocument();
  });
});

describe('ConfidenceExplainer', () => {
  it.each([
    ['DONT_BUY', /weight of the red flags .* here 1 red flag, so 75\)/],
    ['NEUTRAL', /never exceeds 50%/],
    ['BUY', /average section score/],
  ] as const)('explains %s confidence without implying a probability', async (indicator, text) => {
    render(<ConfidenceExplainer decision={decisionOf(indicator)} guidance={guidance} />);
    await userEvent.click(screen.getByText('What does 75% confidence mean?'));
    expect(screen.getByText(/It is not the chance that the price will rise/)).toBeVisible();
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText(/81.8% \(18 of 22 checks had usable data\)/)).toBeVisible();
  });
});

it('does not invent a red-flag count when guidance is missing', async () => {
  render(<ConfidenceExplainer decision={decisionOf('DONT_BUY')} guidance={undefined} />);
  await userEvent.click(screen.getByText('What does 75% confidence mean?'));
  expect(screen.getByText(/at most 100\): how firmly/)).toBeVisible();
  expect(screen.queryByText(/here 0 red flags/)).not.toBeInTheDocument();
});

describe('SourceList', () => {
  const sources: Source[] = [
    {
      id: 'yahoo:chart:mrf-ns:2026-10-01',
      provider: 'yahoo-finance',
      url: 'https://finance.yahoo.com/quote/MRF.NS',
      retrievedAt: '2026-10-01T10:00:00.000Z',
    },
    { id: 'fixture:flows:x:2026-10-01', provider: 'fixture', retrievedAt: '2026-10-01T10:00:00.000Z' },
  ];

  it('links each source to its page in a new tab, and says when there is no link', async () => {
    render(<SourceList sources={sources} />);
    await userEvent.click(screen.getByText(/Sources: yahoo-finance, fixture · 2 sources cited/));

    const link = screen.getByRole('link', { name: /yahoo-finance: chart/ });
    expect(link).toHaveAttribute('href', 'https://finance.yahoo.com/quote/MRF.NS');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('fixture: flows (no public link)')).toBeVisible();
  });
});
