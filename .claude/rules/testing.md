---
paths:
  - "**/*.test.{ts,tsx}"
  - "**/*.spec.{ts,tsx}"
  - "**/tests/**"
  - "**/__fixtures__/**"
  - "e2e/**"
  - "**/vitest.config.*"
  - "**/playwright.config.*"
---

# Testing Conventions

- Runner: Vitest for unit/integration, Supertest for HTTP, React Testing Library + MSW for UI, Playwright for E2E.
- Co-locate unit tests as `*.test.ts` next to the source. Integration tests that need Postgres are named
  `*.int.test.ts` and run only via `npm run test:int`.
- No network in `npm test`. Providers, MCP servers, and Azure models are replaced by fixtures or in-memory fakes.
  Live tests are gated by an env flag (`LIVE_AZURE=1`, `LIVE_PROVIDER=1`) and skipped by default.
- Decision-engine and normalization tests are table-driven (`it.each`), with explicit boundary rows
  (exactly 15% pledging, D/E exactly 0.5, ROE exactly 15%).
- Freeze time with an injected clock, not global fake timers, unless testing timer behavior itself.
- Fixtures are synthetic or recorded-and-redacted. Never real credentials, tenant data, or personal data. Keep
  recorded fixtures under `__fixtures__/` with a comment naming the source and capture date.
- Assert observable behavior (returned values, HTTP bodies, rendered text), not private calls.
- One assertion lives at the lowest layer that proves it. Don't duplicate unit assertions in API or E2E tests.
- Every bug fix lands with a test that failed before the fix.
