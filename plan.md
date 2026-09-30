# Development Plan

## Current State

The repository is specification-only. `requirements.md` defines the intended architecture and workflow, while `README.md` contains no implementation guidance. There are currently no application files, package manifests, tests, Prisma schema, or deployment files.

## Key Analysis

The main implementation risk is treating the AI agent as the source of truth for financial decisions. The decision rules should be deterministic and auditable; the agent should orchestrate research and generate explanations, not silently override calculated signals.

The following gaps must be resolved during architecture:

- Exact market-data, filings, news, and F&O providers, including licensing and rate limits.
- Current Microsoft Agent Framework and Azure SDK package and API choices.
- MCP server contracts, authentication, timeouts, retries, and source provenance.
- Whether analysis is synchronous or job-based for long-running research.
- User authentication, authorization, audit logging, and secret management.
- Historical data periods, currencies, market hours, timezone handling, and stale-data policy.
- Schema fields for raw research, source citations, data timestamps, risk-to-reward, and provider errors.
- Scoring weights and how conflicting or unavailable indicators affect confidence.
- Disclaimer and compliance requirements for investment-related output.

## Phased Development Plan

### Phase 0: Architecture and Provider Validation

Define the contracts before scaffolding:

- Select and verify Node.js, React, Prisma, Azure AI, Microsoft Agent Framework, and MCP package versions.
- Document provider adapters and normalized data contracts.
- Define the deterministic scoring model and confidence calculation.
- Decide synchronous MVP versus queued analysis jobs.
- Extend the data model for provenance, timestamps, raw research snapshots, and failures.
- Define security, logging, rate-limit, and disclaimer requirements.

**Validation gate**

- An architecture decision record is approved.
- Each required data point maps to a provider or is explicitly marked unavailable.
- A sample normalized payload can be created without live credentials.
- A scoring table produces the same result repeatedly for the same inputs.
- Dependency installation and TypeScript compilation succeed in a minimal scaffold.

### Phase 1: Project Foundation

Create the monorepo or clearly separated frontend/backend structure:

- Backend TypeScript and Express application.
- Frontend Vite React TypeScript application.
- Shared Zod schemas and API contracts.
- Environment configuration with validation.
- Structured logging and centralized error handling.
- Docker Compose with PostgreSQL health checks.
- CI commands for linting, type checking, and tests.

**Validation gate**

- The backend health endpoint returns successfully.
- The frontend loads successfully.
- PostgreSQL starts and passes its health check.
- Invalid environment configuration fails fast.
- CI passes with no live external services.

### Phase 2: Persistence and Domain Model

Implement Prisma models and migrations for:

- Stocks and instruments.
- Analysis runs.
- Timeline events.
- Research sources and metric snapshots.
- Decision output and scoring breakdown.
- Provider failures and analysis status.

Add repository services for:

- Stock lookup and normalization.
- Existing-analysis retrieval.
- Analysis-run creation.
- Timeline append operations.
- Idempotent re-analysis handling.

**Validation gate**

- Migrations apply to a clean PostgreSQL instance.
- Repository tests cover create, retrieve, re-analysis, and transaction rollback.
- Duplicate tickers and invalid enum values are rejected.
- Timeline records remain linked to the correct analysis run.
- Database constraints prevent orphaned records.

### Phase 3: Query Normalization and Research Adapters

Implement:

- Symbol and company-name normalization.
- Exchange and asset-type resolution.
- MCP client lifecycle management.
- Provider-specific adapters for fundamentals, prices, technical indicators, derivatives, sentiment, and announcements.
- Timeouts, retries, cancellation, rate-limit handling, and source metadata.
- A normalized `ResearchSnapshot` contract.

Start with fake or recorded MCP responses before connecting live providers.

**Validation gate**

- Unit tests cover valid, ambiguous, unknown, and malformed queries.
- Recorded-provider tests verify normalized output.
- Timeout and provider-failure tests produce explicit partial-data states.
- No provider credentials are required for automated tests.
- Every returned metric has a source and observation timestamp.

### Phase 4: Deterministic Decision Engine

Implement the business rules independently of the agent:

- Fundamental, technical, derivatives, and sentiment subscores.
- BUY, DONT_BUY, and NEUTRAL classification.
- Confidence score bounded from 0 to 100.
- Risk-to-reward calculation with explicit assumptions.
- Missing-data behavior.
- Human-readable reasons and risk factors.
- Versioned scoring policy so historical runs remain reproducible.

**Validation gate**

- Table-driven tests cover every stated BUY and DONT_BUY rule.
- Boundary values such as exactly 15% pledging and 0.5 debt-to-equity are tested.
- Conflicting signals produce deterministic results.
- Missing or stale metrics reduce confidence rather than being treated as positive evidence.
- The same snapshot plus policy version always produces identical output.

### Phase 5: Agent Orchestration and Explanations

Add the Microsoft Agent/Azure integration around the deterministic engine:

- Orchestrate research collection.
- Pass only normalized, timestamped data to the model.
- Generate summary Markdown, key drivers, and risk factors.
- Require structured output validation with Zod.
- Preserve citations and source references.
- Prevent model output from changing the deterministic decision.
- Add prompt-injection and untrusted-source handling.

**Validation gate**

- Agent responses are rejected when they violate the output schema.
- Recorded model responses produce valid persisted analysis.
- Model failures leave the run in an explicit failed or partial state.
- Prompt-injection fixtures do not alter system rules or expose secrets.
- Generated explanations cite the underlying research data.

### Phase 6: API and Frontend Workflow

Implement the primary user journey:

- `POST /api/v1/stock/search`.
- Existing-analysis response with age and re-analysis choice.
- `POST /api/v1/stock/analyze`.
- Analysis status and result retrieval.
- Search bar with autocomplete.
- Existing-analysis modal.
- Decision badge.
- Metrics grid.
- Timeline view.
- Loading, empty, error, stale-data, partial-data, and retry states.

For long-running analyses, use a job/status model rather than holding an HTTP request open.

**Validation gate**

- API contract tests cover normalization, cache hits, fresh analysis, validation errors, and provider failures.
- Frontend tests cover the complete search-to-result state flow.
- Browser tests cover search, view existing, fresh re-analysis, loading, failure, and retry.
- Responsive layouts work at desktop and mobile widths.
- No UI displays a decision without its timestamp, confidence, and source context.

### Phase 7: Operational Hardening and Release

Add:

- Authentication and authorization.
- Request correlation IDs and audit logs.
- Secrets through environment configuration or managed identity.
- Rate limiting and abuse protection.
- Metrics, tracing, and alerting.
- Database backup and migration procedures.
- Production Docker configuration.
- Security and dependency scanning.
- Investment disclaimer and data-freshness indicators.

**Validation gate**

- Staging deployment succeeds from a clean environment.
- Secrets are absent from source, logs, and test fixtures.
- Load tests cover concurrent searches and duplicate re-analysis requests.
- Recovery is tested for database failure, provider outage, model timeout, and partial research.
- A release checklist confirms migrations, rollback, monitoring, and compliance text.

## Recommended MVP Order

1. Foundation and local PostgreSQL.
2. Persistence model.
3. Fake research adapter.
4. Deterministic scoring engine.
5. Search and analysis API.
6. Basic frontend result view.
7. One real provider.
8. Agent-generated explanation.
9. Additional providers and production hardening.

This order provides a testable product before external integrations and model behavior introduce uncertainty.
