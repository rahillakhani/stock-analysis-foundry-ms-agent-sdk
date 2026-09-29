---
paths:
  - "apps/api/src/**"
---

# API Conventions

- `createApp(deps)` builds the Express app with injected dependencies. `server.ts` only reads config and listens.
  Tests use `createApp` with fakes.
- Routes are thin: validate input with the shared Zod schema, call a service, and map the result. No business logic
  or Prisma calls in route handlers.
- Errors go through the central error handler as `application/problem+json` (`type`, `title`, `status`, `detail`,
  `instance`). Never return stack traces or raw provider/DB errors to clients.
- Long work (analysis) returns `202 { runId }`. Clients poll `GET /api/v1/analysis-runs/:id`. Duplicate in-flight
  analysis returns `409` with the existing `runId`.
- Log with the request-scoped pino logger (includes `requestId`). Never log env values, tokens, full provider
  payloads, or LLM prompts containing untrusted text at info level.
- Config comes only from the validated `config/env.ts` object. No `process.env` reads elsewhere.
- Every response that contains a decision also includes `analysedAt`, `confidenceScore`, `policyVersion`, and sources.
