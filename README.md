# stock-analysis-foundry-ms-agent-sdk

AI stock and futures research engine: a deterministic TypeScript decision engine, research providers over MCP, and
Azure OpenAI explanations. See `requirements.md` for the spec and `implementation-plan.md` for the phased plan and
progress ledger.

> **Status: Phase 2 of 14.** The API runs in dev and prod but only serves `GET /healthz` so far. Search and analysis
> endpoints arrive in Phase 8, and the web UI arrives in Phase 9 (see [What's coming](#whats-coming)).

## Prerequisites

- Node.js 22.18+ (`nvm use` reads `.nvmrc`); dev mode relies on Node's built-in TypeScript type stripping, unflagged since 22.18
- npm 10+

## Setup (once)

```sh
git clone <repo-url>
cd stock-analysis-foundry-ms-agent-sdk
nvm use
npm install
cp apps/api/.env.example apps/api/.env   # optional; defaults work without it
```

## Development

```sh
npm run dev
```

- Starts the API from TypeScript source with Node's built-in type stripping. There's no build step, and it restarts
  automatically when a source file changes (`node --watch`).
- Listens on `http://127.0.0.1:3000` by default. Change it with `PORT` / `HOST` in `apps/api/.env` or inline:
  `PORT=4000 npm run dev`.
- Logs are JSON lines (pino). For readable output, pipe through `npx pino-pretty`, e.g. `npm run dev | npx pino-pretty`.
- Stop with `Ctrl+C`.

Check it:

```sh
curl -i http://127.0.0.1:3000/healthz
# HTTP/1.1 200 OK
# X-Request-Id: <uuid>
# {"status":"ok"}
```

## Production

```sh
npm ci                 # clean, lockfile-exact install
npm run build          # compiles packages/shared and apps/api to dist/
NODE_ENV=production HOST=0.0.0.0 PORT=3000 npm start
```

- `npm start` runs the compiled JavaScript (`apps/api/dist/server.js`), not the TypeScript source.
- Set configuration through the process environment (container env, App Service settings, Key Vault references).
  `apps/api/.env` is read only if present and is meant for local use.
- Use `HOST=0.0.0.0` inside a container or VM so the port is reachable from outside; the default `127.0.0.1` is
  local-only.
- On `SIGTERM` or `SIGINT` the server stops accepting connections, finishes in-flight requests, and exits. It
  force-exits after 10 seconds.
- If configuration is invalid, the process exits with code 1 before listening and prints which variable is wrong,
  without printing its value.

A production Docker image and `docker compose` stack are added in Phase 10.

### Configuration

| Variable    | Default       | Allowed values                                           |
| ----------- | ------------- | -------------------------------------------------------- |
| `NODE_ENV`  | `development` | `development`, `test`, `production`                      |
| `HOST`      | `127.0.0.1`   | any interface address                                    |
| `PORT`      | `3000`        | 1–65535                                                  |
| `LOG_LEVEL` | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

Never commit a real `.env`. `apps/api/.env.example` holds placeholders only.

### API (current)

| Method | Path       | Response                                                            |
| ------ | ---------- | ------------------------------------------------------------------- |
| GET    | `/healthz` | `200 {"status":"ok"}` (liveness only; no DB check until Phase 6)    |
| any    | other      | `404` `application/problem+json` with `requestId`                   |

All errors use `application/problem+json` (RFC 9457) and include `requestId`. It matches the `X-Request-Id`
response header, which is taken from the request if the caller sent a safe value.

## Quality checks

```sh
npm run format:check   # Prettier (markdown is excluded)
npm run lint           # ESLint with type-aware typescript-eslint rules
npm run typecheck      # tsc for root config files and every workspace
npm test               # Vitest across all workspace projects
npm run test:coverage  # tests with v8 coverage
npm run build          # production compile
```

CI (`.github/workflows/ci.yml`) runs all of these except coverage on every push to `main` and on every pull request.

## Layout

| Path              | Purpose                                                | Since    |
| ----------------- | ------------------------------------------------------ | -------- |
| `packages/shared` | Domain vocabulary and (from Phase 3) Zod contracts     | Phase 1  |
| `apps/api`        | Express API; later Prisma and the decision engine      | Phase 2  |
| `apps/web`        | Vite React frontend                                    | Phase 9  |

## What's coming

These commands don't exist yet. Each will be verified and moved into the sections above when its phase lands.

| What                        | Command (planned)                     | Phase | Needs                 |
| --------------------------- | ------------------------------------- | ----- | --------------------- |
| PostgreSQL for local dev    | `docker compose up -d db`             | 6     | Docker (or Colima)    |
| Search / analyze endpoints  | `npm run dev` (fixture data)          | 8     | Postgres running      |
| Web UI (dev)                | `npm run dev -w @stock-analysis/web`  | 9     | API running           |
| Full stack in containers    | `docker compose up --build`           | 10    | Docker                |
| Browser tests               | `npm run test:e2e`                    | 10    | Full stack running    |
| Live Azure explanations     | Azure vars in `.env`                  | 11    | Azure OpenAI resource |

Until Phase 12, all research data comes from bundled fixtures, so no market-data or Azure credentials are needed.

## Notes

- TypeScript is pinned to 6.0.x because `typescript-eslint` 8.x does not yet support TypeScript 7.
- Dependencies are saved with exact versions (`.npmrc` `save-exact=true`).
- Relative imports use `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`), and
  `erasableSyntaxOnly` keeps the source runnable by Node's type stripping.
- `@stock-analysis/shared` resolves to its TypeScript source in dev and tests (`development`/`types` export
  conditions) and to compiled `dist/` in production.
