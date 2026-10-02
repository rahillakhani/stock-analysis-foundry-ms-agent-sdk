import { InstrumentKey, Watchlist } from '@stock-analysis/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseRequest } from '../http/validate.ts';
import type { WatchlistService } from '../services/watchlistService.ts';

const KeyParams = z.object({ key: InstrumentKey });

/** /api/v1/watchlist routes. Every call answers with the whole, updated list. PUT and DELETE are idempotent. */
export function watchlistRouter(service: WatchlistService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(Watchlist.parse(await service.list()));
  });

  router.put('/:key', async (req, res) => {
    const { key } = parseRequest(KeyParams, req.params);
    res.set('Cache-Control', 'no-store').json(Watchlist.parse(await service.pin(key)));
  });

  router.delete('/:key', async (req, res) => {
    const { key } = parseRequest(KeyParams, req.params);
    res.set('Cache-Control', 'no-store').json(Watchlist.parse(await service.unpin(key)));
  });

  return router;
}
