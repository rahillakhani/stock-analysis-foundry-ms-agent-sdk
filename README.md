# stock-analysis-foundry-ms-agent-sdk

AI stock and futures research engine: a deterministic TypeScript decision engine, research providers over MCP, and
Azure OpenAI explanations. See `requirements.md` for the spec and `implementation-plan.md` for the phased plan and
progress ledger.

## Prerequisites

- Node.js 22 (`nvm use` reads `.nvmrc`)
- npm 10+

## Running the apps

> **Current status (Phase 1 of 14):** there is no runnable app yet. The repository contains the workspace tooling and
> the `packages/shared` library only. Today you can install and run the quality checks:
>
> ```sh
> git clone <repo-url> && cd stock-analysis-foundry-ms-agent-sdk
> nvm use            # Node 22 from .nvmrc
> npm install
> npm test           # runs the shared-package tests
> ```

The run commands below are **planned** and are added by the phase shown. They are listed so the target workflow is
clear; each one will be verified and moved above this line when its phase lands. See `implementation-plan.md` for the
details of each phase.

| What                        | Planned command                                  | Added in | Needs                 |
| --------------------------- | ------------------------------------------------ | -------- | --------------------- |
| API only (health endpoint)  | `npm run dev -w apps/api`                        | Phase 2  | Node 22               |
| PostgreSQL for local dev    | `docker compose up -d db`                        | Phase 6  | Docker (or Colima)    |
| API with search/analyze     | `npm run dev -w apps/api` (fixture data)         | Phase 8  | Postgres running      |
| Web UI                      | `npm run dev -w apps/web`                        | Phase 9  | API running           |
| Full stack (db + api + web) | `docker compose up --build`                      | Phase 10 | Docker                |
| Browser tests               | `npm run test:e2e`                               | Phase 10 | Full stack running    |
| Live Azure explanations     | set Azure env vars from `.env.example`, `LIVE_AZURE=1` | Phase 11 | Azure OpenAI resource |

Until Phase 12, all research data comes from bundled fixtures. No market-data or Azure credentials are needed to run
or test the app locally. Configuration will be documented in `.env.example` (placeholders only). Never commit a
real `.env`.

## Layout

| Path              | Purpose                                     | Status   |
| ----------------- | ------------------------------------------- | -------- |
| `packages/shared` | Domain vocabulary and (later) Zod contracts | Phase 1  |
| `apps/api`        | Express API, Prisma, decision engine        | Phase 2+ |
| `apps/web`        | Vite React frontend                         | Phase 9  |

## Commands

```sh
npm install            # install all workspaces
npm run format:check   # Prettier (markdown is excluded)
npm run lint           # ESLint with type-aware typescript-eslint rules
npm run typecheck      # tsc for root config files and every workspace
npm test               # Vitest across all workspace projects
npm run test:coverage  # tests with v8 coverage
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, and `test` on every push to `main` and on
pull requests.

## Notes

- TypeScript is pinned to 6.0.x because `typescript-eslint` 8.x does not yet support TypeScript 7.
- Dependencies are saved with exact versions (`.npmrc` `save-exact=true`).
- Relative imports use `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).
