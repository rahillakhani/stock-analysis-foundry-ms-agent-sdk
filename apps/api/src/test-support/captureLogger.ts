import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createLogger } from '../logger.ts';

/** A real (redacting) app logger whose JSON lines are captured in memory for assertions. */
export function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[]; raw: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const raw = () => chunks.join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger: createLogger({ LOG_LEVEL: 'info' }, destination), lines, raw };
}
