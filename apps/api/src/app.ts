import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errorHandler.ts';
import { requestContext } from './http/requestContext.ts';
import { apiRouter } from './routes/apiRoutes.ts';
import { healthRouter } from './routes/health.ts';
import type { AnalysisService } from './services/analysisService.ts';

export interface AppDeps {
  logger: Logger;
  /** Omitted in tests that only exercise HTTP plumbing. */
  service?: AnalysisService;
  /** Resolves when dependencies are reachable; rejects otherwise. */
  readiness?: () => Promise<void>;
}

/** Builds the Express app from injected dependencies. No listening, no env reads: tests call this directly. */
export function createApp({ logger, service, readiness }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(readiness));
  if (service) app.use('/api/v1', apiRouter(service));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
