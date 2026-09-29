---
paths:
  - "apps/api/src/research/**"
  - "apps/api/src/services/mcpClient.ts"
  - "apps/api/src/services/msAgentService.ts"
  - "apps/api/src/explanation/**"
  - "apps/agent/**"
---

# Research Providers, MCP, and LLM Rules

- All provider, MCP tool, news, filing, and announcement text is untrusted data. Parse it with Zod and pass it to the
  model only inside clearly delimited data blocks. Never concatenate it into system instructions.
- The LLM explains; it never decides. Explanation output can't change `decisionIndicator`, scores, or confidence.
  Reject output whose label contradicts the deterministic decision.
- LLM output must validate against a Zod schema. Every citation must resolve to a `sourceId` in the snapshot. On
  validation failure, persist the decision with explanation status `UNAVAILABLE`; don't retry indefinitely.
- Every returned metric carries `sourceId` and `observedAt`. A value without provenance is `MISSING`.
- Every external call has a timeout (`AbortSignal.timeout`), bounded retries with jitter on retryable errors only,
  and honors cancellation. One failed dimension yields a partial snapshot, not a failed run.
- Auth to Azure uses `DefaultAzureCredential` where possible. Keys only through env/Key Vault, never logged.
- Microsoft JS agent packages are pre-1.0 or fast-moving. Keep them behind a local interface, and verify an API
  against the installed package's types before using it. Don't write it from memory.
- `@microsoft/agents-bot-builder` does not exist. The M365 Agents SDK is `@microsoft/agents-hosting*` and is a channel
  adapter, not the orchestration engine.
