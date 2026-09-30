import type { InstrumentSummary } from '@stock-analysis/shared';
import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { cn } from '../lib/cn.ts';

interface Props {
  api: ApiClient;
  onSubmit: (query: string) => void;
  disabled?: boolean;
  debounceMs?: number;
}

type Suggestions =
  { status: 'idle' } | { status: 'loading' } | { status: 'ready'; items: InstrumentSummary[] } | { status: 'error' };

/**
 * Symbol or company-name input with debounced autocomplete (ARIA combobox). Enter submits the highlighted
 * suggestion's key, or the typed text when nothing is highlighted. Stale suggestion requests are cancelled.
 */
export function SearchBar({ api, onSubmit, disabled = false, debounceMs = 250 }: Props) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestions>({ status: 'idle' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();

  useEffect(() => {
    const query = text.trim();
    if (query.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSuggestions({ status: 'loading' });
      api.search(query, controller.signal).then(
        (items) => setSuggestions({ status: 'ready', items }),
        (err: unknown) => {
          if (!controller.signal.aborted) setSuggestions({ status: 'error' });
          return err;
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, text, debounceMs]);

  const items = suggestions.status === 'ready' ? suggestions.items : [];
  const showList = open && text.trim().length > 0 && suggestions.status !== 'idle';

  const submit = (value: string) => {
    if (value.trim().length === 0) return;
    setOpen(false);
    setActive(-1);
    onSubmit(value);
  };

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        const chosen = active >= 0 ? items[active] : undefined;
        submit(chosen ? chosen.key : text);
      }}
    >
      <label htmlFor={`${listId}-input`} className="sr-only">
        Stock symbol or company name
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
          />
          <input
            id={`${listId}-input`}
            role="combobox"
            aria-expanded={showList && items.length > 0}
            aria-controls={items.length > 0 ? `${listId}-list` : undefined}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
            autoComplete="off"
            maxLength={100}
            placeholder="e.g. TATASTEEL, Tata Steel, Nifty 50 Futures"
            value={text}
            disabled={disabled}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(-1);
              // Drop the previous query's suggestions at once so a stale item can't be picked during the debounce.
              setSuggestions(event.target.value.trim().length === 0 ? { status: 'idle' } : { status: 'loading' });
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && items.length > 0) {
                event.preventDefault();
                setOpen(true);
                setActive((i) => (i + 1) % items.length);
              } else if (event.key === 'ArrowUp' && items.length > 0) {
                event.preventDefault();
                setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
              } else if (event.key === 'Escape') {
                setOpen(false);
                setActive(-1);
              }
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Close after a click on an option has been handled; forget the highlight so Enter submits the text.
              setTimeout(() => {
                setOpen(false);
                setActive(-1);
              }, 150);
            }}
            className="w-full rounded-lg border border-border bg-surface py-2.5 pr-3 pl-9 text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-focus disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={disabled || text.trim().length === 0}
          className="rounded-lg bg-accent px-4 font-medium text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
        >
          Analyse
        </button>
      </div>
      {showList && suggestions.status !== 'ready' && (
        <p
          role="status"
          className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink-3 shadow-lg"
        >
          {suggestions.status === 'loading' ? 'Searching…' : 'Suggestions unavailable — press Enter to search anyway.'}
        </p>
      )}
      {showList && suggestions.status === 'ready' && items.length === 0 && (
        <p
          role="status"
          className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink-3 shadow-lg"
        >
          No matches.
        </p>
      )}
      {showList && items.length > 0 && (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="Suggestions"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {items.map((item, index) => (
            <li
              key={item.key}
              id={`${listId}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                submit(item.key);
              }}
              className={cn(
                'flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm',
                index === active ? 'bg-surface-2' : 'hover:bg-surface-2',
              )}
            >
              <span className="text-ink">{item.name}</span>
              <span className="shrink-0 font-mono text-xs text-ink-2">{item.key}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
