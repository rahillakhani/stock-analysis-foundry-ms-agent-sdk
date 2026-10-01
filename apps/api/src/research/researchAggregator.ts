import {
  Derivatives,
  Fundamentals,
  RESEARCH_SNAPSHOT_SCHEMA_VERSION,
  ResearchSnapshot,
  Sentiment,
  Source,
  Technicals,
  currencyFor,
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

export interface AggregatorOptions {
  /** Per-attempt timeout for one dimension. Enforced even if the provider ignores its signal. */
  timeoutMs: number;
  /** Total attempts per dimension for RetryableProviderError (1 = no retry). */
  maxAttempts: number;
  /** Base backoff; attempt n waits base × 2^(n-1) × (1 + 0.5 × random). */
  backoffMs: number;
  /** Injected for tests: returns a value in [0, 1). */
  random: () => number;
  /** Injected for tests; must reject if the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new Error('operation aborted');

export const DEFAULT_AGGREGATOR_OPTIONS: AggregatorOptions = {
  timeoutMs: 5_000,
  maxAttempts: 2,
  backoffMs: 200,
  random: Math.random,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
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

/** The aggregator's own per-attempt deadline passed (distinct from any abort raised inside the provider). */
class ProviderTimeoutError extends Error {
  override readonly name = 'ProviderTimeoutError';
}

/** Why a dimension failed, as an internal (never client-facing) reason. */
function describeFailure(err: unknown): string {
  if (err instanceof z.ZodError || err instanceof InvalidProviderDataError) return 'provider returned invalid data';
  if (err instanceof ProviderTimeoutError) return 'provider timed out';
  return 'provider request failed';
}

/** A section where every metric is ERROR with the same reason: explicit partial research, not missing data. */
function erroredSection<D extends Dimension>(dimension: D, reason: string): DimensionData[D] {
  const keys = Object.keys(SECTION_SCHEMAS[dimension].shape);
  return Object.fromEntries(keys.map((key) => [key, { status: 'ERROR', value: null, reason }])) as DimensionData[D];
}

/**
 * Settles with `promise`, or rejects as soon as `signal` aborts, whichever comes first. This is what makes timeouts
 * and cancellation hold even for a provider that ignores its signal; its late result is discarded.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

interface DimensionOutcome {
  dimension: Dimension;
  data: DimensionData[Dimension];
  sources: Source[];
}

/**
 * Collects all four research dimensions concurrently from one provider. Each dimension gets its own timeout and
 * bounded retries (RetryableProviderError only); a dimension that still fails, or whose output is invalid or
 * conflicts with another dimension's sources, becomes ERROR metrics and is listed in `unavailableDimensions`.
 * Cancelling `signal` rejects the whole aggregation.
 */
export async function aggregateResearch(
  provider: ResearchProvider,
  instrument: Instrument,
  asOf: Date,
  signal: AbortSignal,
  options: AggregatorOptions = DEFAULT_AGGREGATOR_OPTIONS,
): Promise<AggregatedResearch> {
  const fetched = await Promise.all(
    DIMENSIONS.map(async (dimension): Promise<DimensionOutcome | { dimension: Dimension; reason: string }> => {
      try {
        return { dimension, ...(await fetchWithRetry(provider, dimension, instrument, asOf, signal, options)) };
      } catch (err) {
        if (signal.aborted) throw abortReason(signal);
        return { dimension, reason: describeFailure(err) };
      }
    }),
  );

  const accepted = new Map<Dimension, DimensionOutcome>();
  const failed = new Map<Dimension, string>();
  const claimed = new Map<string, string>(); // source id -> canonical JSON of the first dimension's source
  for (const outcome of fetched) {
    if ('reason' in outcome) {
      failed.set(outcome.dimension, outcome.reason);
      continue;
    }
    // Two dimensions may share a source only if they describe it identically; otherwise the later one is rejected
    // so no metric can end up pointing at another dimension's provenance.
    const conflict = outcome.sources.some((source) => {
      const existing = claimed.get(source.id);
      return existing !== undefined && existing !== JSON.stringify(source);
    });
    if (conflict) {
      failed.set(outcome.dimension, 'provider returned invalid data');
      continue;
    }
    for (const source of outcome.sources) claimed.set(source.id, JSON.stringify(source));
    accepted.set(outcome.dimension, outcome);
  }

  // Snapshot-level invariants (nothing observed after asOf, FUTURE derivatives present) can still fail for one
  // section; downgrade just the offending dimensions and rebuild sources from the survivors.
  for (;;) {
    const sections = Object.fromEntries(
      DIMENSIONS.map((dimension) => {
        const reason = failed.get(dimension);
        const outcome = accepted.get(dimension);
        return [dimension, outcome && reason === undefined ? outcome.data : erroredSection(dimension, reason ?? '')];
      }),
    );
    const sources = new Map<string, Source>();
    for (const [dimension, outcome] of accepted) {
      if (failed.has(dimension)) continue;
      for (const source of outcome.sources) sources.set(source.id, source);
    }
    const parsed = ResearchSnapshot.safeParse({
      schemaVersion: RESEARCH_SNAPSHOT_SCHEMA_VERSION,
      instrument,
      // Prices and ATR are in the listing's trading currency.
      currency: currencyFor(instrument.exchange),
      asOf: asOf.toISOString(),
      ...sections,
      sources: [...sources.values()],
    });
    const unavailableDimensions = DIMENSIONS.filter((dimension) => failed.has(dimension));
    if (parsed.success) return { snapshot: parsed.data, unavailableDimensions };

    const offending = parsed.error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is Dimension => DIMENSIONS.includes(key as Dimension) && !failed.has(key as Dimension));
    if (offending.length === 0) throw parsed.error; // not attributable to a provider section: a programming error
    for (const dimension of offending) failed.set(dimension, 'provider returned invalid data');
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
  const schema = SECTION_SCHEMAS[dimension];
  // Each metric cites at most one source, so a section never needs more sources than it has metrics.
  const Sources = z
    .array(Source)
    .max(Object.keys(schema.shape).length)
    .refine((list) => new Set(list.map((s) => s.id)).size === list.length, 'duplicate source ids');

  for (let attempt = 1; ; attempt++) {
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
    try {
      const result = await abortable(
        provider.fetch(dimension, instrument, { asOf, signal: attemptSignal }),
        attemptSignal,
      );
      // Provider output is untrusted: validate the section and its sources before using them.
      const data = schema.parse(result.data) as DimensionData[D];
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
      if (signal.aborted) throw err;
      // Our own deadline passed: report it as a timeout. Not retried, so one slow provider can't multiply latency.
      if (attemptSignal.aborted) throw new ProviderTimeoutError(`${dimension} timed out`);
      if (!(err instanceof RetryableProviderError) || attempt >= options.maxAttempts) throw err;
      const delay = options.backoffMs * 2 ** (attempt - 1) * (1 + 0.5 * options.random());
      await options.sleep(delay, signal);
    }
  }
}
