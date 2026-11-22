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
previous New York day in both EST and EDT. A snapshot taken during the session (19:00–01:30 IST in daylight time, 20:00–02:30 IST in standard time; on a 1 PM ET
early close, 19:00–22:30 IST in daylight time and 20:00–23:30 IST in standard time) is still trading and must not be
stored as a closed bar, as India's `is_nse_cash_session` already guards.

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
PYTHONPATH=src:. python -m edl_pipeline.markets.us <root>   # build the US root, from this folder
EDL_US_BASE_DIR=<root> python frontend/publish_us.py   # from the repository root
```

`.github/workflows/us_daily_refresh.yml` runs both at 07:00 India time Tuesday to Saturday, started by the nexus-gh-cron Worker in new_nexys_ultimate (`workers/gh-cron/schedule.ts`), not a GitHub schedule.

**The US root** (`markets/us/build.py`) holds the files India's root holds, so India's stages run on it unchanged:

| Stage | How |
| --- | --- |
| Universe | Two screener calls (stocks and ETFs). `markets/us/universe.py` keeps common stock and partnership units; preferred, notes, rights, warrants and SPAC units are classified and left out. |
| Snapshot check | Refused while New York is trading, when the latest trade is not from the last closed session, and when it stops before that session's close (exit 75: the workflow skips publication rather than storing a live bar). A stock whose own last trade is from an earlier session gets no bar that day. |
| Price history | `markets/us/history.py`: a stock without a file is seeded from Yahoo Finance (split-adjusted back to 1980 / IPO, official closes), falling back to Dhan's INX ticks (2021 onwards) when Yahoo has no bars for it: the ticker is missing, Yahoo errs or is unreachable, or a Yahoo rate limit stopped Yahoo for the run. Each run then appends the session's bar from the TradingView scan `tradingview.py` already reads (dated by its `time`; checked on 300 stocks against Yahoo and Nasdaq: final volume and range). Its close can still be a late print for about 7% of stocks until the next session, so each run corrects the previous bar's close to TradingView's previous close (`close - change_abs`, the official one). A previous close more than 5% off the stored one is a split and fetches the stock in full. A gap, or a stock TradingView does not cover, is filled from Yahoo's last two weeks, joined where they share a day, and TradingView's bar then supplies the session when Yahoo has not got it yet; Dhan's history is not used for this, as its bars since 2026-07-24 carry partial volume. A full fetch never replaces a deeper stored history with a shorter one. The release stops when TradingView covers under 98% of the 3,000 largest stocks or more than 800 stocks have no TradingView bar for the session. `ohlcv_data/`, `indices_ohlcv_data/`, `stock_pages/`, `sec_filings/`, `market_news/`, the rotation ledger and the quarterly ledger persist between runs in private R2 (`tools/us_state.py`: one archive a folder under `pipeline-state/us/`, the previous copy kept under `previous/`), pushed after the build and the ledger again after publication, as India keeps its pipeline state; a run whose restore failed never pushes. On the everyday path (TradingView's bar following the stored last bar) only the file's last row is rewritten and the new one appended, instead of reading and rewriting the whole file (about 170 s for the market). Yahoo is paced at about 8 a second with 8 workers, and a stock without a TradingView bar that Yahoo really answered with no bars for (not a failed request) is not asked again for a week (`.yahoo_empty.json` in the folder); a stock with a TradingView bar is always asked when it needs a gap filled. |
| Benchmarks | SPY, QQQ, IWM and DIA histories stand in for indices; SPY is the market benchmark. |
| Breadth, index history | India's `generate_market_breadth` and `generate_all_index_history`, with US floors ($1 price, $100M market cap). |
| Stock metrics | India's `process_symbol_csv` on the NYSE calendar, plus RSI(14) and dollar turnover. |
| RS ratings | `build_rs_ratings.main(root, 'SPY.csv', ...)`. |
| TradingView | `markets/us/tradingview.py`: one request to TradingView's US scanner (types `stock` and `dr` on NYSE, Nasdaq, AMEX and Cboe; secondary share classes and ADRs are not "primary" there), matched by ISIN. It supplies what Dhan does not: India's published TradingView metrics (amounts in millions of dollars, only when TradingView reports them in USD), the all-time high (never below the 52-week high), the last earnings date, free float, dividend yield, dividend per share and ex-date, VWAP, debt, debt/equity and free cash flow, and P/B. Its statement columns are the fallback below. A failed request publishes the release without them. |
| Statements | Dhan first (`markets/us/statements.py`): each stock's page, cached and fetched again after the company reports (and monthly as a sweep, since TradingView carries the statement history), 8 at a time. Dhan states foreign companies in their home currency without saying so (TSMC's assets read as $10 trillion) and keeps some parts years stale (Costco's balance sheet is from 2009), so each part is checked against TradingView's latest quarter: the income statement when it is for the quarter TradingView's last report filed and its revenue agrees within 10%, the balance sheet when it is for that quarter, the cash flow and yearly revenue when their year ended within 12 months of it. TradingView's values stand where a part fails or has a gap (a missing quarter). The screener adds India's multi-year averages (percentages only; its amounts are home-currency too). |
| Quarterly history | India's `quarterly_financial_history.json` rows (revenue, sales, net profit, PBT, EPS, OPM, EBITDA, consolidated). Each stock's quarters come from TradingView's scan (`*_fq_h` arrays: up to 32 quarters, in dollars, foreign reporters converted) when its verified quarters reach at least as far back as the trusted Dhan page's (10), else from the page; a stock without a usable page keeps whatever TradingView verifies, even four quarters. TradingView's arrays carry no dates, so quarters are dated back from the latest quarter end, and kept only up to the first fiscal year whose four quarters do not add up to TradingView's annual revenue: a quarter it dropped (new listings, spin-offs, restatements) would otherwise shift every older one. Operating profit, PBT and OPM, which TradingView's history lacks, come from the page's same quarter when both agree on its revenue. This drives earnings growth (GARP, revenue acceleration, earnings momentum). The latest quarter's filing date is TradingView's last earnings date when that date is after the quarter end; otherwise, and for earlier quarters, it is estimated as quarter end + 45 days (10-Q), or + 90 days for the fiscal year's last quarter (10-K) (`filing_date_basis`). |
| Statement history | Each stock's annual income, balance-sheet and cash-flow series in India's `financial_statement_history` shape (`annual`, `balance_sheet`, `cash_flow`, plus `cash_flow_quarterly`), written to `statement_history.json` and published with the quarters. Annual income: TradingView's years verified by the quarterly check, with the page's other lines for the same year, when they reach as far back as the page's 10 years; else the page's. Balance sheets and cash flow come from the Dhan page only, when the page is this company's dollars (its latest quarter agrees with TradingView's, even a quarter behind). Income and cash-flow blocks are used only when their periods are spaced as their names say (12 months for yearly, 3 for quarterly): Costco's page holds quarters in its yearly block. Balance sheets are dated snapshots that can skip quarters (Apple's do), so they are not spacing-checked. Any balance-sheet or cash-flow series ending a year or more before the latest quarter is a stale page and is left out. Pages cached before the annual income and quarterly cash flow were kept gain them at their next weekly fetch. |
| India's derived fundamentals | `opm5YearsAgoPct` from the annual history (India's `statement_summary`); `averageRoa3yPct` from TradingView's annual net income over average total assets (its own ROA convention; Dhan's US screener has no `Year3ROA`); `fixedAssetsCrore` from the page's latest balance sheet under a year old. `cwipCrore` stays empty: Dhan's US pages repeat fixed assets in it, and US balance sheets rarely show construction in progress apart. |
| Company news | `markets/us/news.py`: each stock's latest 50 articles from Dhan's `news-live.dhan.co/news/getarticlebyisin` (the endpoint its US stock pages use; India's `v2/news/getLiveNews` has no US news), one request a stock, 16 at a time paced at 40 a second (measured: 60-270 a second without throttling), beside the page and history fetches (about 3 minutes for the market), written as India's `market_news/<symbol>_news.json` and published by `build_chart_artifacts` as each chart's market news. About 92% of the 3,000 largest stocks and 70% of the rest have news. No sentiment is published (the endpoint carries none). |
| Earnings dates | `markets/us/earnings.py`: past report dates from Earnings Pulse's US results, which the India refresh archives daily (`results/us_index.json`, copied from R2 into the root by `tools/us_state.py pulse`, no public host assumed; about 15,700 reports over four quarters), and TradingView's last earnings date. Each quarter in the quarterly history takes the first known report date within 95 days after its end, marked `reported`; only older quarters keep the estimate. The upcoming calendar (`earnings_calendar.json`, India's shape, published as `earnings-calendar.json.gz` and named by `earningsCalendarUrl`) takes Earnings Pulse's upcoming reports, else TradingView's next earnings date with its time of day. The two sources agreed on 95% of 2026-Q4 report days. Older report dates are in neither (SEC EDGAR 8-K filings would be the source). |
| Company filings | `markets/us/filings.py`: each company's SEC EDGAR filing list (`data.sec.gov/submissions`, every filing since the 1990s), material forms only (10-K, 10-Q, 8-K with its items, 20-F/6-K, registrations, proxies, 13D/13G; Form 4s and structured-note filings are left out), cached per stock gzip-compressed under `sec_filings/` (about 12 KB a stock, ~75 MB for the market) and fetched again when EDGAR's daily index (`daily-index/.../master.YYYYMMDD.idx`, one small file a day) shows a new material filing, about 300 listed companies a day, plus a monthly sweep; companies a run does not reach stay pending in `sec_filings/_daily_index.json`. Without a readable index (first run, a gap over 30 days) a company is due weekly. 8-Ks with item 2.02 date past earnings releases back to the 2000s, joining the earnings dates. `filing_history.json.gz` (India's shape) is published by `build_chart_artifacts` as each chart's announcements. SEC asks for a contact in the User-Agent: the `SEC_CONTACT` repository secret; without it EDGAR is skipped. |
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
