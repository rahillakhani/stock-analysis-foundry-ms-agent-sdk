import { ResearchSnapshot, Watchlist, WATCHLIST_LIMIT } from '@stock-analysis/shared';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V2 } from '../domain/decision/policy.ts';
import { FIXTURE_INSTRUMENTS } from '../domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from '../domain/instruments/instrumentMaster.ts';
import { InstrumentDirectory } from '../domain/instruments/instrumentDirectory.ts';
import { InstrumentResolver } from '../domain/instruments/resolveInstrument.ts';
import { InMemoryAnalysisRepository } from '../repositories/inMemoryAnalysisRepository.ts';
import { InMemoryWatchlistRepository } from '../repositories/watchlistRepository.ts';
import { WatchlistService } from '../services/watchlistService.ts';
import { FakeMarketData } from '../test-support/fakeMarket.ts';
import { strongEquity } from '../test-support/snapshots.ts';

let NOW = new Date('2026-10-01T10:00:00.000Z');
const silent = pino({ level: 'silent' });

function setup(market: FakeMarketData | null = new FakeMarketData(NOW)) {
  const analyses = new InMemoryAnalysisRepository(() => NOW);
  const watchlistRepo = new InMemoryWatchlistRepository(() => NOW);
  const directory = new InstrumentDirectory(
    new InstrumentResolver(new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS), () => NOW),
    market ?? undefined,
    silent,
  );
  const watchlist = new WatchlistService({
    now: () => NOW,
    watchlist: watchlistRepo,
    analyses,
    directory,
    market: market ?? undefined,
    logger: silent,
  });
  return { app: createApp({ logger: silent, watchlist }), analyses, watchlistRepo };
}

const body = (res: { body: unknown }) => Watchlist.parse(res.body);

describe('/api/v1/watchlist', () => {
  it('pins, lists newest first with live prices, and unpins idempotently', async () => {
    const { app } = setup();
    expect(body(await request(app).get('/api/v1/watchlist'))).toEqual({ items: [] });

    await request(app).put('/api/v1/watchlist/NSE:TATASTEEL').expect(200);
    const res = await request(app)
      .put(`/api/v1/watchlist/${encodeURIComponent('BSE:SENSEX:FUT:2026-10-29')}`)
      .expect(200);
    const items = body(res).items;
    expect(items.map((i) => i.instrumentKey)).toEqual(['BSE:SENSEX:FUT:2026-10-29', 'NSE:TATASTEEL']);
    // Futures have no live quote; equities get one from a single batch request.
    expect(items[0]?.quote).toBeNull();
    expect(items[1]?.quote).toMatchObject({ currency: 'INR', marketState: 'REGULAR' });
    expect(items[1]?.latest).toBeNull();

    expect(body(await request(app).delete('/api/v1/watchlist/NSE:TATASTEEL')).items).toHaveLength(1);
    expect(body(await request(app).delete('/api/v1/watchlist/NSE:TATASTEEL')).items).toHaveLength(1);
  });

  it("shows a pinned stock's latest analysis", async () => {
    const { app, analyses } = setup();
    const snapshot = ResearchSnapshot.parse({
      ...strongEquity(),
      instrument: { exchange: 'NSE', symbol: 'TATASTEEL', name: 'Tata Steel Ltd', assetType: 'EQUITY' },
    });
    const stock = await analyses.upsertStock(snapshot.instrument);
    const run = await analyses.createRun(stock.id);
    const decision = evaluate(snapshot, POLICY_V2, NOW);
    await analyses.completeRun(run.id, {
      status: 'SUCCEEDED',
      decision,
      explanation: { status: 'UNAVAILABLE' },
      snapshot,
      sources: snapshot.sources,
      unavailableDimensions: [],
    });

    const res = await request(app).put(`/api/v1/watchlist/${stock.instrumentKey}`);
    expect(body(res).items[0]?.latest).toEqual({
      lastAnalysedAt: NOW.toISOString(),
      indicator: decision.indicator,
      confidenceScore: decision.confidenceScore,
      policyVersion: 'v2',
      runStatus: 'SUCCEEDED',
    });
  });

  it('lists without prices when the vendor fails or live data is off', async () => {
    const market = new FakeMarketData(NOW);
    const { app } = setup(market);
    await request(app).put('/api/v1/watchlist/NSE:TATASTEEL').expect(200);
    market.failQuote = true;
    expect(body(await request(app).get('/api/v1/watchlist')).items[0]?.quote).toBeNull();

    const off = setup(null);
    expect(body(await request(off.app).put('/api/v1/watchlist/NSE:TATASTEEL')).items[0]?.quote).toBeNull();
  });

  it('marks a pinned futures contract expired after its expiry (15:30 IST)', async () => {
    const { app } = setup();
    const key = encodeURIComponent('BSE:SENSEX:FUT:2026-10-29');
    expect(body(await request(app).put(`/api/v1/watchlist/${key}`)).items[0]?.expired).toBe(false);
    NOW = new Date('2026-10-29T10:00:00.000Z'); // 15:30 IST on expiry day
    try {
      expect(body(await request(app).get('/api/v1/watchlist')).items[0]?.expired).toBe(true);
    } finally {
      NOW = new Date('2026-10-01T10:00:00.000Z');
    }
  });

  it("keeps a pinned stock's signal however many stocks were analysed after it", async () => {
    const { app, analyses } = setup();
    const listed = vi.spyOn(analyses, 'listAnalysedStocks');
    await request(app).put('/api/v1/watchlist/NSE:TATASTEEL').expect(200);
    expect(listed).toHaveBeenLastCalledWith({ keys: ['NSE:TATASTEEL'] });
  });

  it.each([
    ['a malformed key', '/api/v1/watchlist/nope', 400],
    ['an unknown instrument', '/api/v1/watchlist/NSE:NOSUCH', 404],
  ])('rejects pinning %s', async (_label, path, status) => {
    const { app } = setup();
    expect((await request(app).put(path)).status).toBe(status);
  });

  it('answers 409 WATCHLIST_FULL beyond the limit', async () => {
    const { app, watchlistRepo } = setup();
    for (let i = 0; i < WATCHLIST_LIMIT; i += 1) {
      await watchlistRepo.pin({ exchange: 'NSE', symbol: `S${i}`, name: `S${i}`, assetType: 'EQUITY' });
    }
    const res = await request(app).put('/api/v1/watchlist/NSE:TATASTEEL');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'WATCHLIST_FULL' });
  });
});
