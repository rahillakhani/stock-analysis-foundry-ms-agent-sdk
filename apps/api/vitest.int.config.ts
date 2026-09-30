import { defineConfig } from 'vitest/config';

// Integration tests need a real Postgres. Load apps/api/.env when present so DATABASE_URL_TEST can live there.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: DATABASE_URL_TEST must come from the environment.
}

const testUrl = process.env.DATABASE_URL_TEST;
if (testUrl && !new URL(testUrl).pathname.endsWith('_test')) {
  throw new Error('DATABASE_URL_TEST must point at a database whose name ends in _test (tests TRUNCATE it)');
}

export default defineConfig({
  test: {
    name: 'api-int',
    include: ['src/**/*.int.test.ts'],
    environment: 'node',
    // Tests share one database and truncate it between cases, so they must not run in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
