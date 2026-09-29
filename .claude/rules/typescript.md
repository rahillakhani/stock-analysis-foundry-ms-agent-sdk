---
paths:
  - "**/*.{ts,tsx,mts,cts}"
---

# TypeScript Conventions

- Strict mode everywhere. No `any`; use `unknown` and narrow. No non-null `!` assertions outside tests.
- ESM only (`"type": "module"`). Use `import type` for type-only imports.
- Validate every external boundary with Zod: HTTP input, env, DB `Json` columns, MCP tool output, LLM output. Derive
  types with `z.infer`; don't hand-write a duplicate interface.
- Shared contracts live in `packages/shared`. Apps import them and never redefine DTOs locally.
- Prefer discriminated unions for states (e.g. `{ status: 'RESOLVED' } | { status: 'AMBIGUOUS', candidates }`) over
  optional-field bags.
- Inject time, randomness, and I/O (`now: () => Date`, providers, repositories). Don't call `Date.now()` or
  `Math.random()` in domain code.
- Named exports only. One module has one responsibility; no barrel file re-exporting a whole app.
- Throw typed errors (`class NotFoundError extends AppError`) and map them to HTTP in one place.
- Money, prices, and ratios are `number` with explicit units in the name (`pePct`, `priceInr`) until a decimal type
  is justified by evidence.
