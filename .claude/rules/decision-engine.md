---
paths:
  - "apps/api/src/domain/**"
  - "docs/decision-policy-*.md"
---

# Decision Engine Invariants

The decision engine is the auditable source of truth for BUY / DONT_BUY / NEUTRAL. Treat these as hard constraints.

- Pure functions only: `evaluate(snapshot, policy, now) -> DecisionResult`. No I/O, no LLM calls, no logging side
  effects, no `Date.now()`.
- Same snapshot + same `policyVersion` must produce byte-identical output. Never change the behavior of an existing
  policy version. Add a new version (`v2`) and keep `v1` for reproducing historical runs.
- Veto (DONT_BUY) rules are evaluated before BUY rules. Anything that is neither falls to NEUTRAL.
- Metrics with status `MISSING` or `ERROR` never count as a pass. They lower confidence. Staleness is not a
  metric status: the engine derives it from `observedAt` vs the snapshot `asOf` using the policy's max age, and a
  stale value never counts as a pass either. `NOT_APPLICABLE` (e.g. derivatives for a stock with no F&O contract)
  is excluded from both pass and fail.
- Classifications that depend on policy (OI build-up type, contango/backwardation) are computed here from raw
  snapshot values, never read from the snapshot.
- Confidence is clamped to [0, 100]. R:R output carries its assumptions (stop and target method).
- Every reason and risk factor references the `sourceId`s of the metrics that produced it.
- Thresholds live in the policy object, not inline literals. Changing one requires updating
  `docs/decision-policy-v*.md` and adding a boundary test row.
- Use the `/decision-rule` skill for any rule change.
