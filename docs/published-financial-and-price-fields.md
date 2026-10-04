# Published financial and price fields

The daily and weekly publication workflows use the same main pipeline. This change implements the published-field, dividend-ledger, VWAP, and history-coverage changes described below. A new financial-statement XBRL parser for tax components and borrowings is deliberately excluded.

## Sources and calculations

| Published field | Input and definition | Period/unit |
| --- | --- | --- |
| Total revenue | ScanX consolidated `incomeStat_cq.REVENUE` | Latest coherent quarter; ₹ lakh |
| Non-current assets | `bs_c.TOTAL_ASSETS - CURRENT_ASSETS`; unavailable without both values | Latest annual consolidated balance sheet; ₹ lakh |
| Total liabilities | `bs_c.CURRENT_LIABILITIES + NON_CURRENT_LIABILITIES` | Latest annual consolidated balance sheet; ₹ lakh |
| Interest coverage | `(incomeStat_cy.PROFIT_BEFORE_TAX + INTEREST) / INTEREST` | Latest annual consolidated statement; ratio; requires positive interest |
| Debt / equity | Explicit `bs_c.TOTAL_BORROWINGS / TOTAL_EQUITY` | Same annual balance-sheet observation; positive equity required |
| DPS | Explicit rupee amount per share in the latest NSE dividend declaration whose ex-date is no later than the publication session | ₹ per share on that ex-date, not annual or TTM DPS |
| VWAP | NSE full bhavcopy `AVG_PRICE`; when it is blank or zero, `TURNOVER_LACS × 100,000 / TTL_TRD_QNTY` | Session-specific ₹; fallback inherits exchange turnover rounding |
| Five-year return | `(latest close / close 1,260 sessions ago - 1) × 100` | Requires 1,261 aligned closes; fixed trading-session window |
| All-time high/low | Maximum adjusted high / minimum adjusted low, published only for listing-covered history | ₹; see coverage policy below |

ScanX's financial statement display uses **₹ crore** ([provider page](https://scanx.trade/company/)). All scanner fields advertised as “in lakhs” now explicitly multiply statement amounts by 100. EPS and percentage fields are not scaled. Total tax expense uses `TAX_PAYMENT_ABSOLUTE`; `TAX` is a percentage and must not be published as an amount. Revenue is explicitly mapped to `REVENUE`, distinct from the existing `SALES` growth series.

`financial_metadata` identifies source, consolidated basis, amount unit, quarter, balance-sheet year, interest-coverage year and derived formulas. These are latest published observations, not a new historical filing backfill. No standalone fallback is introduced.

The current ScanX response has no dedicated borrowings value. **D/E therefore becomes unavailable**, replacing the incorrect non-current-liabilities proxy. A future explicit `TOTAL_BORROWINGS` observation can activate the formula without substituting another liability measure. Current tax, deferred tax, long/short-term borrowing ingestion and a new XBRL parser remain outside this change.

## Dividend ledger

`build_corporate_action_ledger.py` adds numeric `dividend_per_share` and parse status while retaining ex-date, record date, source text and ISIN in the existing compressed ledger. Only an explicit rupee-per-share declaration is accepted. Percentage-only declarations and multiple explicit amounts remain null. Duplicate identical events are removed; multiple distinct declarations on the latest ex-date are unavailable in the stock's latest-DPS field.

The stock publishes `dividend_per_share_latest`, `dividend_ex_date`, `dividend_basis` and the source's fetch range. An unparseable latest declaration stays unavailable, rather than using an older known dividend. Future ex-dates are excluded. The event ledger also reaches per-symbol chart payloads through the existing corporate-action connection.

This is **not** an annual dividend payout or cover calculation: those require dividends and earnings attributed to the same financial year and consistent share adjustments. No partial trailing sum is presented as annual DPS.

## History recovery and completeness

Both publication workflows restore the EOD2 checkout cache, update it from its public repository, and set `EDL_EOD2_DATA_DIR`. A missing Actions cache triggers a fresh shallow clone of the **data repository**, whose files still contain their available full history; shallow Git history does not shorten CSV rows. The existing ISIN-verified importer handles renamed symbols, overlays adjusted historical rows, and preserves newer local sessions.

The importer now records each imported symbol's ISIN, start/end dates and session count. The enrichment stage records the actual available range and publishes separate `available_history_high/low` values for incomplete histories. “Listing covered” requires an ISIN-verified EOD2 source and local history starting within seven calendar days of the official listing, plus alignment to the publication session. This is an explicit coverage heuristic, not certification that every exchange session exists. Pre-EOD2 listings, missing mappings and unknown listing dates can remain incomplete. Absolute ATH/ATL and the existing ATH-distance filter stay unavailable for those stocks. Five-year returns do not require inception coverage, but do require the full lookback.

Raw private R2 history backup/recovery remains a separate planned capability. This change recovers missing runner history from the existing EOD2 source; it does not claim an R2 backup is present. Chart generation/publication continues to use the restored histories and the existing R2 publication path.

## Main pipeline and runtime connection

1. ScanX transform maps financial values and correct units into the master stock records.
2. Official NSE bhavcopy preserves VWAP even when delivery data is unavailable.
3. The existing corporate-action stage builds the enriched dividend ledger.
4. `enrich_published_fields.py`, immediately before standardization, joins VWAP, latest dividend declaration and verified history coverage into the stock artifact.
5. Standardization preserves these fields in `all_stocks_fundamental_analysis.json.gz`.
6. Dated scanner snapshots retain numeric fields and provenance metadata.
7. Text query aliases compile to the existing field comparison evaluator; parenthesized field labels are recognized before function syntax.
8. The shared frontend stock adapter and immutable snapshot publish the numeric values. The existing Fundamental Metric selector exposes the additions, with units/periods in labels. Both Python evaluation and browser filtering reject missing values; VWAP also requires its own session date to match.
9. Chart generation runs before cleanup and receives the extended corporate-action ledger. Publication uses the existing transactional promotion and R2 failure handling.

Example queries:

```text
Total revenue (in lakhs) > 10000 AND Interest coverage > 3
Non-current assets (in lakhs) > 50000 AND Total liabilities (in lakhs) < 100000
Close Price > VWAP AND Dividend per share (DPS) > 2
Return Over % 5 Years > 30
Close Price >= All time high
```

Null data is not zero and does not satisfy a filter, including negated conditions. Old immutable revisions are not rewritten; these fields become available after a successful fresh publication.
