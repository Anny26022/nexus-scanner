# US market: Phase 0 findings

Phase 0 checks that Dhan can feed a US screener with the same filters as India, and lays the seams for it:
`edl_pipeline.markets` (one spec per market), `markets.us.calendar` (NYSE), `markets.us.dhan` (sources) and
`markets.us.fields` (mapping onto the canonical record). Nothing is published yet. `tools/us_market_spike.py`
re-runs the live checks below (read-only, paced).

## What Dhan serves

| Data | Endpoint | Notes |
| --- | --- | --- |
| Universe and daily snapshot | `scanx-global-analytics.dhan.co/customscan/fetchdt` | The Indian screener's request shape, with `Exch=INX` and `OgInst=ES` (stocks) or `ETF`. One page of 10,000 returns everything; `pgno` starts at 1. |
| Listing exchange | `Cust_Exch` (screener field) | NASDAQ 3,734 · NYSE 2,626 · CBOE 34 · NYSE Arca 29 · `NA` 5 (stocks). ETFs: NYSE Arca 2,491 · CBOE 1,473 · NASDAQ 1,174 · NYSE 75. No OTC. NYSE American is absent. |
| Daily OHLCV | `openweb-ticks-inx.dhan.co/getDataH` | Wants the **listing exchange** in `EXCH` (not `INX`) and an integer `SEC_ID`. Split-adjusted (NVIDIA is continuous across its June 2024 10:1 split). From 2021-03-24. Bars are stamped at midnight IST of the US session date. |
| Statements, ratios, ratings | `dhan.co/_next/data/<build>/us-stocks/<Seosym>-share-price.json` | About 16 KB a stock: 10 years of annual and 10 quarters of income, balance sheet and cash flow, PE/PEG/P/B, dividend yield, sector/industry/sub-sector, analyst buy/hold/sell, corporate actions, USD/INR. The build id changes with each dhan.co deploy. |

Measured on 2026-11-09: 6,436 stocks (6,428 usable records) and 5,216 ETFs. Market cap is sent in millions of USD;
volume and shares are plain counts. Of the 65 fields the Indian pipeline requests, 39 are filled for US stocks; the
rest are technicals (computed from OHLCV here, as in India), fundamentals the stock pages carry, or Indian concepts.
Stock fill rates: PE 52% (loss-makers have none), ROE/ROCE/margin 88%, EPS 82%.

## Calendar

NYSE holidays are computed from Rule 7.2 rather than copied by hand: Saturday holidays move to Friday (except New
Year's Day), Sunday holidays to Monday, Juneteenth from 2022, Good Friday from Easter. Early closes (1 PM ET) are the
day after Thanksgiving and July 3 / December 24 when they fall Monday to Thursday. One-off closures go in
`SPECIAL_CLOSURES` (2025-01-09). Checked against NYSE's 2024–2027 calendars, and against Dhan's history: liquid
stocks have no bar on a closed day and no open day without a bar over 5.6 years.

`last_closed_session()` names the session a snapshot belongs to in Eastern time, so a run at 6:00 AM IST labels the
previous New York day in both EST and EDT. A snapshot taken during the session (13:00–02:30 IST) is still trading
and must not be stored as a closed bar, as India's `is_nse_cash_session` already guards.

## Quirks Phase 1 must handle

- **Universe hygiene.** The stock list includes SPAC units (`…U`) and other thin instruments: they skip untraded days
  and some carry bars on weekends (CHECU on 2026-10-24/25). Filter units, rights and warrants out of the screener
  universe, drop bars on non-session days, and set a liquidity floor.
- **`NA` exchange.** Five stocks have no listing exchange, so their history cannot be requested; leave them out.
- **Fiscal years differ** (NVIDIA ends in January, Microsoft in June): key statements by fiscal period end.
- **History depth** is 2021 onwards: 52-week, 200-day, RS and 1–5 year returns work; all-time highs and 10-year
  returns need another source.
- **Snapshot timing**: run after the close and refuse in-session snapshots.

## Reusing the Indian core

| Coupling | Modules |
| --- | --- |
| None (reuse as is) | `scanner/indicators`, `earnings`, `presets`, `reference`, `calculation_cache`; `breadth/aggregates`, `gates`, `indicators`, `indices`, `mbi`; `transforms/market_breadth`; `bulk_market_analyzer`, `process_earnings_performance`, `process_market_breadth` |
| Light (a constant or wording) | `scanner/patterns` (weekly fold is generic), `scanner/trend` (one delivery condition), `breadth/universe` (default `Exch`), `build_rs_ratings` (benchmark file name) |
| Heavy (units, calendar or NSE lists) | `scanner/context`, `scanner/query`, `scanner/financials` (₹ crore and lakh fields), `transforms/fundamentals` (NSE equity list), `ohlcv_utils` (NSE calendar), `screen_trend_conditions` (NIFTY keys) |

## Phase 1 shape

- Daily (Tue–Sat 00:30 UTC): one screener call → canonical records → append the session's bar to each stock's
  history (cheap, like the mutual fund job); weekly full history refetch to stay consistent with split adjustment.
- Feed US OHLCV through the reusable modules with the market's calendar and benchmark (SPY) passed in.
- Amounts stay currency-neutral (`market_cap`, `dollar_volume`, with `currency`); the frontend formats by market and
  each condition declares the markets it supports.
- Publish under `/data/us/` mirroring India's layout; India keeps `/data/`.
