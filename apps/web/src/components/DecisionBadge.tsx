import type { DecisionIndicator } from '@stock-analysis/shared';
import { CircleCheck, CircleMinus, CircleX } from 'lucide-react';
import { INDICATOR_LABEL } from '../lib/format.ts';
import { cn } from '../lib/cn.ts';

const STYLE = {
  BUY: { className: 'bg-buy text-buy-fg', Icon: CircleCheck },
  DONT_BUY: { className: 'bg-dontbuy text-dontbuy-fg', Icon: CircleX },
  NEUTRAL: { className: 'bg-neutral text-neutral-fg', Icon: CircleMinus },
} as const;

/** The decision, always as icon + text so it never relies on colour alone. */
export function DecisionBadge({ indicator, size = 'lg' }: { indicator: DecisionIndicator; size?: 'sm' | 'lg' }) {
  const { className, Icon } = STYLE[indicator];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md font-semibold tracking-wide whitespace-nowrap',
        size === 'lg' ? 'px-3 py-1.5 text-lg' : 'px-2 py-0.5 text-xs',
        className,
      )}
    >
      <Icon aria-hidden="true" className={size === 'lg' ? 'size-5' : 'size-3.5'} />
      {INDICATOR_LABEL[indicator]}
    </span>
  );
}
