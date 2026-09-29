---
paths:
  - "apps/api/prisma/**"
  - "apps/api/src/db/**"
  - "apps/api/src/repositories/**"
---

# Database and Prisma Rules

- Prisma is pinned to a stable 7.x release (the npm `latest` tag was an 8.0 RC when checked on 2026-09-24). Verify
  schema and config syntax against the installed version's docs, not the snippet in `requirements.md`.
- Never edit a committed migration. Create a new one. A hook blocks edits to tracked `migration.sql` files.
- Constraints Prisma can't express (e.g. the partial unique index allowing one in-flight run per stock) go in a
  migration as raw SQL, with a comment explaining the constraint.
- Multi-row writes that must agree (complete run + append timeline + update `lastAnalysedAt`) use one
  `prisma.$transaction`.
- Repositories return domain types, not Prisma model types. `Json` columns are parsed with Zod on read.
- One `PrismaClient` per process (`src/db/prisma.ts`). Tests use a separate database from `DATABASE_URL_TEST`.
- `migrate reset` and `db push --force-reset` are denied in settings. Ask the user before any destructive DB command.
