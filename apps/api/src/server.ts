import { createApp } from './app.ts';
import { EnvValidationError, loadEnv, type Env } from './config/env.ts';
import { createLogger } from './logger.ts';

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
const app = createApp({ logger });

const server = app.listen(env.PORT, env.HOST, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error }, 'api failed to start');
    process.exit(1);
  }
  logger.info({ host: env.HOST, port: env.PORT, nodeEnv: env.NODE_ENV }, 'api listening');
  // Express only wires the listen callback for startup errors; surface anything later instead of dropping it.
  server.on('error', (err) => logger.error({ err }, 'server error'));
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'api shutting down');
  setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close((err) => process.exit(err ? 1 : 0));
  // close() only drops connections idle *right now*. Keep-alive sockets that finish an in-flight request later would
  // otherwise linger (and accept new requests) until keepAliveTimeout, so sweep idle sockets until close completes.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 100).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
