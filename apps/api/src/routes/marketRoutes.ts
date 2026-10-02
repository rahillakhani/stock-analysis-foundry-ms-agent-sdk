import { ChartInterval, InstrumentKey, LiveQuote, MarketMovers, PriceChart } from '@stock-analysis/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseRequest } from '../http/validate.ts';
import type { MarketService } from '../services/marketService.ts';

const KeyParams = z.object({ key: InstrumentKey });
const ChartQuery = z.object({ interval: ChartInterval.default('1d') });

/** /api/v1/market routes: live, informational market data for the UI. Responses are parsed against the contract. */
export function marketRouter(service: MarketService): Router {
  const router = Router();

  router.get('/movers', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(MarketMovers.parse(await service.movers()));
  });

  router.get('/chart/:key', async (req, res) => {
    const { key } = parseRequest(KeyParams, req.params);
    const { interval } = parseRequest(ChartQuery, req.query);
    res.set('Cache-Control', 'no-store').json(PriceChart.parse(await service.chart(key, interval)));
  });

  router.get('/quote/:key', async (req, res) => {
    const { key } = parseRequest(KeyParams, req.params);
    res.set('Cache-Control', 'no-store').json(LiveQuote.parse(await service.quote(key)));
  });

  return router;
}
