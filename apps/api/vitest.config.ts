import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // Postgres-backed tests run only via `npm run test:int`.
    exclude: ['src/**/*.int.test.ts'],
    environment: 'node',
  },
});
