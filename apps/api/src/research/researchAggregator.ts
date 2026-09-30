import {
  Derivatives,
  Fundamentals,
  RESEARCH_SNAPSHOT_SCHEMA_VERSION,
  ResearchSnapshot,
  Sentiment,
  Source,
  Technicals,
  type Instrument,
  type Metric,
} from '@stock-analysis/shared';
import { z } from 'zod';
import {
  DIMENSIONS,
  RetryableProviderError,
  type Dimension,
  type DimensionData,
  type ResearchProvider,
} from './researchProvider.ts';

const SECTION_SCHEMAS = {
  fundamentals: Fundamentals,
  technicals: Technicals,
  derivatives: Derivatives,
  sentiment: Sentiment,
};
const Sources = z.array(Source);

export interface AggregatorOptions {
  /** Per-attempt timeout for one dimension. */
  timeoutMs: number;
  /** Total attempts per dimension for RetryableProviderError (1 = no retry). */
  maxAttempts: number;
  /** Base backoff; attempt n waits base × 2^(n-1) plus up to 50% jitter. */
  backoffMs: number;
  /** Injected for tests: returns a value in [0, 1). */
  random: () => number;
  /** Injected for tests; must reject if the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  currency: string;
}

export const DEFAULT_AGGREGATOR_OPTIONS: AggregatorOptions = {
  timeoutMs: 5_000,
  maxAttempts: 2,
  backoffMs: 200,
  random: Math.random,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    }),
  currency: 'INR',
};

export interface AggregatedResearch {
  snapshot: ResearchSnapshot;
  /** Dimensions whose provider call failed, timed out, or returned invalid data. Empty = complete research. */
  unavailableDimensions: Dimension[];
}

/** Provider output that parsed but is internally inconsistent (e.g. cites a source it didn't return). */
class InvalidProviderDataError extends Error {
  override readonly name = 'InvalidProviderDataError';
}

/** Why a dimension failed, as an internal (never client-facing) reason. */
function describeFailure(err: unknown): string {
  if (err instanceof z.ZodError || err instanceof InvalidProviderDataError) return 'provider returned invalid data';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'provider timed out';
  return 'provider request failed';
}

/** A section where every metric is ERROR with the same reason: explicit partial research, not missing data. */
function erroredSection<D extends Dimension>(dimension: D, reason: string): DimensionData[D] {
  const keys = Object.keys(SECTION_SCHEMAS[dimension].shape);
  return Object.fromEntries(keys.map((key) => [key, { status: 'ERROR', value: null, reason }])) as DimensionData[D];
}

/**
 * Collects all four research dimensions concurrently from one provider. Each dimension gets its own timeout and
 * bounded retries (RetryableProviderError only); a dimension that still fails becomes ERROR metrics and is listed
 * in `unavailableDimensions`. Cancelling `signal` rejects the whole aggregation.
 */
export async function aggregateResearch(
  provider: ResearchProvider,
  instrument: Instrument,
  asOf: Date,
  signal: AbortSignal,
  options: AggregatorOptions = DEFAULT_AGGREGATOR_OPTIONS,
): Promise<AggregatedResearch> {
  const results = await Promise.all(
    DIMENSIONS.map(async (dimension) => {
      try {
        return {
          dimension,
          ok: true as const,
          ...(await fetchWithRetry(provider, dimension, instrument, asOf, signal, options)),
        };
      } catch (err) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aggregation cancelled');
        return { dimension, ok: false as const, reason: describeFailure(err) };
      }
    }),
  );

  const sections: Partial<DimensionData> = {};
  const sources = new Map<string, Source>();
  const unavailableDimensions: Dimension[] = [];
  for (const result of results) {
    if (result.ok) {
      Object.assign(sections, { [result.dimension]: result.data });
      for (const source of result.sources) if (!sources.has(source.id)) sources.set(source.id, source);
    } else {
      Object.assign(sections, { [result.dimension]: erroredSection(result.dimension, result.reason) });
      unavailableDimensions.push(result.dimension);
    }
  }

  const base = {
    schemaVersion: RESEARCH_SNAPSHOT_SCHEMA_VERSION,
    instrument,
    currency: options.currency,
    asOf: asOf.toISOString(),
    sources: [...sources.values()],
  };
  // Snapshot-level invariants (cited sources exist, nothing observed after asOf, FUTURE derivatives present) can
  // fail for one provider section; downgrade just the offending dimensions instead of failing the analysis.
  for (;;) {
    const parsed = ResearchSnapshot.safeParse({ ...base, ...sections });
    if (parsed.success) return { snapshot: parsed.data, unavailableDimensions };
    const offending = new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((key): key is Dimension => DIMENSIONS.includes(key as Dimension)),
    );
    const fresh = [...offending].filter((dimension) => !unavailableDimensions.includes(dimension));
    if (fresh.length === 0) throw parsed.error;
    for (const dimension of fresh) {
      Object.assign(sections, { [dimension]: erroredSection(dimension, 'provider returned invalid data') });
      unavailableDimensions.push(dimension);
    }
  }
}

async function fetchWithRetry<D extends Dimension>(
  provider: ResearchProvider,
  dimension: D,
  instrument: Instrument,
  asOf: Date,
  signal: AbortSignal,
  options: AggregatorOptions,
): Promise<{ data: DimensionData[D]; sources: Source[] }> {
  for (let attempt = 1; ; attempt++) {
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
    try {
      const result = await provider.fetch(dimension, instrument, { asOf, signal: attemptSignal });
      // Provider output is untrusted: validate the section and its sources before using them.
      const data = SECTION_SCHEMAS[dimension].parse(result.data) as DimensionData[D];
      const sources = Sources.parse(result.sources);
      // Each dimension must cite only the sources it returned, so its validity never depends on other dimensions.
      const returned = new Set(sources.map((source) => source.id));
      const metrics: Record<string, Metric<unknown>> = data;
      const unlisted = Object.values(metrics).find(
        (m) => 'sourceId' in m && m.sourceId !== undefined && !returned.has(m.sourceId),
      );
      if (unlisted) throw new InvalidProviderDataError(`${dimension} cites a source it did not return`);
      return { data, sources };
    } catch (err) {
      const retryable = err instanceof RetryableProviderError;
      if (signal.aborted || !retryable || attempt >= options.maxAttempts) throw err;
      const delay = options.backoffMs * 2 ** (attempt - 1) * (1 + 0.5 * options.random());
      await options.sleep(delay, signal);
    }
  }
}
