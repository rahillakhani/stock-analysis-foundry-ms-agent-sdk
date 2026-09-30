import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errorHandler.ts';
import { requestContext } from './http/requestContext.ts';
import { healthRouter } from './routes/health.ts';

export interface AppDeps {
  logger: Logger;
}

/** Builds the Express app from injected dependencies. No listening, no env reads: tests call this directly. */
export function createApp({ logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
