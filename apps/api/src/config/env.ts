import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  // Decimal digits only: Number() coercion would also accept '0x50' or '1e3'.
  PORT: z
    .string()
    .regex(/^\d{1,5}$/, 'must be a decimal integer')
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

/**
 * Validates configuration once at startup. The error message names each invalid variable and the rule it broke,
 * never the supplied value, so a mistyped secret can't leak into logs.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
  }
  return Object.freeze(result.data);
}
