import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isReported, metricSchema, type Metric } from './metric.ts';

const NumberMetric = metricSchema(z.number());
const observedAt = '2026-09-30T10:00:00.000Z';

describe('metricSchema', () => {
  it.each([
    ['OK with source', { status: 'OK', value: 16.2, sourceId: 'fixture:fin', observedAt }],
    ['MISSING without source', { status: 'MISSING', value: null }],
    ['MISSING with source', { status: 'MISSING', value: null, sourceId: 'fixture:fin' }],
    ['NOT_APPLICABLE', { status: 'NOT_APPLICABLE', value: null }],
    ['ERROR with reason', { status: 'ERROR', value: null, reason: 'provider timeout' }],
  ])('accepts %s', (_label, input) => {
    expect(NumberMetric.safeParse(input).success).toBe(true);
  });

  it.each([
    ['OK without source', { status: 'OK', value: 16.2, observedAt }],
    ['OK without observedAt', { status: 'OK', value: 16.2, sourceId: 'fixture:fin' }],
    ['OK with null value', { status: 'OK', value: null, sourceId: 'fixture:fin', observedAt }],
    ['OK with wrong value type', { status: 'OK', value: '16.2', sourceId: 'fixture:fin', observedAt }],
    [
      'OK with offset timestamp',
      { status: 'OK', value: 1, sourceId: 'fixture:fin', observedAt: '2026-09-30T15:30:00.000+05:30' },
    ],
    [
      'OK with second-precision timestamp',
      { status: 'OK', value: 1, sourceId: 'f', observedAt: '2026-09-30T10:00:00Z' },
    ],
    ['MISSING that carries a value', { status: 'MISSING', value: 16.2 }],
    ['NOT_APPLICABLE that carries a value', { status: 'NOT_APPLICABLE', value: 16.2 }],
    ['ERROR that carries a value', { status: 'ERROR', value: 16.2, reason: 'x' }],
    ['ERROR without reason', { status: 'ERROR', value: null }],
    ['ERROR with empty reason', { status: 'ERROR', value: null, reason: '' }],
    ['STALE (freshness is the engine’s call)', { status: 'STALE', value: 16.2, sourceId: 'fixture:fin', observedAt }],
    ['invalid source id', { status: 'OK', value: 1, sourceId: 'Fixture Fin', observedAt }],
  ])('rejects %s', (_label, input) => {
    expect(NumberMetric.safeParse(input).success).toBe(false);
  });
});

describe('isReported', () => {
  it.each<[Metric<number>, boolean]>([
    [{ status: 'OK', value: 1, sourceId: 's', observedAt }, true],
    [{ status: 'MISSING', value: null }, false],
    [{ status: 'NOT_APPLICABLE', value: null }, false],
    [{ status: 'ERROR', value: null, reason: 'x' }, false],
  ])('%j -> %s', (metric, expected) => {
    expect(isReported(metric)).toBe(expected);
  });
});
