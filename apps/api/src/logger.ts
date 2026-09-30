import { pino, type DestinationStream, type Logger } from 'pino';
import type { Env } from './config/env.ts';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL'>, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    base: { service: 'api' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
