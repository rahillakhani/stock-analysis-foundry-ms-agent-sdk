import { describe, expect, it } from 'vitest';
import { ResearchSnapshot } from './research.ts';
import { AS_OF, equitySnapshot, futureSnapshot, OBSERVED, SRC_FIN } from './test-support/fixtures.ts';

function issuesOf(input: unknown) {
  const result = ResearchSnapshot.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

const okFin = <T>(value: T) => ({ status: 'OK' as const, value, sourceId: SRC_FIN, observedAt: OBSERVED });

describe('ResearchSnapshot', () => {
  it('accepts a complete equity snapshot with non-applicable derivatives', () => {
    expect(issuesOf(equitySnapshot())).toEqual([]);
  });

  it('accepts a future snapshot with populated derivatives', () => {
    expect(issuesOf(futureSnapshot())).toEqual([]);
  });

  it('rejects a metric citing a source that is not listed, pointing at the metric', () => {
    const snapshot = equitySnapshot();
    snapshot.fundamentals.roePct = { ...okFin(16.2), sourceId: 'fixture:unknown' };

    expect(issuesOf(snapshot)).toEqual([
      { path: 'fundamentals.roePct.sourceId', message: 'source "fixture:unknown" is not listed in sources' },
    ]);
  });

  it.each([
    ['MISSING', { status: 'MISSING' as const, value: null, sourceId: 'fixture:ghost' }],
    ['ERROR', { status: 'ERROR' as const, value: null, sourceId: 'fixture:ghost', reason: 'timeout' }],
  ])('checks the source of %s metrics that cite one', (_label, metric) => {
    const snapshot = equitySnapshot();
    snapshot.sentiment.diiNetFlow = metric;

    expect(issuesOf(snapshot)).toEqual([
      { path: 'sentiment.diiNetFlow.sourceId', message: 'source "fixture:ghost" is not listed in sources' },
    ]);
  });

  it('rejects duplicate source ids', () => {
    const snapshot = equitySnapshot();
    snapshot.sources.push({ id: SRC_FIN, provider: 'other', retrievedAt: AS_OF });

    expect(issuesOf(snapshot)).toEqual([{ path: 'sources.3.id', message: `duplicate source id "${SRC_FIN}"` }]);
  });

  it('rejects a metric observed after the snapshot asOf', () => {
    const snapshot = equitySnapshot();
    snapshot.fundamentals.roePct = { ...okFin(16.2), observedAt: '2026-09-30T10:00:00.001Z' };

    expect(issuesOf(snapshot)).toEqual([
      { path: 'fundamentals.roePct.observedAt', message: 'observedAt is after the snapshot asOf' },
    ]);
  });

  it('accepts a metric observed exactly at asOf', () => {
    const snapshot = equitySnapshot();
    snapshot.fundamentals.roePct = { ...okFin(16.2), observedAt: AS_OF };
    expect(issuesOf(snapshot)).toEqual([]);
  });

  it('rejects NOT_APPLICABLE derivatives for a future', () => {
    const snapshot = futureSnapshot();
    snapshot.derivatives.inFnoBan = { status: 'NOT_APPLICABLE', value: null };

    expect(issuesOf(snapshot)).toEqual([
      { path: 'derivatives.inFnoBan.status', message: 'derivatives metrics cannot be NOT_APPLICABLE for a FUTURE' },
    ]);
  });

  it('allows ERROR and MISSING derivatives for a future (partial research is explicit, not invalid)', () => {
    const snapshot = futureSnapshot();
    snapshot.derivatives.oiChangePct = { status: 'ERROR', value: null, reason: 'provider timeout' };
    snapshot.derivatives.basisPct = { status: 'MISSING', value: null };

    expect(issuesOf(snapshot)).toEqual([]);
  });

  it.each<[string, (s: ResearchSnapshot) => void]>([
    ['a missing schemaVersion', (s) => Reflect.deleteProperty(s, 'schemaVersion')],
    ['an unknown schemaVersion', (s) => Object.assign(s, { schemaVersion: 2 })],
    ['pledging above 100%', (s) => void (s.fundamentals.promoterPledgePct = okFin(101))],
    ['negative debt-to-equity', (s) => void (s.fundamentals.debtToEquity = okFin(-0.1))],
    [
      'a malformed quarter period',
      (s) => void (s.fundamentals.operatingMarginPctQuarterly = okFin([{ period: 'Q1-2026', valuePct: 12 }])),
    ],
    [
      'duplicate quarter periods',
      (s) =>
        void (s.fundamentals.operatingMarginPctQuarterly = okFin([
          { period: '2026-Q1', valuePct: 12 },
          { period: '2026-Q1', valuePct: 11 },
        ])),
    ],
    [
      'quarters out of order',
      (s) =>
        void (s.fundamentals.operatingMarginPctQuarterly = okFin([
          { period: '2026-Q2', valuePct: 12 },
          { period: '2025-Q4', valuePct: 11 },
        ])),
    ],
    [
      'a breakout without its range window',
      (s) => Object.assign(s.technicals.consolidationBreakout, { value: { brokeOutUp: true } }),
    ],
    ['flows without a lookback window', (s) => Object.assign(s.sentiment.fiiNetFlow, { value: { netInrCr: 5 } })],
    ['a lowercase currency', (s) => void (s.currency = 'inr')],
    ['an offset asOf timestamp', (s) => void (s.asOf = '2026-09-30T15:30:00.000+05:30')],
    ['a nested instrument with an extra field', (s) => void Object.assign(s.instrument, { isin: 'X' })],
    [
      'an announcement headline over 500 chars',
      (s) => void (s.sentiment.announcements = okFin([{ publishedAt: OBSERVED, headline: 'x'.repeat(501) }])),
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = equitySnapshot();
    mutate(snapshot);
    expect(ResearchSnapshot.safeParse(snapshot).success).toBe(false);
  });
});
