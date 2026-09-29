---
name: decision-rule
description: Add or change a BUY / DONT_BUY / NEUTRAL scoring rule, threshold, weight, or confidence formula in the deterministic decision engine. Use for any change to trading-signal logic.
argument-hint: "[rule change description]"
paths:
  - "apps/api/src/domain/decision/**"
  - "docs/decision-policy-*.md"
---

# Decision Rule Change

Requested change: $ARGUMENTS

Follow `.claude/rules/decision-engine.md`. Procedure:

1. **Classify.** Would this change the output of any existing input under the current `policyVersion`? If yes, it
   needs a **new policy version**. Never mutate an existing version's behavior, because historical runs must stay
   reproducible.
2. **Specify first.** Update `docs/decision-policy-v<N>.md`: criterion, metric(s), threshold, comparison operator
   (`<` vs `<=` stated explicitly), lookback window, what happens on MISSING / STALE / NOT_APPLICABLE, veto or
   supporting, and weight.
3. **Tests first.** Add table rows (`it.each`) covering below, **exactly at**, and above each threshold. Also add
   missing data, stale data, and a conflicting-signal case. Confirm the new rows fail before implementing.
4. **Implement** in the policy object and evaluator. Thresholds come from the policy, not literals.
5. **Determinism check.** Run the determinism test (same input produces identical output) and the full decision
   suite with coverage. Branch coverage on `domain/decision` must stay at 100%.
6. **Report.** Summarize the behavioral diff, with example inputs whose decision changed, the version bumped (if
   any), and the test command and its result.
