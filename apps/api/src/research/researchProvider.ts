import type { Derivatives, Fundamentals, Instrument, Sentiment, Source, Technicals } from '@stock-analysis/shared';
import type { z } from 'zod';

export type FundamentalsData = z.infer<typeof Fundamentals>;
export type TechnicalsData = z.infer<typeof Technicals>;
export type DerivativesData = z.infer<typeof Derivatives>;
export type SentimentData = z.infer<typeof Sentiment>;

export interface DimensionData {
  fundamentals: FundamentalsData;
  technicals: TechnicalsData;
  derivatives: DerivativesData;
  sentiment: SentimentData;
}

export type Dimension = keyof DimensionData;
export const DIMENSIONS: readonly Dimension[] = ['fundamentals', 'technicals', 'derivatives', 'sentiment'];

/** What a provider returns for one dimension: the section's metrics plus the sources they cite. */
export interface DimensionResult<D extends Dimension> {
  data: DimensionData[D];
  sources: Source[];
}

export interface FetchContext {
  /** The snapshot time. Providers stamp observations relative to it and must not report later observations. */
  asOf: Date;
  /** Aborted on timeout or when the caller cancels; providers must stop work and reject promptly. */
  signal: AbortSignal;
}

/**
 * Source of research data for one or more dimensions. Output is untrusted: the aggregator validates it with the
 * shared Zod schemas, and a dimension that throws, times out, or fails validation becomes ERROR metrics (partial
 * research) rather than failing the whole analysis.
 */
export interface ResearchProvider {
  readonly name: string;
  fetch<D extends Dimension>(dimension: D, instrument: Instrument, ctx: FetchContext): Promise<DimensionResult<D>>;
}

/** A provider failure worth retrying (timeouts of the upstream call, throttling, transient network errors). */
export class RetryableProviderError extends Error {
  override readonly name = 'RetryableProviderError';
}
