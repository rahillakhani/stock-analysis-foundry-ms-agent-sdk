// Contract-valid API payloads for UI tests (parsed with the shared schemas so tests can't drift from the API).
import {
  AnalysisRunView,
  LookupResponse,
  TimelineEntryView,
  type DecisionIndicator,
  type Instrument,
} from '@stock-analysis/shared';

export const RUN_ID = '0b9c8f5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
export const OTHER_RUN_ID = '1c9c8f5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
export const TATA: Instrument = { exchange: 'NSE', symbol: 'TATASTEEL', name: 'Tata Steel Ltd', assetType: 'EQUITY' };
const SOURCE = {
  id: 'fixture:technicals:tatasteel:2026-09-30',
  provider: 'fixture',
  retrievedAt: '2026-09-30T10:00:00.000Z',
};

export function completedRun(
  overrides: { id?: string; indicator?: DecisionIndicator; status?: 'SUCCEEDED' | 'PARTIAL' } = {},
): AnalysisRunView {
  const status = overrides.status ?? 'SUCCEEDED';
  return AnalysisRunView.parse({
    id: overrides.id ?? RUN_ID,
    instrumentKey: 'NSE:TATASTEEL',
    startedAt: '2026-09-30T10:00:00.000Z',
    status,
    completedAt: '2026-09-30T10:00:02.000Z',
    decision: {
      indicator: overrides.indicator ?? 'DONT_BUY',
      confidenceScore: 75,
      subscores: { fundamental: 71.4, technical: 42.9, derivatives: null, sentiment: 66.7 },
      riskReward: { ratio: 2, entry: 152.3, stop: 144.5, target: 167.9, method: 'Stop 2×ATR14 below entry.' },
      reasons: [{ code: 'ROE_ABOVE_MIN', message: 'ROE 18% vs minimum above 15%.', sourceIds: [SOURCE.id] }],
      riskFactors: [
        {
          code: 'OPERATING_MARGIN_SHRINKING',
          message: 'Operating margin shrinking for 3 quarters.',
          sourceIds: [SOURCE.id],
        },
      ],
      policyVersion: 'v1',
      evaluatedAt: '2026-09-30T10:00:02.000Z',
    },
    explanation: { status: 'UNAVAILABLE' },
    sources: [SOURCE],
    ...(status === 'PARTIAL' ? { unavailableDimensions: ['sentiment'] } : {}),
  });
}

export function timelineEntry(runId = RUN_ID, eventType: 'INITIAL_RESEARCH' | 'RE_ANALYSIS' = 'INITIAL_RESEARCH') {
  return TimelineEntryView.parse({
    id: runId.replace(/^./, '9'),
    runId,
    eventType,
    createdAt: '2026-09-30T10:00:02.000Z',
    indicator: 'DONT_BUY',
    confidenceScore: 75,
    policyVersion: 'v1',
  });
}

export const resolvedNew = LookupResponse.parse({
  status: 'RESOLVED',
  instrument: TATA,
  instrumentKey: 'NSE:TATASTEEL',
  existing: null,
});

export function resolvedExisting(run = completedRun(), timeline = [timelineEntry()], ageSeconds = 7200) {
  return LookupResponse.parse({
    status: 'RESOLVED',
    instrument: TATA,
    instrumentKey: 'NSE:TATASTEEL',
    existing: { latestRun: run, timeline, ageSeconds, promptReanalysis: true },
  });
}

export const inFlight = (status: 'PENDING' | 'RUNNING', id = RUN_ID) =>
  AnalysisRunView.parse({ id, instrumentKey: 'NSE:TATASTEEL', startedAt: '2026-09-30T10:00:00.000Z', status });

export const failedRun = AnalysisRunView.parse({
  id: RUN_ID,
  instrumentKey: 'NSE:TATASTEEL',
  startedAt: '2026-09-30T10:00:00.000Z',
  status: 'FAILED',
  completedAt: '2026-09-30T10:00:01.000Z',
  error: { code: 'ANALYSIS_FAILED', message: 'The analysis could not be completed. Please try again.' },
});
