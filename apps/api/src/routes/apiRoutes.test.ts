import {
  AnalysedStocks,
  AnalysisRunView,
  AnalyzeAccepted,
  LookupResponse,
  SearchResponse,
} from '@stock-analysis/shared';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { POLICY_V1, POLICY_V2 } from '../domain/decision/policy.ts';
import { FIXTURE_INSTRUMENTS } from '../domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { InstrumentDirectory } from '../domain/instruments/instrumentDirectory.ts';
import { InstrumentResolver } from '../domain/instruments/resolveInstrument.ts';
import { InMemoryAnalysisRepository } from '../repositories/inMemoryAnalysisRepository.ts';
import { FixtureResearchProvider } from '../research/fixtureResearchProvider.ts';
import { MarketResearchProvider } from '../research/marketResearchProvider.ts';
import { FakeMarketData } from '../test-support/fakeMarket.ts';
import { DEFAULT_AGGREGATOR_OPTIONS } from '../research/researchAggregator.ts';
import type { ResearchProvider } from '../research/researchProvider.ts';
import { AnalysisService } from '../services/analysisService.ts';

function setup(overrides: { provider?: ResearchProvider; start?: string } = {}) {
  let current = new Date(overrides.start ?? '2026-09-30T10:00:00.000Z');
  const clock = {
    now: () => new Date(current),
    advance: (ms: number) => void (current = new Date(current.getTime() + ms)),
  };
  const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
  const repository = new InMemoryAnalysisRepository(clock.now);
  const service = new AnalysisService({
    repository,
    directory: new InstrumentDirectory(new InstrumentResolver(master, clock.now), undefined, pino({ level: 'silent' })),
    provider: overrides.provider ?? new FixtureResearchProvider(master),
    policy: POLICY_V1,
    now: clock.now,
    logger: pino({ level: 'silent' }),
    aggregatorOptions: { ...DEFAULT_AGGREGATOR_OPTIONS, timeoutMs: 200 },
  });
  const app = createApp({ logger: pino({ level: 'silent' }), service });
  return { app, service, repository, clock };
}

async function analyzeAndWait(ctx: ReturnType<typeof setup>, instrumentKey: string, force = false) {
  const res = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey, force });
  expect(res.status).toBe(202);
  await ctx.service.idle();
  return AnalyzeAccepted.parse(res.body).runId;
}

describe('GET /api/v1/stock/search', () => {
  it('returns ranked candidates that satisfy the shared contract', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/v1/stock/search').query({ q: 'tata' });

    expect(res.status).toBe(200);
    const body = SearchResponse.parse(res.body);
    expect(body.candidates.map((c) => c.key)).toEqual(['NSE:TATACONSUM', 'NSE:TATAPOWER', 'NSE:TATASTEEL', 'NSE:TCS']);
  });

  it.each([
    ['missing q', {}],
    ['blank q', { q: '   ' }],
    ['oversized q', { q: 'x'.repeat(101) }],
  ])('rejects %s with 400 problem details listing the field', async (_label, query) => {
    const { app } = setup();
    const res = await request(app).get('/api/v1/stock/search').query(query);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, detail: 'Request validation failed.' });
    expect((res.body as { errors: { path: string }[] }).errors[0]).toMatchObject({ path: 'q' });
  });
});

describe('POST /api/v1/stock/lookup', () => {
  it.each([
    ['an unknown name', 'ZZZNOTREAL', 'NOT_FOUND'],
    ['partial input', 'tata', 'AMBIGUOUS'],
    ['an exact name', 'Tata Steel', 'RESOLVED'],
  ])('handles %s', async (_label, query, status) => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/stock/lookup').send({ query });
    expect(res.status).toBe(200);
    expect(LookupResponse.parse(res.body).status).toBe(status);
  });

  it('reports no existing analysis for a never-analysed stock', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/stock/lookup').send({ query: 'TATASTEEL' });
    expect(res.body).toMatchObject({ status: 'RESOLVED', instrumentKey: 'NSE:TATASTEEL', existing: null });
  });
});

describe('analysis flow (spec steps 1–4)', () => {
  it('analyses a new stock in the background, then offers the existing analysis on lookup', async () => {
    const ctx = setup();
    const accepted = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:TATASTEEL' });

    expect(accepted.status).toBe(202);
    const { runId, status } = AnalyzeAccepted.parse(accepted.body);
    expect(status).toBe('PENDING');
    expect(accepted.headers.location).toBe(`/api/v1/analysis-runs/${runId}`);

    await ctx.service.idle();
    const run = await request(ctx.app).get(`/api/v1/analysis-runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.headers['cache-control']).toBe('no-store');
    const view = AnalysisRunView.parse(run.body);
    expect(view.status).toBe('SUCCEEDED');
    expect(view.status === 'SUCCEEDED' && view.explanation).toEqual({ status: 'UNAVAILABLE' });

    ctx.clock.advance(3 * 3600 * 1000);
    const lookup = LookupResponse.parse(
      (await request(ctx.app).post('/api/v1/stock/lookup').send({ query: 'Tata Steel' })).body,
    );
    expect(lookup).toMatchObject({
      status: 'RESOLVED',
      existing: { ageSeconds: 3 * 3600, promptReanalysis: true, latestRun: { id: runId } },
    });
    expect(lookup.status === 'RESOLVED' && lookup.existing?.timeline.map((t) => t.eventType)).toEqual([
      'INITIAL_RESEARCH',
    ]);
  });

  it('requires confirmation (force) to re-analyse, then appends a RE_ANALYSIS timeline entry', async () => {
    const ctx = setup();
    const first = await analyzeAndWait(ctx, 'NSE:INFY');

    const unconfirmed = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:INFY' });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({ code: 'ANALYSIS_EXISTS', runId: first, status: 409 });

    ctx.clock.advance(86_400_000);
    const second = await analyzeAndWait(ctx, 'NSE:INFY', true);
    expect(second).not.toBe(first);

    const lookup = LookupResponse.parse(
      (await request(ctx.app).post('/api/v1/stock/lookup').send({ query: 'INFY' })).body,
    );
    expect(lookup.status === 'RESOLVED' && lookup.existing?.timeline.map((t) => [t.runId, t.eventType])).toEqual([
      [first, 'INITIAL_RESEARCH'],
      [second, 'RE_ANALYSIS'],
    ]);
    expect(lookup.status === 'RESOLVED' && lookup.existing?.latestRun.id).toBe(second);
  });

  it('rejects a second analysis while one is running, naming the running run', async () => {
    const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
    const fixture = new FixtureResearchProvider(master);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated: ResearchProvider = {
      name: 'gated',
      fetch: async (dimension, instrument, fetchCtx) => {
        await gate;
        return fixture.fetch(dimension, instrument, fetchCtx);
      },
    };
    const ctx = setup({ provider: gated });
    const first = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:WIPRO' });
    const second = await request(ctx.app)
      .post('/api/v1/stock/analyze')
      .send({ instrumentKey: 'NSE:WIPRO', force: true });

    expect(second.status).toBe(409);
    const firstRunId = AnalyzeAccepted.parse(first.body).runId;
    expect(second.body).toMatchObject({ code: 'RUN_IN_FLIGHT', runId: firstRunId });
    release();
    await ctx.service.idle();
    expect((await ctx.repository.getRun(firstRunId))?.status).toBe('SUCCEEDED');
  });

  it('analyses a futures contract by its key', async () => {
    const ctx = setup();
    const runId = await analyzeAndWait(ctx, 'NSE:NIFTY:FUT:2026-10-27');
    const view = AnalysisRunView.parse((await request(ctx.app).get(`/api/v1/analysis-runs/${runId}`)).body);
    expect(view).toMatchObject({ instrumentKey: 'NSE:NIFTY:FUT:2026-10-27', status: 'SUCCEEDED' });
  });

  it('records PARTIAL when a research dimension fails, naming it', async () => {
    const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
    const fixture = new FixtureResearchProvider(master);
    const flaky: ResearchProvider = {
      name: 'flaky',
      fetch: (dimension, instrument, ctx) =>
        dimension === 'sentiment'
          ? Promise.reject(new Error('upstream down'))
          : fixture.fetch(dimension, instrument, ctx),
    };
    const ctx = setup({ provider: flaky });
    const runId = await analyzeAndWait(ctx, 'NSE:TCS');

    const view = AnalysisRunView.parse((await request(ctx.app).get(`/api/v1/analysis-runs/${runId}`)).body);
    expect(view).toMatchObject({ status: 'PARTIAL', unavailableDimensions: ['sentiment'] });
  });

  it('records FAILED with a client-safe message when the analysis itself breaks', async () => {
    const ctx = setup();
    // Simulate a storage failure while completing: internal detail must not reach the client.
    ctx.repository.completeRun = () => Promise.reject(new Error('disk full at /var/lib/postgres'));
    const runId = await analyzeAndWait(ctx, 'NSE:ITC');

    const res = await request(ctx.app).get(`/api/v1/analysis-runs/${runId}`);
    expect(res.body).toMatchObject({
      status: 'FAILED',
      error: { code: 'ANALYSIS_FAILED', message: 'The analysis could not be completed. Please try again.' },
    });
    expect(JSON.stringify(res.body)).not.toContain('/var/lib');
  });

  it('cancels running analyses on shutdown and records them as cancelled', async () => {
    const never: ResearchProvider = {
      name: 'slow',
      fetch: (_d, _i, ctx) =>
        new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    const ctx = setup({ provider: never });
    ctx.service = new AnalysisService({
      repository: ctx.repository,
      directory: new InstrumentDirectory(
        new InstrumentResolver(new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS), ctx.clock.now),
        undefined,
        pino({ level: 'silent' }),
      ),
      provider: never,
      policy: POLICY_V1,
      now: ctx.clock.now,
      logger: pino({ level: 'silent' }),
      aggregatorOptions: { ...DEFAULT_AGGREGATOR_OPTIONS, timeoutMs: 60_000 },
    });
    const app = createApp({ logger: pino({ level: 'silent' }), service: ctx.service });
    const accepted = await request(app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:SBIN' });

    await ctx.service.shutdown();
    const res = await request(app).get(`/api/v1/analysis-runs/${AnalyzeAccepted.parse(accepted.body).runId}`);
    expect(res.body).toMatchObject({ status: 'FAILED', error: { code: 'ANALYSIS_CANCELLED' } });
  });

  it('fails runs interrupted by a previous restart so the stock can be analysed again', async () => {
    const ctx = setup();
    const stock = await ctx.repository.upsertStock({
      exchange: 'NSE',
      symbol: 'LT',
      name: 'Larsen & Toubro Ltd',
      assetType: 'EQUITY',
    });
    const orphan = await ctx.repository.createRun(stock.id);

    expect(await ctx.service.recoverInterruptedRuns()).toBe(1);
    expect((await ctx.repository.getRun(orphan.id))?.status).toBe('FAILED');
    await analyzeAndWait(ctx, 'NSE:LT');
  });
});

describe('POST /api/v1/stock/analyze validation', () => {
  it.each([
    ['a non-canonical key', { instrumentKey: 'TATASTEEL.NS' }, 400],
    ['a string force flag', { instrumentKey: 'NSE:TATASTEEL', force: 'yes' }, 400],
    ['an unknown instrument', { instrumentKey: 'NSE:ZZZZ' }, 404],
    ['an expired futures contract', { instrumentKey: 'NSE:NIFTY:FUT:2026-09-29' }, 404],
  ])('rejects %s', async (_label, body, status) => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/stock/analyze').send(body);
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });
});

describe('GET /api/v1/stocks', () => {
  it('lists analysed stocks, newest first, with their latest decision', async () => {
    const ctx = setup();
    expect((await request(ctx.app).get('/api/v1/stocks')).body).toEqual({ stocks: [] });

    await analyzeAndWait(ctx, 'NSE:TATASTEEL');
    ctx.clock.advance(60_000);
    await analyzeAndWait(ctx, 'NSE:TCS');

    const res = await request(ctx.app).get('/api/v1/stocks');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { stocks } = AnalysedStocks.parse(res.body);
    expect(stocks.map((s) => s.instrumentKey)).toEqual(['NSE:TCS', 'NSE:TATASTEEL']);
  });
});

describe('GET /api/v1/analysis-runs/:id', () => {
  it('returns 404 for a well-formed id that does not exist', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/v1/analysis-runs/0b9c8f5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ detail: 'Analysis run not found.' });
  });

  it.each(['not-a-uuid', 'x'.repeat(65)])('returns 400 for the malformed id %s', async (id) => {
    const { app } = setup();
    const res = await request(app).get(`/api/v1/analysis-runs/${id}`);
    expect(res.status).toBe(400);
    // Validation messages never echo the submitted value (`instance` is the request path by definition).
    expect(JSON.stringify((res.body as { errors: unknown[] }).errors)).not.toContain('xxxxxxxxxx');
  });
});

describe('Phase 8 review hardening', () => {
  const MINUTE = 60_000;

  it('closes a stalled in-flight run it does not own, so the stock is not blocked', async () => {
    const ctx = setup();
    const stock = await ctx.repository.upsertStock({
      exchange: 'NSE',
      symbol: 'ITC',
      name: 'ITC Ltd',
      assetType: 'EQUITY',
    });
    const orphan = await ctx.repository.createRun(stock.id);

    const recent = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:ITC', force: true });
    expect(recent.status).toBe(409);

    ctx.clock.advance(11 * MINUTE);
    const polled = AnalysisRunView.parse((await request(ctx.app).get(`/api/v1/analysis-runs/${orphan.id}`)).body);
    expect(polled).toMatchObject({ status: 'FAILED', error: { code: 'STALLED' } });
    await analyzeAndWait(ctx, 'NSE:ITC', true);
  });

  it('recovers a run whose failure could not be recorded once it goes stale', async () => {
    const ctx = setup();
    const originalFail = ctx.repository.failRun.bind(ctx.repository);
    ctx.repository.markRunning = () => Promise.reject(new Error('db down'));
    ctx.repository.failRun = () => Promise.reject(new Error('db still down'));
    const accepted = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:SBIN' });
    await ctx.service.idle();
    const runId = AnalyzeAccepted.parse(accepted.body).runId;
    expect((await ctx.repository.getRun(runId))?.status).toBe('PENDING');

    ctx.repository.failRun = originalFail;
    ctx.clock.advance(11 * MINUTE);
    const polled = AnalysisRunView.parse((await request(ctx.app).get(`/api/v1/analysis-runs/${runId}`)).body);
    expect(polled).toMatchObject({ status: 'FAILED', error: { code: 'STALLED' } });
  });

  it('refuses new analyses once shutdown has begun', async () => {
    const ctx = setup();
    await ctx.service.shutdown();
    const res = await request(ctx.app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NSE:TCS' });
    expect(res.status).toBe(503);
  });

  it('reports a persistence error after an abort as a failure, not a cancellation', async () => {
    const ctx = setup();
    ctx.repository.completeRun = async () => {
      void ctx.service.shutdown();
      await Promise.resolve();
      throw new Error('write failed');
    };
    const runId = await analyzeAndWait(ctx, 'NSE:TITAN');
    expect(await ctx.repository.getRun(runId)).toMatchObject({ status: 'FAILED', error: { code: 'ANALYSIS_FAILED' } });
  });

  it('asks the repository for at most the contract limit of timeline entries', async () => {
    const ctx = setup();
    await analyzeAndWait(ctx, 'NSE:HDFCBANK');
    const limits: (number | undefined)[] = [];
    const original = ctx.repository.getTimeline.bind(ctx.repository);
    ctx.repository.getTimeline = (stockId, limit) => {
      limits.push(limit);
      return original(stockId, limit);
    };
    await request(ctx.app).post('/api/v1/stock/lookup').send({ query: 'HDFCBANK' });
    expect(limits).toEqual([500]);
  });
});

describe('GET /readyz', () => {
  it('returns 503 quickly when the readiness check hangs', async () => {
    const logger = pino({ level: 'silent' });
    const hung = createApp({ logger, readiness: () => new Promise(() => undefined), readinessTimeoutMs: 20 });
    const started = Date.now();
    const res = await request(hung).get('/readyz');
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is ready when the readiness check passes and 503 when it fails', async () => {
    const logger = pino({ level: 'silent' });
    expect((await request(createApp({ logger, readiness: () => Promise.resolve() })).get('/readyz')).status).toBe(200);
    const down = await request(
      createApp({ logger, readiness: () => Promise.reject(new Error('db down: secret')) }),
    ).get('/readyz');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: 'unavailable' });
  });
});

describe('live research (web lookup + market data, offline fake vendor)', () => {
  function liveSetup() {
    const now = () => new Date('2026-10-01T10:00:00.000Z');
    const market = new FakeMarketData(now());
    const repository = new InMemoryAnalysisRepository(now);
    const service = new AnalysisService({
      repository,
      directory: new InstrumentDirectory(
        new InstrumentResolver(new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS), now),
        market,
        pino({ level: 'silent' }),
      ),
      provider: new MarketResearchProvider(market),
      policy: POLICY_V2,
      now,
      logger: pino({ level: 'silent' }),
    });
    return { app: createApp({ logger: pino({ level: 'silent' }), service }), service };
  }

  it('finds MakeMyTrip by name on the web, analyses it, and records a v2 decision', async () => {
    const { app, service } = liveSetup();
    const lookup = LookupResponse.parse(
      (await request(app).post('/api/v1/stock/lookup').send({ query: 'makemytrip' })).body,
    );
    expect(lookup).toMatchObject({ status: 'RESOLVED', instrumentKey: 'NASDAQ:MMYT', existing: null });

    const accepted = await request(app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NASDAQ:MMYT' });
    expect(accepted.status).toBe(202);
    await service.idle();
    const run = AnalysisRunView.parse(
      (await request(app).get(`/api/v1/analysis-runs/${AnalyzeAccepted.parse(accepted.body).runId}`)).body,
    );
    expect(run).toMatchObject({ status: 'SUCCEEDED', decision: { policyVersion: 'v2' } });
    expect(run.status === 'SUCCEEDED' && run.sources.every((s) => s.provider === 'yahoo-finance')).toBe(true);
  });

  it('suggests web results in autocomplete and resolves MRF to its NSE listing', async () => {
    const { app } = liveSetup();
    const search = SearchResponse.parse((await request(app).get('/api/v1/stock/search').query({ q: 'mrf' })).body);
    expect(search.candidates.map((c) => c.key)).toEqual(['NSE:MRF']);
    const lookup = LookupResponse.parse((await request(app).post('/api/v1/stock/lookup').send({ query: 'MRF' })).body);
    expect(lookup).toMatchObject({ status: 'RESOLVED', instrumentKey: 'NSE:MRF' });
  });

  it('answers 503, not 404, when the market source is down during analyze', async () => {
    const now = () => new Date('2026-10-01T10:00:00.000Z');
    const market = new FakeMarketData(now());
    market.failQuote = true;
    const service = new AnalysisService({
      repository: new InMemoryAnalysisRepository(now),
      directory: new InstrumentDirectory(
        new InstrumentResolver(new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS), now),
        market,
        pino({ level: 'silent' }),
      ),
      provider: new MarketResearchProvider(market),
      policy: POLICY_V2,
      now,
      logger: pino({ level: 'silent' }),
    });
    const app = createApp({ logger: pino({ level: 'silent' }), service });
    const res = await request(app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NASDAQ:MMYT' });
    expect(res.status).toBe(503);
  });

  it('rejects analysing a key the market does not list', async () => {
    const { app } = liveSetup();
    const res = await request(app).post('/api/v1/stock/analyze').send({ instrumentKey: 'NYSE:ZZZZ' });
    expect(res.status).toBe(404);
  });
});
