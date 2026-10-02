import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

const STORAGE_PREFIX = 'panel-open:';

function readOpen(storageKey: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + storageKey);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback; // storage blocked (private mode, sandbox)
  }
}

function writeOpen(storageKey: string, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, String(open));
  } catch {
    // Not remembered; the panel still works.
  }
}

interface Props {
  /** Remembers open/closed per browser under this key. */
  storageKey: string;
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A side-panel section whose heading toggles its body (a disclosure button: aria-expanded / aria-controls). The
 * region keeps its accessible name from the title while collapsed.
 */
export function CollapsiblePanel({ storageKey, title, icon, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen));
  const headingId = useId();
  const bodyId = useId();

  const toggle = () => {
    writeOpen(storageKey, !open);
    setOpen(!open);
  };

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border text-sm">
      <h2 id={headingId} className="font-semibold text-ink">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className="flex min-h-11 w-full items-center gap-1.5 rounded-lg px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          {icon}
          <span className="flex-1">{title}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn('size-4 text-ink-3 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="px-4 pb-4">
        {children}
      </div>
    </section>
  );
}

/** "View more (N)" / "View less" for a list cut to its first `limit` items. Renders nothing when all fit. */
export function ViewMoreButton({
  total,
  limit,
  expanded,
  onToggle,
  controls,
}: {
  total: number;
  limit: number;
  expanded: boolean;
  onToggle: () => void;
  /** id of the list it extends. */
  controls: string;
}) {
  if (total <= limit) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="mt-1 min-h-9 w-full rounded-md px-2 text-center text-xs font-medium text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      {expanded ? 'View less' : `View more (${total - limit})`}
    </button>
  );
}

/** The first `limit` items until expanded. */
export function useViewMore<T>(items: readonly T[], limit: number) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return {
    visible: expanded ? items : items.slice(0, limit),
    button: (
      <ViewMoreButton
        total={items.length}
        limit={limit}
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
        controls={listId}
      />
    ),
    listId,
  };
}

/** Items shown before "View more" in the side panels. */
export const PANEL_PREVIEW_ITEMS = 5;
