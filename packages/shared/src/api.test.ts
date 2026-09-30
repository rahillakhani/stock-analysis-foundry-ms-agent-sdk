import { describe, expect, it } from 'vitest';
import {
  AnalysisRunView,
  AnalyzeRequest,
  Explanation,
  InstrumentSummary,
  LookupResponse,
  SearchQuery,
  SearchResponse,
  TimelineEntryView,
} from './api.ts';
import { AS_OF, decision, equity, niftyFuture, sources, SRC_FIN } from './test-support/fixtures.ts';

const RUN_ID = '0b9c8f5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
const STARTED = '2026-09-30T09:59:00.000Z';
const base = { id: RUN_ID, instrumentKey: 'NSE:TATASTEEL', startedAt: STARTED };
const explanation = {
  status: 'AVAILABLE',
  summaryMarkdown: '**Summary**',
  keyDrivers: ['ROE above 15%'],
  riskFactors: ['Cyclical sector'],
  citations: [SRC_FIN],
};
const succeeded = {
  ...base,
  status: 'SUCCEEDED',
  completedAt: AS_OF,
  decision: decision(),
  explanation,
  sources: sources(),
};
const candidate = {
  key: 'NSE:TATASTEEL',
  exchange: 'NSE',
  symbol: 'TATASTEEL',
  assetType: 'EQUITY',
  name: 'Tata Steel',
};

function messagesOf(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } },
  input: unknown,
) {
  const result = schema.safeParse(input);
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);
}

describe('SearchQuery', () => {
  it('trims the query', () => {
    expect(SearchQuery.parse({ q: '  tata steel ' })).toEqual({ q: 'tata steel' });
  });

  it.each(['', '   ', 'x'.repeat(101)])('rejects %j', (q) => {
    expect(SearchQuery.safeParse({ q }).success).toBe(false);
  });
});

describe('InstrumentSummary / SearchResponse', () => {
  it('accepts consistent equity and future candidates', () => {
    const future = {
      key: 'NSE:NIFTY:FUT:2026-10-27',
      exchange: 'NSE',
      symbol: 'NIFTY',
      assetType: 'FUTURE',
      name: 'Nifty Fut',
    };
    expect(SearchResponse.safeParse({ candidates: [candidate, future] }).success).toBe(true);
  });

  it.each([
    ['non-canonical key', { ...candidate, key: 'TATASTEEL.NS' }],
    ['key on another exchange', { ...candidate, key: 'BSE:TATASTEEL' }],
    ['key for another symbol', { ...candidate, key: 'NSE:INFY' }],
    ['FUTURE with an equity key', { ...candidate, assetType: 'FUTURE' }],
    ['EQUITY with a futures key', { ...candidate, key: 'NSE:TATASTEEL:FUT:2026-10-27' }],
  ])('rejects %s', (_label, input) => {
    expect(InstrumentSummary.safeParse(input).success).toBe(false);
  });
});

describe('AnalysisRunView', () => {
  it.each([
    ['PENDING', { ...base, status: 'PENDING' }],
    ['RUNNING', { ...base, status: 'RUNNING' }],
    ['SUCCEEDED with decision', succeeded],
    ['SUCCEEDED with unavailable explanation', { ...succeeded, explanation: { status: 'UNAVAILABLE' } }],
    [
      'PARTIAL naming unavailable dimensions',
      { ...succeeded, status: 'PARTIAL', unavailableDimensions: ['derivatives'] },
    ],
    [
      'FAILED with error',
      { ...base, status: 'FAILED', completedAt: AS_OF, error: { code: 'PROVIDER_TIMEOUT', message: 'Try again.' } },
    ],
    [
      'FUTURE run with a derivatives subscore',
      {
        ...succeeded,
        instrumentKey: 'NSE:NIFTY:FUT:2026-10-27',
        decision: { ...decision(), subscores: { ...decision().subscores, derivatives: 70 } },
      },
    ],
  ])('accepts %s', (_label, input) => {
    expect(messagesOf(AnalysisRunView, input)).toEqual([]);
  });

  it.each([
    ['SUCCEEDED without decision', { ...succeeded, decision: undefined }],
    ['SUCCEEDED without completedAt', { ...succeeded, completedAt: undefined }],
    ['PARTIAL without unavailable dimensions', { ...succeeded, status: 'PARTIAL', unavailableDimensions: [] }],
    [
      'PARTIAL with duplicate dimensions',
      { ...succeeded, status: 'PARTIAL', unavailableDimensions: ['derivatives', 'derivatives'] },
    ],
    ['FAILED without error', { ...base, status: 'FAILED', completedAt: AS_OF }],
    [
      'FAILED with empty message',
      { ...base, status: 'FAILED', completedAt: AS_OF, error: { code: 'X_Y', message: '' } },
    ],
    ['non-uuid id', { ...base, id: '42', status: 'PENDING' }],
    ['unknown status', { ...base, status: 'CANCELLED' }],
  ])('rejects %s', (_label, input) => {
    expect(AnalysisRunView.safeParse(input).success).toBe(false);
  });

  it('rejects an explanation citation that is not one of the run sources', () => {
    const input = { ...succeeded, explanation: { ...explanation, citations: ['fixture:invented'] } };
    expect(messagesOf(AnalysisRunView, input)).toEqual(['cited source "fixture:invented" is not listed in sources']);
  });

  it('rejects a decision reason citing a source outside the run', () => {
    const reasons = [{ code: 'GHOST', message: 'x', sourceIds: ['ghost:x'] }];
    const input = { ...succeeded, decision: { ...decision(), reasons } };
    expect(messagesOf(AnalysisRunView, input)).toEqual(['cited source "ghost:x" is not listed in sources']);
  });

  it('rejects completedAt before startedAt', () => {
    const input = { ...succeeded, completedAt: '2026-09-30T09:00:00.000Z' };
    expect(messagesOf(AnalysisRunView, input)).toEqual(['completedAt is before startedAt']);
  });

  it('rejects a FUTURE run without a derivatives subscore', () => {
    const input = { ...succeeded, instrumentKey: 'NSE:NIFTY:FUT:2026-10-27' };
    expect(messagesOf(AnalysisRunView, input)).toEqual(['a FUTURE run must have a derivatives subscore']);
  });
});

describe('Explanation', () => {
  it('requires at least one citation when available', () => {
    expect(Explanation.safeParse({ ...explanation, citations: [] }).success).toBe(false);
  });
});

describe('TimelineEntryView', () => {
  const entry = {
    id: RUN_ID,
    runId: RUN_ID,
    eventType: 'RE_ANALYSIS',
    createdAt: AS_OF,
    indicator: 'NEUTRAL',
    confidenceScore: 40,
    policyVersion: 'v1',
  };

  it('accepts a valid entry', () => {
    expect(TimelineEntryView.safeParse(entry).success).toBe(true);
  });

  it.each(['', 'latest', 'v1.2'])('rejects policy version %j', (policyVersion) => {
    expect(TimelineEntryView.safeParse({ ...entry, policyVersion }).success).toBe(false);
  });
});

describe('LookupResponse', () => {
  const resolved = { status: 'RESOLVED', instrument: equity, instrumentKey: 'NSE:TATASTEEL' };
  const existing = { latestRun: succeeded, timeline: [], ageSeconds: 3600, promptReanalysis: true };

  it('accepts a never-analysed instrument and an existing analysis', () => {
    expect(messagesOf(LookupResponse, { ...resolved, existing: null })).toEqual([]);
    expect(messagesOf(LookupResponse, { ...resolved, existing })).toEqual([]);
  });

  it('accepts NOT_FOUND and multi-candidate AMBIGUOUS', () => {
    expect(LookupResponse.safeParse({ status: 'NOT_FOUND' }).success).toBe(true);
    const other = { ...candidate, key: 'BSE:TATASTEEL', exchange: 'BSE' };
    expect(LookupResponse.safeParse({ status: 'AMBIGUOUS', candidates: [candidate, other] }).success).toBe(true);
  });

  it.each([
    [
      'existing record without the re-analysis prompt',
      { ...resolved, existing: { ...existing, promptReanalysis: false } },
    ],
    ['negative age', { ...resolved, existing: { ...existing, ageSeconds: -1 } }],
    ['ambiguous result with a single candidate', { status: 'AMBIGUOUS', candidates: [candidate] }],
  ])('rejects %s', (_label, input) => {
    expect(LookupResponse.safeParse(input).success).toBe(false);
  });

  it('rejects an instrumentKey that does not match the instrument', () => {
    expect(messagesOf(LookupResponse, { ...resolved, instrumentKey: 'BSE:INFY', existing: null })).toEqual([
      'instrumentKey does not match instrument',
    ]);
  });

  it('rejects a latest run that belongs to another instrument', () => {
    const otherRun = { ...succeeded, instrumentKey: 'NSE:INFY' };
    expect(messagesOf(LookupResponse, { ...resolved, existing: { ...existing, latestRun: otherRun } })).toEqual([
      'latest run belongs to a different instrument',
    ]);
  });

  it('accepts a resolved future keyed by its expiry', () => {
    const future = {
      status: 'RESOLVED',
      instrument: niftyFuture,
      instrumentKey: 'NSE:NIFTY:FUT:2026-10-27',
      existing: null,
    };
    expect(messagesOf(LookupResponse, future)).toEqual([]);
  });
});

describe('AnalyzeRequest', () => {
  it('defaults force to false', () => {
    expect(AnalyzeRequest.parse({ instrumentKey: 'NSE:TATASTEEL' })).toEqual({
      instrumentKey: 'NSE:TATASTEEL',
      force: false,
    });
  });

  it.each([
    ['non-canonical instrument key', { instrumentKey: 'TATASTEEL.NS' }],
    ['string force flag', { instrumentKey: 'NSE:TATASTEEL', force: 'true' }],
  ])('rejects %s', (_label, input) => {
    expect(AnalyzeRequest.safeParse(input).success).toBe(false);
  });
});
