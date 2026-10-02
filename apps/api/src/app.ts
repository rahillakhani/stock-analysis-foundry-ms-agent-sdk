import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errorHandler.ts';
import { requestContext } from './http/requestContext.ts';
import { apiRouter } from './routes/apiRoutes.ts';
import { healthRouter } from './routes/health.ts';
import { marketRouter } from './routes/marketRoutes.ts';
import type { AnalysisService } from './services/analysisService.ts';
import type { MarketService } from './services/marketService.ts';

export interface AppDeps {
  logger: Logger;
  /** Omitted in tests that only exercise HTTP plumbing. */
  service?: AnalysisService;
  market?: MarketService;
  /** Resolves when dependencies are reachable; rejects otherwise. */
  readiness?: () => Promise<void>;
  readinessTimeoutMs?: number;
}

/** Builds the Express app from injected dependencies. No listening, no env reads: tests call this directly. */
export function createApp({ logger, service, market, readiness, readinessTimeoutMs }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(readiness, readinessTimeoutMs));
  if (market) app.use('/api/v1/market', marketRouter(market));
  if (service) app.use('/api/v1', apiRouter(service));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
