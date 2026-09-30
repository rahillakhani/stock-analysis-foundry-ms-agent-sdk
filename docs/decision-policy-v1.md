# Decision Policy v1

Status: **Accepted for MVP** (2026-09-30). Implemented in `apps/api/src/domain/decision/`. This version is immutable:
any behavior change ships as `v2`, and `v1` stays available so historical runs can be reproduced.

Source rules: `requirements.md` §2 Step 3. This document resolves the gaps listed in `implementation-plan.md` §1.2
(items 4–8). The thresholds are heuristics for a research tool, **not investment advice**.

## 1. Data availability

A metric is **usable** only if its status is `OK` *and* it is fresh: `snapshot.asOf − observedAt ≤ max age`.

| Section      | Max age | Why                                             |
| ------------ | ------- | ----------------------------------------------- |
| fundamentals | 200 d   | quarterly results plus reporting lag            |
| technicals   | 4 d     | daily prices; covers a long weekend             |
| derivatives  | 4 d     | daily F&O data                                  |
| sentiment    | 10 d    | flows and deals over rolling windows            |

Anything else (MISSING, ERROR, stale OK) is **unavailable**. Unavailable data never counts as a pass, never fires a
veto, and lowers confidence. `NOT_APPLICABLE` (no F&O contract) is excluded from everything. Age is measured
against `snapshot.asOf`, not the wall clock, so re-running a stored snapshot gives the same result.

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
| NO_BEARISH_DIVERGENCE    | technicals   | RSI divergence is not BEARISH                                     | V S   |
| VOLUME_SURGE             | technicals   | Volume > 1.5× the 20-day average                                  | S     |
| CONSOLIDATION_BREAKOUT   | technicals   | Latest close broke above the consolidation range                  | S     |
| LONG_BUILD_UP            | derivatives  | Futures price change > 0 **and** OI change > 0                    | B S   |
| NO_SHORT_BUILD_UP        | derivatives  | Not (price change < 0 **and** OI change > 0)                      | V     |
| NOT_IN_FNO_BAN           | derivatives  | Not in the F&O ban list                                           | V S   |
| BASIS_NON_NEGATIVE       | derivatives  | Basis ≥ 0% (contango or flat)                                     | S     |
| FII_NET_BUYING           | sentiment    | FII net flow > 0                                                  | S     |
| DII_NET_BUYING           | sentiment    | DII net flow > 0                                                  | S     |
| DEALS_NOT_NET_SELLING    | sentiment    | Bulk/block buy quantity ≥ sell quantity (no deals counts as pass) | S     |

A check whose inputs are NOT_APPLICABLE is excluded. Derivatives checks therefore don't apply to a stock with no
F&O contract, so such a stock can reach BUY on its other checks (implementation-plan finding 4).

**Operating margin trend** needs at least 3 quarters. With fewer, the check is unavailable.

**OI build-up** is classified here from raw changes: price↑ OI↑ is long build-up, price↓ OI↑ short build-up,
price↑ OI↓ short covering, price↓ OI↓ long unwinding. A zero change on either side is unclassified.

## 3. Classification

1. **DON'T BUY** if any veto check is usable and fails.
2. **BUY** if every applicable B check is usable and passes, *and* every applicable V check is usable and passes.
3. **NEUTRAL** otherwise.

Boundaries: pledging at exactly 15% passes PLEDGE_NOT_EXCESSIVE but fails PLEDGE_BELOW_MAX, so the result is
NEUTRAL. D/E of exactly 0.5 and ROE of exactly 15% fail their B checks.

## 4. Scores

- **Subscore** per section = 100 × (passing S checks) / (applicable S checks). Unavailable checks count as not
  passing. The derivatives subscore is `null` when no derivatives check applies.
- **Completeness** = (usable applicable checks) / (applicable checks), over all distinct checks.
- **Confidence**, clamped to 0–100 and rounded to 1 decimal:
  - BUY: completeness × mean of the non-null subscores.
  - DON'T BUY: completeness × min(100, 50 + 25 × number of failed vetoes).
  - NEUTRAL: completeness × 50.

## 5. Risk-to-reward

Always a hypothetical long entry, estimated when last price and ATR14 are usable and ATR14 > 0:
- entry = last price
- stop = entry − 2 × ATR14; if EMA50 is usable and sits between that stop and the entry, stop = EMA50 − 0.25 × ATR14
  (support-based), but never lower than entry − 2 × ATR14
- target = entry + 4 × ATR14
- prices rounded to 2 decimals; ratio = (target − entry) / (entry − stop), rounded to 2 decimals (always ≥ 2,
  because the stop is at most 2 × ATR14 below entry and the target is 4 × ATR14 above)

The estimate is `null` if inputs are unavailable or the stop would be ≤ 0.

## 6. Output

- `reasons`: passing checks.
- `riskFactors`: failing checks, then unavailable checks.

Both appear in the check order of §2. Each factor cites the source ids of its inputs. `evaluatedAt` is the
injected clock's time, and `policyVersion` is `v1`.
