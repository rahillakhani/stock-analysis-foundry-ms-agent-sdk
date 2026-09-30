import type { z } from 'zod';
import { AppError } from './errors.ts';

const MAX_REPORTED_ISSUES = 20;

/**
 * Parses untrusted request input with a shared schema. Failures become 400 problem details listing field paths
 * and messages (schema messages never echo the submitted values).
 */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(400, 'Request validation failed.', {
    extensions: {
      errors: result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}
