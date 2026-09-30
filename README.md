# stock-analysis-foundry-ms-agent-sdk

AI stock and futures research engine: a deterministic TypeScript decision engine, research providers, and (later)
Azure OpenAI explanations. See `requirements.md` for the spec, `implementation-plan.md` for the phased plan and
progress ledger, and `docs/decision-policy-v1.md` for exactly how BUY / DON'T BUY / NEUTRAL is decided.

> **Status: API complete for the MVP (Phases 1–8).** Search, lookup, background analysis, and the timeline work
> against PostgreSQL. **All research data is synthetic sample data** (no market-data provider is connected yet), so
> verdicts are for trying the app, not for investing. The web UI arrives in Phase 9.

## Prerequisites

- Node.js 22.18+ (`nvm use` reads `.nvmrc`); dev mode relies on Node's built-in TypeScript type stripping
- npm 10+
- PostgreSQL 14+ running locally (Homebrew `postgresql@16` works), or use in-memory mode (see below)

## Setup (once)

```sh
git clone <repo-url>
cd stock-analysis-foundry-ms-agent-sdk
nvm use
npm install                                   # also generates the Prisma client

createdb stock_analysis                       # app database
createdb stock_analysis_test                  # integration-test database (tests TRUNCATE it)

cp apps/api/.env.example apps/api/.env        # then edit DATABASE_URL / DATABASE_URL_TEST for your user
npm run db:deploy -w @stock-analysis/api      # apply migrations to DATABASE_URL
DATABASE_URL=postgresql://<user>@localhost:5432/stock_analysis_test npm run db:deploy -w @stock-analysis/api
```

With a local Homebrew Postgres the URL is usually `postgresql://<your-macOS-user>@localhost:5432/stock_analysis`
(no password needed with local trust auth).

## Development

```sh
npm run dev
```

- Starts the API from TypeScript source with no build step, restarting when a source file changes.
- Reads `apps/api/.env`. Listens on `http://127.0.0.1:3000` (`PORT` / `HOST` to change).
- Runs left in progress by a previous stop are marked FAILED ("interrupted") at startup, so a restart never blocks a
  stock.
- JSON logs; for readable output: `npm run dev | npx pino-pretty`.

**No database?** `STORAGE=memory npm run dev` runs everything in memory (data is lost on restart).

### Try it

```sh
curl 'http://127.0.0.1:3000/api/v1/stock/search?q=tata'
curl -X POST http://127.0.0.1:3000/api/v1/stock/lookup  -H 'content-type: application/json' -d '{"query":"Tata Steel"}'
curl -X POST http://127.0.0.1:3000/api/v1/stock/analyze -H 'content-type: application/json' -d '{"instrumentKey":"NSE:TATASTEEL"}'
curl http://127.0.0.1:3000/api/v1/analysis-runs/<runId from the previous response>
```

## Production

```sh
npm ci
npm run build                                   # generates the Prisma client, compiles to dist/
npm run db:deploy -w @stock-analysis/api        # apply pending migrations
NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_URL=postgresql://... npm start
```

- Configuration comes from the process environment; `apps/api/.env` is only read if present.
- On `SIGTERM`/`SIGINT` the server stops accepting connections, cancels running analyses (recorded as cancelled),
  disconnects from the database, and exits; it force-exits after 10 seconds.
- Invalid configuration exits with code 1 before listening, naming the variable but never printing its value.
- Run **exactly one API process per database**: analyses execute in-process, and startup marks every in-flight run
  as interrupted. Replicas need run ownership first (final hardening phase).
- Docker images and compose are deferred to the final hardening phase.

### Configuration

| Variable            | Default       | Notes                                                                    |
| ------------------- | ------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`          | `development` | `development`, `test`, `production`                                      |
| `HOST`              | `127.0.0.1`   | use `0.0.0.0` in a container or VM                                       |
| `PORT`              | `3000`        | 1–65535                                                                  |
| `LOG_LEVEL`         | `info`        | `fatal` … `trace`, `silent`                                              |
| `STORAGE`           | `postgres`    | `postgres`, or `memory` for a DB-less demo                               |
| `DATABASE_URL`      | —             | required when `STORAGE=postgres`; `postgresql://…`                        |
| `DATABASE_URL_TEST` | —             | only for `npm run test:int`; must name a database ending in `_test`      |

Never commit a real `.env`; `apps/api/.env.example` holds placeholders only.

## API (v1)

| Method | Path                           | Purpose                                                                                     |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                     | liveness                                                                                    |
| GET    | `/readyz`                      | readiness (database reachable); 503 otherwise                                              |
| GET    | `/api/v1/stock/search?q=`      | autocomplete candidates (max 10)                                                            |
| POST   | `/api/v1/stock/lookup`         | `{query}` → `NOT_FOUND` / `AMBIGUOUS` (candidates) / `RESOLVED` with any existing analysis |
| POST   | `/api/v1/stock/analyze`        | `{instrumentKey, force?}` → `202 {runId}`; `409` `ANALYSIS_EXISTS` or `RUN_IN_FLIGHT`       |
| GET    | `/api/v1/analysis-runs/:id`    | run status: `PENDING` → `RUNNING` → `SUCCEEDED` / `PARTIAL` / `FAILED`                       |

Request and response shapes are the Zod contracts in `packages/shared/src/api.ts`; the API validates every response
against them. Errors are `application/problem+json` (RFC 9457) with `requestId` and, where relevant, `code`, `runId`,
or `errors` (validation). Partial input never auto-resolves: "hdfc" returns candidates, not a guess.

## Quality checks

```sh
npm run format:check   # Prettier (markdown is excluded)
npm run lint           # ESLint with type-aware typescript-eslint rules
npm run typecheck      # tsc for root config files and every workspace
npm test               # unit/API tests (no database needed)
npm run test:int       # PostgreSQL integration tests (needs DATABASE_URL_TEST; local only for now)
npm run build          # production compile
```

CI (`.github/workflows/ci.yml`) runs format, lint, typecheck, unit tests, and build on pushes to `main` and on pull
requests. Postgres integration tests run locally until CI gains a database (deferred).

## Layout

| Path                            | Purpose                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared`               | Zod contracts shared by API and web                                      |
| `apps/api/src/domain`           | instrument resolution and the deterministic decision engine              |
| `apps/api/src/research`         | research provider port, synthetic sample provider, aggregator           |
| `apps/api/src/repositories`     | persistence port with Prisma (Postgres) and in-memory implementations   |
| `apps/api/src/services`         | analysis orchestration (lookup, background runs)                         |
| `apps/api/prisma`               | schema and migrations                                                    |
| `apps/web`                      | Vite React frontend (Phase 9)                                            |

## Notes

- TypeScript is pinned to 6.0.x (`typescript-eslint` 8.x doesn't support TypeScript 7 yet); Prisma to 7.10 (npm's
  `latest` was an 8.0 release candidate).
- Relative imports use `.ts` extensions, and `erasableSyntaxOnly` keeps the source runnable by Node type stripping.
- `@stock-analysis/shared` resolves to TypeScript source in dev and tests, and to compiled `dist/` in production.
