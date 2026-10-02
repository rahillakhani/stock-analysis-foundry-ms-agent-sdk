import {
  AnalysedStocks,
  AnalysisRunView,
  AnalyzeAccepted,
  AnalyzeRequest,
  LookupRequest,
  LookupResponse,
  SearchQuery,
  SearchResponse,
} from '@stock-analysis/shared';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.ts';
import { parseRequest } from '../http/validate.ts';
import type { AnalysisService } from '../services/analysisService.ts';

/** Malformed ids are a client error (400); a well-formed id that doesn't exist is 404. */
const RunIdParams = z.object({ id: z.uuid() });

/**
 * /api/v1 routes. Thin: validate input with the shared schema, call the service, and parse the response with the
 * shared schema before sending, so the API can never emit something the contract forbids.
 */
export function apiRouter(service: AnalysisService): Router {
  const router = Router();

  router.get('/stock/search', async (req, res) => {
    const { q } = parseRequest(SearchQuery, req.query);
    res.json(SearchResponse.parse({ candidates: await service.search(q) }));
  });

  router.post('/stock/lookup', async (req, res) => {
    const { query } = parseRequest(LookupRequest, req.body);
    res.json(LookupResponse.parse(await service.lookup(query)));
  });

  router.post('/stock/analyze', async (req, res) => {
    const { instrumentKey, force } = parseRequest(AnalyzeRequest, req.body);
    const accepted = AnalyzeAccepted.parse(await service.analyze(instrumentKey, force));
    res.status(202).location(`/api/v1/analysis-runs/${accepted.runId}`).json(accepted);
  });

  router.get('/stocks', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(AnalysedStocks.parse({ stocks: await service.listAnalysedStocks() }));
  });

  router.get('/analysis-runs/:id', async (req, res) => {
    const { id } = parseRequest(RunIdParams, req.params);
    const run = await service.getRun(id);
    if (!run) throw new AppError(404, 'Analysis run not found.');
    res.set('Cache-Control', 'no-store').json(AnalysisRunView.parse(run));
  });

  return router;
}
