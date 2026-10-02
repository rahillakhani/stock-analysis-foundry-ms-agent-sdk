# Decision Policy v2

Status: **Accepted** (2026-10-01). Implemented in `apps/api/src/domain/decision/` (`POLICY_V2`, `CHECKS_V2`). New
analyses use v2; v1 stays available so runs recorded under v1 can be reproduced exactly.

v2 uses **the same checks, thresholds, freshness limits, classification, and risk-to-reward as
[v1](decision-policy-v1.md)**. It differs in two ways, both needed once US listings (NASDAQ, NYSE) were supported.

## 1. Market-scoped checks

These checks describe Indian-market disclosures and flows and apply **only to NSE/BSE listings**:

| Code                  | Why it is India-specific                                      |
| --------------------- | ------------------------------------------------------------- |
| PLEDGE_BELOW_MAX      | Promoter pledging is an Indian (SEBI) shareholding disclosure |
| PLEDGE_NOT_EXCESSIVE  | Same                                                          |
| FII_NET_BUYING        | FII/DII flows are Indian-market institutional flow statistics |
| DII_NET_BUYING        | Same                                                          |
| DEALS_NOT_NET_SELLING | Bulk/block deals are NSE/BSE trade disclosures                |

For a NASDAQ/NYSE listing these checks are **excluded** (as if NOT_APPLICABLE). They don't count in completeness,
subscores, or the BUY gate. Under v1 the same data would read as unavailable, so a US stock could never be rated BUY.

For NSE/BSE listings nothing changes: missing pledging or flow data is still unavailable and still blocks BUY
(fail-closed). Derivatives remain governed by the v1 rule: NOT_APPLICABLE only when the whole section is (no F&O
contract).

**Scope is by listing exchange, not by company domicile.** An Indian company's US listing (an ADR such as NYSE:INFY,
NYSE:HDB, or NASDAQ:MMYT) is evaluated as a US listing, so the India-only checks are excluded for it. The same
company's NSE listing keeps them. This is deliberate for v2: the ADR's market and data are US ones. A future version
could scope by domicile once a reliable domicile field is available.

## 2. Sentiment subscore may be null

The sentiment subscore is `null` when no sentiment check applies. Under v2 that happens for US listings, because all
three scored sentiment checks are India-only. It is shown as "N/A" and excluded from the BUY confidence mean, exactly
like the derivatives subscore. Under v1 the subscore is never null.

## 3. Live research methodology (provider, not policy)

With `RESEARCH_PROVIDER=live`, research comes from Yahoo Finance. The checks above are applied to values computed as
follows. Yahoo's own ratio fields are not used, because their units are inconsistent (e.g. debt-to-equity as a
percentage).

**Fundamentals**

- **Trailing twelve months (TTM).** These come from the last four *consecutive* calendar quarters of income
  statements, plus the latest balance sheet.
  - ROE = TTM net income ÷ latest stockholders' equity × 100. This uses year-end equity, not the average.
  - D/E = latest total debt ÷ equity. Yahoo's total debt includes lease liabilities.
  - ROCE = TTM EBIT ÷ invested capital × 100. Invested capital is Yahoo's figure, approximately debt plus equity.
  - Net margin = TTM net income ÷ TTM revenue × 100.
  - Revenue growth YoY = latest quarter's revenue ÷ the same quarter a year earlier − 1.
- **Freshness.** Income ratios are dated to the latest quarter. Balance-sheet ratios (ROE, D/E, ROCE) are dated to
  the *older* of the latest quarter and the balance sheet. Indian companies publish balance sheets half-yearly, so
  their ROE and D/E can briefly read as stale between filings.
- **Fallback.** When four consecutive quarters aren't available, ratios come from the latest annual statement and are
  dated to its fiscal year end. Year-over-year growth then needs the directly preceding fiscal year.
- **Equity.** With zero or negative equity, ROE and D/E are not meaningful and are reported unavailable.
- **Operating margin trend.** Uses quarterly operating income ÷ revenue (newest row per calendar quarter).
- **P/E and P/S.**
  - P/E is Yahoo's trailing P/E; a negative P/E is dropped.
  - P/S is dropped when the trading and reporting currencies differ (e.g. ADRs).
  - Neither is used by any check.

**Technicals**

- **Bars.** Only completed sessions are used: today's bar, in the exchange's time zone, is excluded. The history
  window is about 3 years, so EMA200 has converged.
- **EMA, RSI(14), ATR(14).**
  - EMA is seeded with the simple moving average.
  - RSI(14) and ATR(14) use Wilder smoothing.
- **Volume ratio.** Latest session volume ÷ the prior 20-session average. Zero volume (indices) is unavailable.
- **RSI divergence (30-bar window).**
  - It compares the two most recent confirmed swing pivots, each the extreme of 3 bars on either side and at least
    5 bars apart.
  - **Bearish:** price makes a higher high, RSI makes a lower high by at least 8 points, and the first high was
    overbought (RSI ≥ 70). Bullish mirrors this on swing lows.
  - Measured false-positive rate on random walks without real divergence: about 0.4% with no drift and 1.9% with
    +0.2%/day drift.
- **Consolidation breakout (6 weeks = 30 sessions).** The latest close is above the high of the preceding 30 sessions,
  *and* those sessions traded within a 12% high-to-low band. A wide prior range is not a consolidation.

**Not available from this source.** Promoter holding and pledging, auditor opinion, F&O data, FII/DII flows, and
bulk/block deals are MISSING for Indian listings and NOT_APPLICABLE for US ones. As a result, **Indian stocks are at
most NEUTRAL** until a source for those disclosures is connected (the planned web-research step).

## 4. Buy guidance (presentation, not policy)

Completed runs are returned with `buyGuidance`, derived from the recorded decision when it is read
(`apps/api/src/domain/decision/guidance.ts`). It changes nothing the engine decides or stores.

- **Blockers:** the veto ("red flag") and buy-rule checks that failed or had no usable data. Every one must clear for
  the rules to say BUY. Roles come from the check definitions of the decision's own policy version.
- **Improvements:** scored-only checks that failed. They lower the subscores but never block BUY.
- **Data completeness:** usable applicable checks ÷ applicable checks, the factor in every confidence formula (§4 of
  v1). The UI uses it to explain the confidence figure. For example, DON'T BUY with one failed veto and 81.8%
  completeness gives 0.818 × 50 = 40.9%.

Confidence is never a probability of a price rise; the UI says so next to the figure.
