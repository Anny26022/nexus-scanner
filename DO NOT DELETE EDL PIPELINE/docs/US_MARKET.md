# US market

The US scanner release is built from Dhan, as India's is: its screener (prices, returns, valuation and India's
multi-year averages), its daily history (every technical), and its stock pages (statements). TradingView's US scanner
fills what Dhan does not carry (all-time highs, earnings dates, free float, dividends, debt, free cash flow, VWAP) and
stands in for a Dhan statement that is missing or cannot be trusted. Seams: `edl_pipeline.markets` (one spec per
market), `markets.us.calendar` (NYSE), `markets.us.dhan` (sources), `markets.us.fields` (screener to canonical
record), `markets.us.history`, `markets.us.tradingview`, `markets.us.statements` and `markets.us.build`.

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
previous New York day in both EST and EDT. A snapshot taken during the session (19:00–01:30 IST in daylight time, 20:00–02:30 IST in standard time) is still trading
and must not be stored as a closed bar, as India's `is_nse_cash_session` already guards.

## Quirks Phase 1 must handle

- **Universe hygiene.** The stock list includes SPAC units (`…U`) and other thin instruments: they skip untraded days
  and some carry bars on weekends (CHECU on 2026-10-24/25). Filter units, rights and warrants out of the screener
  universe, drop bars on non-session days, and set a liquidity floor.
- **`NA` exchange.** Five stocks have no listing exchange. Their history is asked for under NYSE, then NASDAQ
  (`universe.history_exchanges`); the request is keyed by security id, so a wrong venue returns nothing, not another stock.
- **Fiscal years differ** (NVIDIA ends in January, Microsoft in June): key statements by fiscal period end.
- **History depth** uses Yahoo Finance for deep split-adjusted daily OHLCV back to 1980 / IPO (matching India's
  EOD2 repository), falling back to Dhan's INX ticks (2021 onwards) if Yahoo is unreachable. Daily updates use Dhan's
  screener snapshot to append the latest session bar with zero additional load. All-time highs, multi-year returns, and
  long-term moving averages are supported.
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
EDL_US_BASE_DIR=<root> python frontend/publish_us.py   # from the repository root
```

`.github/workflows/us_daily_refresh.yml` runs both at 00:30 UTC Tuesday to Saturday.

**The US root** (`markets/us/build.py`) holds the files India's root holds, so India's stages run on it unchanged:

| Stage | How |
| --- | --- |
| Universe | Two screener calls (stocks and ETFs). `markets/us/universe.py` keeps common stock and partnership units; preferred, notes, rights, warrants and SPAC units are classified and left out. |
| Snapshot check | Refused while New York is trading, when the latest trade is not from the last closed session, and when it stops before that session's close (exit 75: the workflow skips publication rather than storing a live bar). A stock whose own last trade is from an earlier session gets no bar that day. |
| Price history | `markets/us/history.py`: a stock without a file is seeded from Yahoo Finance (split-adjusted back to 1980 / IPO), falling back to Dhan's INX ticks (2021 onwards); afterwards the Dhan snapshot's bar is appended. A gap, or a previous close more than 0.5% off the stored close (a split), refetches the stock in full; the snapshot's bar is added to a refetched history only when it agrees with the snapshot's previous close (the provider may not have re-adjusted a split yet). `ohlcv_data/`, `indices_ohlcv_data/`, `stock_pages/` and the rotation ledger persist between runs (Actions cache, saved after publication); losing them costs one re-seed. |
| Benchmarks | SPY, QQQ, IWM and DIA histories stand in for indices; SPY is the market benchmark. |
| Breadth, index history | India's `generate_market_breadth` and `generate_all_index_history`, with US floors ($1 price, $100M market cap). |
| Stock metrics | India's `process_symbol_csv` on the NYSE calendar, plus RSI(14) and dollar turnover. |
| RS ratings | `build_rs_ratings.main(root, 'SPY.csv', ...)`. |
| TradingView | `markets/us/tradingview.py`: one request to TradingView's US scanner (types `stock` and `dr` on NYSE, Nasdaq, AMEX and Cboe; secondary share classes and ADRs are not "primary" there), matched by ISIN. It supplies what Dhan does not: India's published TradingView metrics (amounts in millions of dollars, only when TradingView reports them in USD), the all-time high (never below the 52-week high), the last earnings date, free float, dividend yield, dividend per share and ex-date, VWAP, debt, debt/equity and free cash flow, and P/B. Its statement columns are the fallback below. A failed request publishes the release without them. |
| Statements | Dhan first (`markets/us/statements.py`): each stock's page, cached and refreshed weekly or after earnings. Dhan states foreign companies in their home currency without saying so (TSMC's assets read as $10 trillion) and keeps some parts years stale (Costco's balance sheet is from 2009), so each part is checked against TradingView's latest quarter: the income statement when it is for the quarter TradingView's last report filed and its revenue agrees within 10%, the balance sheet when it is for that quarter, the cash flow and yearly revenue when their year ended within 12 months of it. TradingView's values stand where a part fails or has a gap (a missing quarter). The screener adds India's multi-year averages (percentages only; its amounts are home-currency too). |
| Quarterly history | India's `quarterly_financial_history.json` rows (revenue, sales, net profit, PBT, EPS, OPM, EBITDA, consolidated) from each trusted Dhan income statement's 10 quarters; this drives earnings growth (GARP, revenue acceleration, earnings momentum). The latest quarter's filing date is TradingView's last earnings date when that date is after the quarter end; otherwise, and for earlier quarters, it is estimated as quarter end + 45 days (`filing_date_basis`). |
| Index membership | TradingView's per-symbol index list: S&P 500, Nasdaq-100, Dow 30, Russell 1000 and 2000. It matches the issuers' holdings (SPY 503 of 503, DIA 30 of 30); iShares and Invesco refuse automated downloads of theirs. |
| Listing date | TradingView's IPO date (the first traded day where it has none). Listing age is counted in NYSE sessions from it (`calendar.sessions_after`), since the stored history starts in 2021. |
| Sector breadth | India's `generate_analytics` on the US records (sector and industry: stock count, % above SMA 20/50/200, % near the 52-week high) as `sector_analytics.json`; the publisher's market overview adds the breadth and the benchmark ETFs as index cards (the Market page). |
| Rotation | India's rotation history with a US setting (`publish_us.US_ROTATION`): the benchmark ETFs (S&P 500, Nasdaq-100, Dow, Russell 2000) and the equal-weight market, the US index memberships as stock universes, US floors for a group member ($300M cap, $2M a day), and sector and industry groups (no theme classification). Its membership ledger is carried between runs. |
| Financials, IPOs | Empty files for now (Phase 2). |

**Amounts.** Records carry `market_cap` and `dollar_volume` in dollars. The engine reads amounts from India-named
fields (`market_cap_crore`, `daily_rupee_turnover_*_cr`); the builder fills those in millions of dollars and the
release declares `currency: USD` and `amountUnit: 1000000`; the app (Anny26022/new_nexys_ultimate#600) labels them `$M`. Preset floors are US ones:
$300M market cap, a $5 close, $2M a day of turnover.

**The release** (`frontend/publish_us.py`) is India's row engine, packed format and revision upload. Its files sit
beside India's under `releases/<rev>/`; its pointer is `site/data/us/current.json` (`/data/us/current.json`).
India's `current.json`, sessions, price bands and AI catalogue are never written.

**Not yet:** ownership, F&O, delivery and Indian surveillance flags. The app hides these for the US market (Anny26022/new_nexys_ultimate#600).
