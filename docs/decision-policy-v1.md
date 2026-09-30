# Decision Policy v1

Status: **Accepted for MVP** (2026-09-30). Implemented in `apps/api/src/domain/decision/`. Once the first analysis
run is stored, this version is immutable: any behavior change ships as `v2`, and `v1` stays available so historical
runs can be reproduced.

Source rules: `requirements.md` §2 Step 3. This document resolves the gaps listed in `implementation-plan.md` §1.2
(items 4–8). The thresholds are heuristics for a research tool, **not investment advice**.

Pre-release changelog (before any run was persisted):
- 2026-09-30: fail-closed `NOT_APPLICABLE` handling (§1).
- Thresholds moved into the policy.
- Lookback windows for divergence and breakouts, and the quarter recency rule.
- Confidence computed from unrounded subscores.

## 1. Data availability

A metric is **usable** only if its status is `OK` *and* it is fresh: `snapshot.asOf − observedAt ≤ max age`.

| Section      | Max age | Why                                             |
| ------------ | ------- | ----------------------------------------------- |
| fundamentals | 200 d   | quarterly results plus reporting lag            |
| technicals   | 4 d     | daily prices; covers a long weekend             |
| derivatives  | 4 d     | daily F&O data                                  |
| sentiment    | 10 d    | flows and deals over rolling windows            |

Anything else (MISSING, ERROR, stale OK) is **unavailable**. Unavailable data never counts as a pass, never fires a
veto, and lowers confidence. Age is measured against `snapshot.asOf`, not the wall clock, so re-running a stored
snapshot gives the same result.

**`NOT_APPLICABLE` is fail-closed.** It is honoured only when *every* derivatives metric is `NOT_APPLICABLE`. That
means the instrument has no F&O contract, and the derivatives checks are excluded. In every other case (a single
derivatives field, or any fundamentals/technicals/sentiment field) `NOT_APPLICABLE` is treated as unavailable. A
provider therefore can't drop a BUY criterion or a veto by marking one input not applicable.

Consequence: indices have no ROE, D/E or pledging, so **v1 can't rate an index or index future BUY** (at best
NEUTRAL). Index-specific rules would be a v2 change.

The engine validates the snapshot against the shared schema on entry. An invalid snapshot, or an invalid clock,
throws instead of producing a decision.

## 2. Checks

Each check states the *good* condition. Roles:
- **B**: required for BUY.
- **V**: veto. A usable value that fails this check forces DON'T BUY; BUY also requires it to be usable and passing.
- **S**: counted in the section subscore.

| Code                     | Section      | Good condition                                                    | Roles |
| ------------------------ | ------------ | ----------------------------------------------------------------- | ----- |
| ROE_ABOVE_MIN            | fundamentals | ROE > 15%                                                         | B S   |
| DEBT_EQUITY_BELOW_MAX    | fundamentals | Debt/Equity < 0.5                                                 | B S   |
| PLEDGE_BELOW_MAX         | fundamentals | Promoter pledging < 15%                                           | B S   |
| PLEDGE_NOT_EXCESSIVE     | fundamentals | Promoter pledging ≤ 15% (fails only when > 15%)                   | V     |
| OPERATING_MARGIN_STABLE  | fundamentals | Not shrinking: last 3 quarters are not strictly decreasing        | V S   |
| REVENUE_GROWING          | fundamentals | Revenue growth YoY > 0%                                           | S     |
| NET_MARGIN_POSITIVE      | fundamentals | Net margin > 0%                                                   | S     |
| AUDITOR_UNQUALIFIED      | fundamentals | Auditor opinion is UNQUALIFIED                                    | S     |
| PRICE_ABOVE_EMA50        | technicals   | Last price > EMA50                                                | B S   |
| PRICE_ABOVE_EMA200       | technicals   | Last price > EMA200                                               | S     |
| EMA20_ABOVE_EMA50        | technicals   | EMA20 > EMA50                                                     | S     |
| RSI_IN_HEALTHY_RANGE     | technicals   | 40 ≤ RSI14 ≤ 70                                                   | S     |
| NO_BEARISH_DIVERGENCE    | technicals   | RSI divergence is not BEARISH (lookback 10–30 bars)               | V S   |
| VOLUME_SURGE             | technicals   | Volume > 1.5× the 20-day average                                  | S     |
| CONSOLIDATION_BREAKOUT   | technicals   | Close broke above the consolidation range (range 4–26 weeks)      | S     |
| LONG_BUILD_UP            | derivatives  | Futures price change > 0 **and** OI change > 0                    | B S   |
| NO_SHORT_BUILD_UP        | derivatives  | Not (price change < 0 **and** OI change > 0)                      | V     |
| NOT_IN_FNO_BAN           | derivatives  | Not in the F&O ban list                                           | V S   |
| BASIS_NON_NEGATIVE       | derivatives  | Basis ≥ 0% (contango or flat)                                     | S     |
| FII_NET_BUYING           | sentiment    | FII net flow > 0                                                  | S     |
| DII_NET_BUYING           | sentiment    | DII net flow > 0                                                  | S     |
| DEALS_NOT_NET_SELLING    | sentiment    | Bulk/block buy quantity ≥ sell quantity (no deals counts as pass) | S     |

Every numeric threshold above lives in the policy object (`POLICY_V1.thresholds`). The check set is selected by
policy version, so a policy can never be evaluated with another version's checks.

**Lookback windows.** A provider-reported RSI divergence or breakout is used only if its window falls within the
ranges above. Otherwise the check is unavailable, because the signal wouldn't mean what this policy intends.

**Operating margin trend.**
- Periods are calendar quarters (`YYYY-Qn`).
- The check needs the latest 3 reported quarters, and they must be consecutive.
- The newest of them must have ended no more than 200 days before `asOf`.
- Otherwise the check is unavailable. Re-fetched old quarters can't pass as current.

**OI build-up** is classified here from raw changes:

| Price change | OI change | Classification |
| ------------ | --------- | -------------- |
| up           | up        | long build-up  |
| down         | up        | short build-up |
| up           | down      | short covering |
| down         | down      | long unwinding |

A zero change on either side is unclassified.

A metric can feed several checks: pledging feeds two, and price/OI changes feed two. Each check counts once in
completeness and produces its own factor.

## 3. Classification

1. **DON'T BUY** if any veto check is usable and fails.
2. **BUY** if at least one B check applies, every applicable B check is usable and passes, *and* every applicable V
   check is usable and passes.
3. **NEUTRAL** otherwise.

Boundaries: pledging at exactly 15% passes PLEDGE_NOT_EXCESSIVE but fails PLEDGE_BELOW_MAX, so the result is
NEUTRAL. D/E of exactly 0.5 and ROE of exactly 15% fail their B checks.

## 4. Scores

- **Subscore** per section = 100 × (passing S checks) / (applicable S checks). Unavailable checks count as not
  passing.
  - The derivatives subscore is `null` when no derivatives check applies.
  - A section with no applicable scored check reports 0 and is excluded from the confidence mean.
- **Completeness** = (usable applicable checks) / (applicable checks), over all checks.
- **Confidence** is computed from **unrounded** subscores, then clamped to 0–100 and rounded to 1 decimal. Reported
  subscores are rounded to 1 decimal.
  - BUY: completeness × mean of the subscores that have applicable checks.
  - DON'T BUY: completeness × min(100, 50 + 25 × number of failed vetoes).
  - NEUTRAL: completeness × 50.

## 5. Risk-to-reward

Always a hypothetical long entry, estimated when last price and ATR14 are usable and ATR14 > 0:
- entry = last price
- stop = entry − 2 × ATR14; if EMA50 is usable and sits between that stop and the entry, stop = EMA50 − 0.25 × ATR14
  (support-based), but never lower than entry − 2 × ATR14
- target = entry + 4 × ATR14
- prices rounded to 2 decimals; ratio = (target − entry) / (entry − stop), rounded to 2 decimals

The unrounded ratio is ≥ 2, but rounding the prices can lower it when ATR14 is tiny relative to the 0.01 tick. The
estimate is `null` if inputs are unavailable, or if after rounding the stop is ≤ 0 or not below the entry.

## 6. Output

- `reasons`: passing checks.
- `riskFactors`: failing checks, then unavailable checks.

Both appear in the check order of §2. Each factor cites the source ids of its inputs. Messages never show a
non-zero value as `0`: values that round to zero are shown as `<0.01` or `>-0.01`. `evaluatedAt` is the injected
clock's time, and `policyVersion` is `v1`.
