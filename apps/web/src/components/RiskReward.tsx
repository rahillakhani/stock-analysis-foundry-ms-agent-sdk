import type { RiskReward as RiskRewardData } from '@stock-analysis/shared';
import { ArrowDown, ArrowUp, Crosshair, Scale } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { formatPrice } from '../lib/format.ts';

interface Props {
  riskReward: RiskRewardData;
  currency: 'INR' | 'USD';
}

const pctFrom = (entry: number, level: number) => ((level - entry) / entry) * 100;
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;

/**
 * The rule-based risk-to-reward for a hypothetical long entry, highlighted: entry, stop and target as labelled tiles
 * with their distance from the entry, and a bar comparing the risk (entry → stop) with the reward (entry → target).
 * Direction is carried by labels and arrows as well as colour.
 */
export function RiskReward({ riskReward, currency }: Props) {
  const { entry, stop, target, ratio, method } = riskReward;
  const risk = entry - stop;
  const reward = target - entry;
  const riskShare = (100 * risk) / (risk + reward);

  return (
    <section
      aria-labelledby="risk-reward-heading"
      className="rounded-lg border border-accent/40 border-l-4 border-l-accent bg-accent-tint p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="risk-reward-heading" className="flex items-center gap-1.5 font-semibold text-ink">
          <Scale aria-hidden="true" className="size-4" /> Risk-to-reward (hypothetical long entry)
        </h3>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-sm font-semibold text-white tabular-nums">
          1 : {ratio}
        </span>
      </div>
      <p className="mt-1 text-ink-2">
        The potential reward is <strong className="text-ink tabular-nums">{ratio}×</strong> the risk at these levels.
      </p>

      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Level label="Stop" value={formatPrice(stop, currency)} delta={signed(pctFrom(entry, stop))} tone="down" />
        <Level label="Entry" value={formatPrice(entry, currency)} tone="neutral" />
        <Level label="Target" value={formatPrice(target, currency)} delta={signed(pctFrom(entry, target))} tone="up" />
      </dl>

      <div className="mt-3" aria-hidden="true">
        <div className="flex h-2.5 overflow-hidden rounded-full">
          <div className="bg-down" style={{ width: `${riskShare}%` }} />
          <div className="w-0.5 bg-surface" />
          <div className="flex-1 bg-up" />
        </div>
        <div className="mt-1 flex justify-between text-xs text-ink-3">
          <span>Risk</span>
          <span>Reward</span>
        </div>
      </div>

      <p className="mt-3 text-xs text-ink-3">
        {method} Computed from the latest price and volatility for every signal; not a recommendation to trade.
      </p>
    </section>
  );
}

function Level({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta?: string;
  tone: 'up' | 'down' | 'neutral';
}) {
  const Icon = tone === 'up' ? ArrowUp : tone === 'down' ? ArrowDown : Crosshair;
  return (
    // Phones: one row per level (label left, price right). Wider: three tiles.
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface p-2 sm:block">
      <dt className="flex items-center gap-1 text-xs text-ink-2">
        <Icon
          aria-hidden="true"
          className={cn('size-3.5', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink-3')}
        />
        {label}
      </dt>
      <dd className="text-right sm:mt-0.5 sm:text-left">
        <span className="block font-semibold tabular-nums text-ink">{value}</span>
        {delta && (
          <span className={cn('block text-xs font-medium tabular-nums', tone === 'up' ? 'text-up' : 'text-down')}>
            {delta}
          </span>
        )}
      </dd>
    </div>
  );
}
