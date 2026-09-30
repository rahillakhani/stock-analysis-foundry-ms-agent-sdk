import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env itself. Load apps/api/.env when present (local dev); CI and production set the
// variables in the process environment instead.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` doesn't connect, so it must work without a database URL (e.g. in CI's `npm ci`).
    url: process.env.DATABASE_URL ?? '',
  },
});
