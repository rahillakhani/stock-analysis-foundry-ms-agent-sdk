import { createApp } from './app.ts';
import { EnvValidationError, loadEnv, type Env } from './config/env.ts';
import { createPrismaClient } from './db/prisma.ts';
import { POLICY_V2 } from './domain/decision/policy.ts';
import { InstrumentDirectory } from './domain/instruments/instrumentDirectory.ts';
import { FIXTURE_INSTRUMENTS } from './domain/instruments/fixtureInstruments.ts';
import { InMemoryInstrumentMaster } from './domain/instruments/instrumentMaster.ts';
import { InstrumentResolver } from './domain/instruments/resolveInstrument.ts';
import { createLogger } from './logger.ts';
import type { AnalysisRepository } from './repositories/analysisRepository.ts';
import { InMemoryAnalysisRepository } from './repositories/inMemoryAnalysisRepository.ts';
import { PrismaAnalysisRepository } from './repositories/prismaAnalysisRepository.ts';
import { YahooMarketData } from './market/yahooMarketData.ts';
import { FixtureResearchProvider } from './research/fixtureResearchProvider.ts';
import { MarketResearchProvider } from './research/marketResearchProvider.ts';
import { AnalysisService } from './services/analysisService.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readEnvOrExit(): Env {
  try {
    return loadEnv(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const env = readEnvOrExit();
const logger = createLogger(env);
const now = () => new Date();

const prisma = env.STORAGE === 'postgres' && env.DATABASE_URL ? createPrismaClient(env.DATABASE_URL) : undefined;
const repository: AnalysisRepository = prisma
  ? new PrismaAnalysisRepository(prisma, now)
  : new InMemoryAnalysisRepository(now);
const master = new InMemoryInstrumentMaster(FIXTURE_INSTRUMENTS);
const live = env.RESEARCH_PROVIDER === 'live';
// Separate Yahoo clients (each with its own request queue) so interactive search can't starve research, and vice versa.
const lookupMarket = live ? new YahooMarketData({ logger: logger.child({ component: 'yahoo-lookup' }) }) : undefined;
const researchMarket = live
  ? new YahooMarketData({ logger: logger.child({ component: 'yahoo-research' }) })
  : undefined;
const service = new AnalysisService({
  repository,
  directory: new InstrumentDirectory(new InstrumentResolver(master, now), lookupMarket, logger),
  provider: researchMarket ? new MarketResearchProvider(researchMarket) : new FixtureResearchProvider(master),
  policy: POLICY_V2,
  now,
  logger,
});

try {
  await service.recoverInterruptedRuns();
} catch (err) {
  logger.fatal({ err }, 'api failed to start: storage unavailable');
  process.exit(1);
}

const app = createApp({
  logger,
  service,
  readiness: async () => {
    if (prisma) await prisma.$queryRaw`SELECT 1`;
  },
});

const server = app.listen(env.PORT, env.HOST, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error }, 'api failed to start');
    process.exit(1);
  }
  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      storage: env.STORAGE,
      research: env.RESEARCH_PROVIDER === 'live' ? 'live (yahoo-finance)' : 'fixture (synthetic)',
    },
    'api listening',
  );
  // Express only wires the listen callback for startup errors; surface anything later instead of dropping it.
  server.on('error', (err) => logger.error({ err }, 'server error'));
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'api shutting down');
  setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(() => {
    void (async () => {
      await service.shutdown();
      await prisma?.$disconnect();
      process.exit(0);
    })().catch((err: unknown) => {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    });
  });
  // close() only drops connections idle *right now*. Keep-alive sockets that finish an in-flight request later would
  // otherwise linger (and accept new requests) until keepAliveTimeout, so sweep idle sockets until close completes.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 100).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
