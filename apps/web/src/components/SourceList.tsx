import type { Source } from '@stock-analysis/shared';
import { ExternalLink } from 'lucide-react';
import { formatDateTime } from '../lib/format.ts';

/** "yahoo:chart:mrf-ns:2026-10-01" -> "chart" (the kind of data the source supplied). */
function kindOf(source: Source): string {
  return source.id.split(':')[1] ?? source.id;
}

/** Every cited source, linked where the provider has a page, so the data can be checked at its origin. */
export function SourceList({ sources }: { sources: Source[] }) {
  const providers = [...new Set(sources.map((source) => source.provider))];
  return (
    <details className="text-xs text-ink-3">
      <summary className="cursor-pointer">
        Sources: {providers.join(', ')} · {sources.length} source{sources.length === 1 ? '' : 's'} cited (show)
      </summary>
      <ul className="mt-2 space-y-1">
        {sources.map((source) => (
          <li key={source.id} className="flex flex-wrap items-baseline gap-x-2">
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:opacity-80"
              >
                {source.provider}: {kindOf(source)}
                <ExternalLink aria-hidden="true" className="size-3" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="text-ink-2">
                {source.provider}: {kindOf(source)} (no public link)
              </span>
            )}
            <span>retrieved {formatDateTime(source.retrievedAt)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
