import { z } from 'zod';
import { IsoDateTime } from './common.ts';
import { SourceId } from './source.ts';

export const METRIC_STATUSES = ['OK', 'MISSING', 'NOT_APPLICABLE', 'ERROR'] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

/**
 * A single research data point with provenance, as reported by a provider. The status decides which fields exist,
 * so a value without a source (or a "missing" metric that still carries a value) can't be represented:
 * - OK: value present, cited source, observation time.
 * - MISSING: provider had no value. NOT_APPLICABLE: the metric doesn't apply (e.g. derivatives for a stock with no
 *   F&O contract). ERROR: the provider call failed; `reason` is internal and never sent to clients.
 *
 * Metrics carry no freshness judgment. Whether an OK value is too old is decided by the decision engine from
 * `observedAt` vs the snapshot's `asOf`, under the policy version being evaluated, so replaying a stored snapshot
 * under a different policy stays meaningful.
 */
export function metricSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('OK'), value, sourceId: SourceId, observedAt: IsoDateTime }),
    z.object({ status: z.literal('MISSING'), value: z.null(), sourceId: SourceId.optional() }),
    z.object({ status: z.literal('NOT_APPLICABLE'), value: z.null() }),
    z.object({
      status: z.literal('ERROR'),
      value: z.null(),
      sourceId: SourceId.optional(),
      reason: z.string().min(1).max(500),
    }),
  ]);
}

/** Inferred from `metricSchema`, so the type can never drift from the runtime validation. */
export type Metric<T> = z.infer<ReturnType<typeof metricSchema<z.ZodType<T>>>>;

/**
 * True when the provider reported a value. This says nothing about freshness: the decision engine must still apply
 * its policy's max-age check before counting the value as a pass.
 */
export function isReported<T>(metric: Metric<T>): metric is Extract<Metric<T>, { status: 'OK' }> {
  return metric.status === 'OK';
}
