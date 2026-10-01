# Decision Policy v2

Status: **Accepted** (2026-10-01). Implemented in `apps/api/src/domain/decision/` (`POLICY_V2`, `CHECKS_V2`). New
analyses use v2; v1 stays available so runs recorded under v1 can be reproduced exactly.

v2 is **identical to [v1](decision-policy-v1.md)** (same checks, thresholds, freshness limits, classification,
scores, and risk-to-reward) with one change, needed once US listings (NASDAQ, NYSE) were supported:

## Market-scoped checks

These checks describe Indian-market disclosures and flows and apply **only to NSE/BSE instruments**:

| Code                  | Why it is India-specific                                        |
| --------------------- | --------------------------------------------------------------- |
| PLEDGE_BELOW_MAX      | Promoter pledging is an Indian (SEBI) shareholding disclosure   |
| PLEDGE_NOT_EXCESSIVE  | Same                                                            |
| FII_NET_BUYING        | FII/DII flows are Indian-market institutional flow statistics   |
| DII_NET_BUYING        | Same                                                            |
| DEALS_NOT_NET_SELLING | Bulk/block deals are NSE/BSE trade disclosures                  |

For a NASDAQ/NYSE instrument these checks are **excluded** (as if NOT_APPLICABLE). They don't count in completeness,
subscores, or the BUY gate. Under v1 the same data would read as unavailable, so a US stock could never be rated BUY.

For NSE/BSE instruments nothing changes: missing pledging or flow data is still unavailable and still blocks BUY
(fail-closed). Derivatives remain governed by the v1 rule: NOT_APPLICABLE only when the whole section is
(no F&O contract).

## Consequences of the live data source (not policy changes)

With the Yahoo Finance research provider, Indian F&O open interest, promoter pledging, and FII/DII flows are not
available, so **Indian stocks are at most NEUTRAL** until a source for those disclosures is connected (planned
web-research step). US stocks can reach BUY.
