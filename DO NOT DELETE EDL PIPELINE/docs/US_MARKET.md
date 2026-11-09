# US market

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

## Phase 1: the daily release

```
python -m edl_pipeline.markets.us <root>      # build the US root (PYTHONPATH=src:. from this folder)
EDL_US_BASE_DIR=<root> python frontend/publish_us.py
```

`.github/workflows/us_daily_refresh.yml` runs both at 00:30 UTC Tuesday to Saturday.

**The US root** (`markets/us/build.py`) holds the files India's root holds, so India's stages run on it unchanged:

| Stage | How |
| --- | --- |
| Universe | One screener call. `markets/us/universe.py` keeps common stock and partnership units; preferred, notes, rights, warrants and SPAC units are classified and left out. |
| Snapshot check | Refused while New York is trading, and when the latest trade is not from the last closed session (exit 75, so the job retries later rather than storing a live bar). |
| Price history | `markets/us/history.py`: a stock without a file is seeded from Dhan's history; afterwards the snapshot's bar is appended. A gap, or a previous close more than 0.5% off the stored close (a split), refetches the stock in full. Only `ohlcv_data/` and `indices_ohlcv_data/` persist between runs (Actions cache); losing them costs one re-seed of about 30 minutes. |
| Benchmarks | SPY, QQQ, IWM and DIA histories stand in for indices; SPY is the market benchmark. |
| Breadth, index history | India's `generate_market_breadth` and `generate_all_index_history`, with US floors ($1 price, $100M market cap). |
| Stock metrics | India's `process_symbol_csv` on the NYSE calendar, plus RSI(14) and dollar turnover. |
| RS ratings | `build_rs_ratings.main(root, 'SPY.csv', ...)`. |
| TradingView | `markets/us/tradingview.py`: one request to TradingView's US scanner (types `stock` and `dr` on NYSE, Nasdaq, AMEX and Cboe; secondary share classes and ADRs are not "primary" there), matched by ISIN. It supplies India's published TradingView metrics in dollars, the all-time high (never below the stored history's), the last and next earnings dates, free float, dividend yield and ex-dates. A failed request publishes the release without them. |
| Statements | TradingView first (same request): trailing revenue, profit, margin and EPS, the latest balance sheet, cash flow, debt, free cash flow, P/B and five-year growth, in dollars. The screener adds industry and India's multi-year averages (percentages only; its amounts are in each company's home currency). `markets/us/statements.py` fills the rest (profit before tax, tax, total income and expense, interest coverage, PEG) from Dhan's stock pages, cached and refreshed weekly or after earnings, and only when a page's latest quarter agrees with TradingView's: Dhan's pages carry stale periods and home-currency amounts without saying so. |
| Financials, IPOs | Empty files for now (Phase 2). |

**Amounts.** Records carry `market_cap` and `dollar_volume` in dollars. The engine reads amounts from India-named
fields (`market_cap_crore`, `daily_rupee_turnover_*_cr`); the builder fills those in millions of dollars and the
release declares `currency: USD` and `amountUnit: 1000000`, so the app labels them `$M`. Preset floors are US ones:
$300M market cap, a $5 close, $2M a day of turnover.

**The release** (`frontend/publish_us.py`) is India's row engine, packed format and revision upload. Its files sit
beside India's under `releases/<rev>/`; its pointer is `site/data/us/current.json` (`/data/us/current.json`).
India's `current.json`, sessions, price bands and AI catalogue are never written.

**Not yet:** index membership (ETF holdings), listing dates,
ownership, F&O, delivery and Indian surveillance flags. The app hides these for the US market.
