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
  it('lists what must clear before the rules say BUY, with rule-based levels and pointers', async () => {
    render(<WhenToBuy decision={decisionOf('DONT_BUY')} guidance={guidance} currency="INR" indian />);
    const section = screen.getByRole('region', { name: 'When to buy (by the rules)' });

    expect(section).toHaveTextContent('The rules would say BUY only once all of these clear');
    const items = within(section).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Red flag: Operating margin shrinking for 3 quarters.');
    expect(items[1]).toHaveTextContent('Buy rule (needs data): Promoter pledging: data unavailable.');
    expect(section).toHaveTextContent('Entry ₹152.30 · Stop ₹144.50 · Target ₹167.90');
    expect(section).toHaveTextContent(/1 rule can't clear until the data is available: promoter pledging/);

    await userEvent.click(screen.getByText('1 scored check would raise confidence'));
    expect(screen.getByText('Volume 0.9× average vs surge above 1.5×.')).toBeVisible();
  });

  it('says every rule passes for a BUY', () => {
    render(
      <WhenToBuy
        decision={decisionOf('BUY')}
        guidance={{ ...guidance, blockers: [], improvements: [] }}
        currency="USD"
        indian={false}
      />,
    );
    expect(screen.getByText(/Every buy rule passes/)).toBeInTheDocument();
    expect(screen.queryByText(/can't clear until/)).not.toBeInTheDocument();
  });

  it('degrades when guidance is missing', () => {
    render(<WhenToBuy decision={decisionOf('NEUTRAL')} guidance={undefined} currency="INR" indian />);
    expect(screen.getByText(/Re-analyse to see which rules/)).toBeInTheDocument();
  });
});

describe('ConfidenceExplainer', () => {
  it.each([
    ['DONT_BUY', /weight of the red flags .* here 1 red flag/],
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
