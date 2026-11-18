# Nexus Scanner

Nexus Scanner is an NSE equity research and screening system. It contains a React browser application, a Python market-data pipeline, immutable scanner releases, and optional Cloudflare R2 chart delivery.

Every result is tied to one published trading session and one immutable revision. The system does not silently combine a new stock snapshot with an old IPO catalogue, chart file, or filter result.

> Nexus Scanner is for research and data-engineering workflows. It is not investment advice. Upstream market data can be delayed, incomplete, corrected, rate-limited, or unavailable.

## Contents

- [Technical architecture](#technical-architecture)
- [How people use this repository](#how-people-use-this-repository)
- [Every scanner form and filter family](#every-scanner-form-and-filter-family)
- [Calculation conventions and formulas](#calculation-conventions-and-formulas)
- [What happens at runtime](#what-happens-at-runtime)
- [How every published file is generated](#how-every-published-file-is-generated)
- [Storage, caching, and R2](#storage-caching-and-r2)
- [Local development](#local-development)
- [Configuration and production deployment](#configuration-and-production-deployment)
- [Recovery and troubleshooting](#recovery-and-troubleshooting)
- [Automated refreshes](#automated-refreshes)
- [Testing, data quality, and limits](#testing-data-quality-and-limits)

## Repository map

| Location | Responsibility |
| --- | --- |
| [`frontend/`](frontend/) | Browser data publication (Python) and the shared filter catalogue the AI Worker and the pipeline read. The screener UI lives in Nexus Journal (`packages/nexus-scanner`). |
| [`workers/screener-ai/`](workers/screener-ai/) | The `nexus-scanner` Worker: published data (`/data/*`) from R2 and the AI screen compiler. |
| [`DO NOT DELETE EDL PIPELINE/`](DO%20NOT%20DELETE%20EDL%20PIPELINE/) | Python acquisition, history maintenance, calculations, condition engine, artifact validation, and publication. The directory name is preserved because existing workflows use it. |
| [`.github/workflows/daily_refresh.yml`](.github/workflows/daily_refresh.yml) | Weekday refresh, tests, scanner publication, R2 upload when configured, and generated-data commit. |
| [`.github/workflows/weekly_eod2_refresh.yml`](.github/workflows/weekly_eod2_refresh.yml) | Weekly adjusted-history overlay followed by the same validated publication flow. |
| `docs/r2-chart-publication.md` (private notes) | R2 object layout, retry behavior, retention, and chart fields. |
| [`frontend/README.md`](frontend/README.md) | What remains in `frontend/` and how to test it. |

## Technical architecture

Nexus is deliberately split into a data plane (this repository) and an interaction plane (Nexus Journal).

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Screener UI and browser screen engine | Nexus Journal's `packages/nexus-scanner` | Renders the screener, charts and tables; evaluates supported rules on published snapshots in a Web Worker. Not in this repository. |
| Data and AI Worker | Cloudflare Worker (`workers/screener-ai`) | Serves published data from R2 and compiles plain-English screens against the shared filter catalogue. |
| Condition contract | Typed TypeScript catalogue and Python registries | Keeps field names, inputs, presets, labels, and availability rules aligned across the pipeline, the AI Worker and the journal's copy. |
| Python evaluator | Python, pandas, NumPy | Evaluates historical OHLCV, multi-session, delivery, pattern, earnings, and cross-series rules. |
| Data pipeline | Python, requests, BeautifulSoup, CSV/JSON/Gzip | Fetches, standardizes, validates, and promotes market artifacts. |
| Release store | Git-hosted immutable JSON and gzip files | Publishes compact scanner releases and a small active-release pointer. |
| Chart store | Cloudflare R2 | Supplies per-symbol compressed payloads the journal's charts load. |
| Automation | GitHub Actions | Runs daily and weekly refreshes, tests, publication, and generated-data commits. |

### Shared filter catalogue

| Module | What it does |
| --- | --- |
| `frontend/src/data/` | Condition, preset and scan catalogues. The pipeline reads `presetEligibility.json`, `snapshotTechnicals.json` and `scanRecipes.json`; the AI Worker compiles screens against the TypeScript catalogues and `nativeConditions.json` (also read by `test_scanner_bridge.py`). |
| `frontend/src/api/aiFilterCatalog.ts`, `aiScreenerContract.ts` | The AI compiler's filter list and the result it must return. |
| `frontend/src/api/snapshotScreen.ts`, `frontend/src/utils/` | Condition rules the catalogue and compiler share. |

Nexus Journal keeps its own copy of these files in `packages/nexus-scanner/src`; change both together.

### Pipeline modules

| Module area | What it does |
| --- | --- |
| `edl_pipeline.runner` | Orchestrates stages, script lanes, compression, validation, cleanup, and reports. |
| `edl_pipeline.publication` | Promotes only validated staged artifacts and triggers the frontend publisher. |
| `edl_pipeline.validators` | Checks schema, required fields, counts, and artifact readability. |
| `edl_pipeline.scanner.trend` | Normalizes OHLCV and evaluates the condition-expression tree with match/no-match/unavailable results. |
| `edl_pipeline.scanner.context` | Evaluates fundamentals, RS, earnings, surveillance, and snapshot-aligned conditions. |
| `edl_pipeline.scanner.patterns` | Implements gaps, inside bars, range contraction, VCP, resistance, and related chart patterns. |
| `edl_pipeline.scanner.presets` | Stores and validates the versioned 45-preset library. |
| `edl_pipeline.breadth` | Builds eligible universes, benchmark alignment, breadth measures, and ratings inputs. |
| `edl_pipeline.sources` | Encapsulates exchange archive, market-data and news retrieval. |
| `edl_pipeline.transforms` | Produces fundamental, event, and market-breadth derived artifacts. |

## How people use this repository

### 1. Researcher: find an actionable candidate list

Use the screener in Nexus Journal (`/scanner`).

1. Select Mainboard or another available indexed universe such as Nifty 500.
2. Start from a preset such as Persistent Momentum, then tune its parameters; or build a rule from scratch.
3. Choose `Match all` when every rule must pass, or `Match any` for an OR screen.
4. Run the screen, sort the table, and copy symbols from the displayed result page.
5. Reopen the browser to restore the current workspace preferences.

This workflow is for idea generation and repeatable research. It does not execute trades or provide a portfolio recommendation.

### 2. Analyst: reproduce a screen for a published session

Use the revision/session visible in the screen result. The immutable release lets an analyst explain what data was used for the result and rerun the same expression against the matching backend inputs where history is available. Same-session data corrections create a new revision, preserving the older release rather than overwriting it.

### 3. Product team: embed the screener

The screener UI is Nexus Journal's `packages/nexus-scanner`. It reads published data and the AI endpoint from the `nexus-scanner` Worker (`npm run deploy`); opening the Worker's own pages redirects to the journal.

### 4. Data engineer: refresh public market artifacts

Run the EDL pipeline locally or let GitHub Actions run it on schedule. The pipeline stages files away from the current public release, validates them, then promotes the release only when the required checks pass.

```bash
cd "DO NOT DELETE EDL PIPELINE"
python3 run_full_pipeline.py
```

After the run, inspect `data_quality.json`, `pipeline_report.json`, and the generated browser release before publishing external changes.

### 5. Quant or developer: add a new condition or preset

1. Add a typed input definition to the condition catalogue (`frontend/src/data/`, and the journal's copy).
2. Add the condition's evaluation contract in the Python registry and implementation.
3. Define missing-data and session-alignment behavior explicitly.
4. Add unit tests for match, no-match, and unavailable outcomes.
5. If the rule belongs in a built-in scan, add or update its declarative preset definition.
6. Regenerate a snapshot and verify browser-worker support. Keep a Python fallback for rules that require unbundled historical data.

### 6. Data platform operator: run charts at scale

Set the R2 environment variables, enable `EDL_CHART_STORAGE=r2`, and run the normal pipeline. The publisher uploads immutable per-symbol files, verifies them, and updates the release only after all required publication work completes. Clients fetch one chart at a time from the release URL template.

## Every scanner form and filter family

The filter catalog is a typed contract. A condition has a name, documented inputs, evaluation rules, and availability requirement. The client renders its form from this contract, and the Python evaluator uses the same condition identifiers.

### Trend and moving-average filters

| Condition | What it evaluates |
| --- | --- |
| Indicator Compare / Crossover | Numeric comparison or recent crossover between price transforms, indicators, or a fixed value, with independent periods and offsets. |
| MA Convergence | Spread among selected SMA/EMA values divided by close, with an explicit tolerance. |
| Price / Oscillator Divergence | Confirmed regular or hidden bullish/bearish divergence without future-bar leakage. |
| Supertrend Direction | Wilder-ATR Supertrend line and bullish/bearish state, or a recent direction turn. |
| Persistent Momentum | Price persistence above or below selected EMAs with the configured reset rule. |
| Price vs EMA / Price vs SMA | Latest close relative to the selected EMA or SMA. |
| EMA Shakeout & Reclaim | A recent dip through an EMA followed by a current reclaim. |
| MA Stack / Moving Average Stack Order | Ordered moving averages such as 20 above 50 above 200. |
| % Days Above MA | Share of a selected lookback spent above a selected moving average. |
| MA Slope / MA Slope & Trajectory | Direction and percentage movement of a moving average across its lookback. |
| EMA Key Level Reclaim | Recent EMA violation followed by a reclaim. |
| Consecutive Up Days | A run of positive-close sessions. |

### Price, volatility, range, and chart-pattern filters

| Condition | What it evaluates |
| --- | --- |
| Price Change % | Return across a trading-session window. A legacy `Below` request is interpreted as a decline of at least the threshold. |
| New High / New Low | Highest high or lowest low over a complete rolling lookback, optionally fired recently. |
| % From 52-Week High / Low | Latest close distance from the high or low over up to 252 sessions. |
| All-Time-High distance | Split- and bonus-adjusted distance from all available EOD history. |
| ATR % / ADR % | Wilder ATR or average daily high-low range as a percentage of price. |
| Consolidation Range | High-low range of a completed base. |
| Range Contraction / VCP | Relative contraction of recent and prior ranges or swing legs. |
| Inside Bar | Daily or weekly bars contained by preceding bars. |
| Unfilled Gap | Up or down gaps that have remained open or have filled. |
| Horizontal Resistance | Unbroken clustered swing-high resistance near the current base. |
| Gap Up / Gap Down | Session gaps relative to the prior close. |

### Volume, liquidity, delivery, and trading controls

| Condition | What it evaluates |
| --- | --- |
| RVOL / Volume vs Average | A session's volume relative to its preceding average-volume window. |
| Volume Trend | Recent volume compared with a prior base window. |
| Highest Volume in N Days | A high-volume event in its completed lookback. |
| Average Turnover | Average traded value in crore across a daily lookback. Intraday windows require intraday history. |
| Delivery % Spike | Delivery percentage against aligned delivery history. |
| Market Cap / Free-Float Market Cap | Current capitalisation and free-float-adjusted capitalisation. |
| Price Range / Circuit Band | Current close range and NSE price-band constraints. |
| F&O Ban / Series | Current official ban state and NSE listing series. |
| Exclude ASM / GSM | Latest available surveillance lists, including stage and fetch date. |

### Relative strength, breadth, and universe filters

| Condition | What it evaluates |
| --- | --- |
| Relative Strength | Stock return minus benchmark return over aligned sessions. |
| RS Line at New High | Relative-strength line at its lookback high while price remains below its own high. |
| RS Rating | Cross-sectional 1–99 percentile across the published eligible universe. |
| Index Membership | Published current index membership. |
| Market Breadth | Published breadth metrics for the supported universe and session. |
| Sector / Industry | Current published NSE classifications. |
| Listing Age | Trading sessions since listing. |

### Fundamental and earnings filters

| Condition | What it evaluates |
| --- | --- |
| P/E | Positive trailing P/E from the released fundamental snapshot. |
| Quarterly growth | QoQ or YoY revenue, net profit, PBT, EPS, or operating-margin growth. |
| Fundamental metric | ROE, ROCE, operating margin, verified debt/equity, PEG, five-year sales growth, latest-quarter revenue, non-current assets, total liabilities and annual interest coverage. Published price/history choices also include session VWAP, latest declared DPS, listing-covered ATH/ATL and five-year return. |
| EPS Last Year Higher | Latest annual EPS compared with the preceding annual EPS. |
| Days Since Earnings | Trading sessions since the latest reported earnings event. |

Financial amounts labelled in lakhs are converted from crore values. Statement periods and derived formulas are retained in metadata. D/E remains unavailable without actual borrowings; latest declared DPS is not annual DPS. See published financial and price fields (private notes) for source contracts, query examples and history coverage rules.

### Built-in scans

The versioned local preset library contains 45 scans, including Persistent Momentum, Easy Money, Relative Strength Leaders, RS Line at New High, Stage 2 Uptrend, Momentum Burst, Quiet Strength, 52-Week High Breakout, 20-Day High on Record Volume, Breakout from Tight Base, Pocket Pivot, ADX Trend Breakout, Circuit-Safe Breakout, VCP Contraction, Inside Bar Coil, Weekly Inside Bar, Volume Dry-Up Base, Flat Base, Horizontal Resistance, Flags & Pennants, Low-ATR Coil, 21 EMA Pullback, 50 EMA Shakeout, Higher-Low Pullback, Gap Support Retest, Volume Surge, Highest Volume in 3 Months, Delivery-Backed Accumulation, Sustained Accumulation, Unfilled Gap Up, Gap & Go, Gap Down Washout, 52-Week Low Bounce, RS Divergence Turn, Relative Weakness, Earnings Growth Momentum, Post-Earnings Drift, Growth at a Fair Price, Revenue & Profit Acceleration, Pre-Earnings Coil, Breadth-Gated Leaders, Liquid Trading Universe, Fresh IPO Base, Nifty 500 Momentum, and Midcap Breakout.

Preset defaults deliberately include market cap above ₹1,000 Cr, price above ₹10, and 50-day average turnover above ₹5 Cr. They have no upper market-cap or price ceiling and no blanket 2% or 5% circuit exclusion.

## Calculation conventions and formulas

All technical windows below use trading sessions, not calendar days. Data is cut off at the published session. A 20-session return requires 21 closes. Missing required history produces `unavailable`; a shortened window is not silently substituted unless that condition explicitly allows it.

| Calculation | Rule |
| --- | --- |
| SMA(N) | Mean of the latest N closes; a full N-session window is required. |
| EMA(N) | Recursive exponential average with `adjust=False`; required warmup still applies. |
| Return(N) | `100 × (latest close / close N sessions earlier − 1)`. |
| Daily return | Same formula with N=1. |
| Gap % | `100 × (current open / prior close − 1)`. |
| RVOL(N) | Current volume divided by the mean of the preceding N volumes, excluding the current session. |
| Average turnover(N) | Mean of `close × volume` over N sessions, divided by 10,000,000 for ₹Cr. |
| ADR(N) % | Mean of `100 × (high − low) / close` over N sessions. |
| True range | Maximum of `high − low`, `abs(high − prior close)`, and `abs(low − prior close)`. |
| ATR % | Wilder-smoothed true range divided by current close, multiplied by 100. |
| Consolidation range % | `100 × (window maximum high − window minimum low) / final close`. |
| RS over N sessions | Stock percentage return minus the aligned benchmark percentage return. |
| Quarterly growth % | `100 × (latest value − comparison value) / abs(comparison value)`; QoQ uses the prior quarter, YoY the same quarter a year earlier. Zero/missing base is unavailable. |
| Historical P/E | Selected report type's four consecutive announced quarters of net profit; market cap divided by positive total profit. Missing quarters or nonpositive profit are unavailable. |

The browser release precomputes selected SMA, return, RVOL, gap, and turnover values plus preset outcomes. The Python registry supports wider parameter choices. A different lookback, metric, or report type may need backend evaluation.

### Persistent Momentum and persistence defaults

Persistent Momentum combines the configured EMA persistence branches with OR: the default periods/durations are 10 EMA for 20 sessions, 20 EMA for 30 sessions, and 50 EMA for 50 sessions. Its preset then combines the selected turnover condition and shared eligibility restrictions with AND. Refer to the declarative preset for all actual defaults; editing a custom condition does not remove a preset's other restrictions.

The default EMA persistence mode is `extreme_reset`. A contrary close arms its low for an above run, or high for a below run. A later trade beyond that extreme resets the run; equality does not. The armed extreme can survive beyond the requested trailing window. This differs from requiring every close to stay above the EMA. SMA persistence uses `strict_close`; explicit alternate EMA modes remain supported by the engine.

### Daily and weekly inside bars

A daily inside bar has `high ≤ preceding high` and `low ≥ preceding low`. For a consecutive run, each bar is compared with the immediately preceding bar; N inside bars require N+1 bars.

Weekly bars group daily sessions by ISO year/week: first open, maximum high, minimum low, last close, summed volume, and last session date. The same containment comparison runs on those aggregates. The default `completed` mode excludes the current ISO week. The explicit `current` mode includes it and marks the result provisional because it can change before that week finishes. Weekly means aggregated daily input, not a separately fetched weekly candle feed.

### Signal timing, rankings, and unavailable inputs

- `fired_within=1` means the latest session; 2 also allows the preceding session.
- RS ratings use aligned stock/benchmark history and a cross-sectional eligible universe. The composite weights 21/63/126/252-session relative returns by 40/20/20/20; sufficient aligned history is required. A rating is not simply a stock's raw one-year return.
- Official delivery observations override overlapping fallback history. A current delivery percentage alone does not establish a historical spike.
- `match OR unavailable` is a match; `no_match OR unavailable` remains unavailable. `no_match AND unavailable` is no match; `match AND unavailable` remains unavailable.
- Historical classification, capitalisation, financial availability, and membership must satisfy their own date contracts. A future snapshot is not a valid substitute for an absent dated record.

Exact condition inputs, pattern definitions, and availability rules are documented in the trend engine guide (private notes) and implemented under `src/edl_pipeline/scanner/`. These definitions establish local behavior; they do not guarantee identical results to another provider using different data or universe membership.

## What happens at runtime

The client side below is Nexus Journal's screener (`packages/nexus-scanner`); this repository publishes what it reads.

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Nexus Journal
  participant M as current.json
  participant W as Snapshot Worker
  participant API as Python Screen API
  participant R2 as Chart Storage

  U->>UI: Open or run a screen
  UI->>M: Check active release
  M-->>UI: Session date and immutable revision URLs
  UI->>W: Run supported expression
  W->>W: Fetch, decompress, parse, filter, sort, paginate
  W-->>UI: Result page and diagnostics
  UI->>API: Use only if history-dependent expression is unsupported in worker
  API-->>UI: Authoritative evaluated result
  UI->>R2: Load one chart payload on demand
```

### Browser release loading

1. The app loads `/data/current.json` from the Worker and validates its revision and session metadata.
2. It resolves the immutable `stocks.json.gz` URL when browser decompression is available, otherwise the JSON URL.
3. A persistent module worker fetches the snapshot with cache reuse, decompresses it, validates its revision/session/row count, and retains at most a small number of revisions.
4. The worker evaluates supported conditions against precomputed values, then returns only the requested result page rather than all matching rows.
5. Changing pagination reuses the matching and sorted set. Changing filters, universe, symbols, or sort recalculates the set.
6. An unsupported custom expression falls back to the Python `/screens/run` service, pinned to the same revision and session.

The main UI never claims a browser-only approximation is a result for a rule that needs the Python history engine.

### Browser charts

The journal's charts request one immutable compressed payload at a time using the chart URL template in the release, and verify the symbol and session before drawing it.

### Precomputed work versus runtime work

| Operation | When it happens |
| --- | --- |
| Source retrieval, history overlays, fundamental normalization | Pipeline refresh. |
| RS ratings, breadth, events, and canonical market fields | Pipeline refresh. |
| Supported numeric snapshot metrics and 45 preset results | Snapshot publication, once per immutable release. |
| Chart candles and volume/event groups | Chart generation before cleanup. |
| Snapshot decompression, parsing, and validation | First use of a revision in the worker. |
| Supported custom comparisons, Boolean groups, universe selection | Browser screen execution against published metrics. |
| Historical/pattern expressions absent from the browser contract | Python fallback at request time. |
| Sorting and pagination | Worker; later pages reuse the cached matching set. |

Not every possible custom calculation is precomputed. Preset membership and selected metrics are; arbitrary historical conditions can still require the Python engine. The worker retains at most two loaded revisions and up to four compiled result sets per snapshot. The app checks the current release every 60 seconds and when focus returns. No WebAssembly runtime is required. If workers are unavailable, the same snapshot engine runs on the main thread.

### Runtime files

In production these are served from R2 by the `nexus-scanner` Worker at the same `/data/...` URLs, so a refresh
needs no commit or rebuild; the local paths below are what development and the pipeline write. See
[docs/site-data-r2.md](docs/site-data-r2.md).

| File or path | Runtime use |
| --- | --- |
| `frontend/public/data/current.json` | Small active-release pointer. Revalidate frequently. |
| `frontend/public/data/revisions/<revision>/stocks.json.gz` | Compressed stock snapshot used by the worker. |
| `frontend/public/data/revisions/<revision>/stocks.json` | Compatibility snapshot for clients without compressed loading. |
| `frontend/public/data/revisions/<revision>/ipos.json` | Immutable IPO catalogue for that release. |
| `frontend/public/data/revisions/<revision>/release.json` | Revision metadata retained for an open historical release. |
| `daily/<session>/<chart-revision>/charts/<symbol>.json.gz` in R2 | One on-demand chart payload per symbol. |

## How every published file is generated

```mermaid
flowchart TD
  A[Source fetches] --> B[Isolated pipeline stage]
  B --> C[Normalize and validate]
  C --> D[Derived analytics and screen inputs]
  D --> E[Compressed public EDL artifacts]
  D --> F[Scanner snapshot publisher]
  F --> G[Immutable frontend revision]
  D --> H[Per-symbol chart builder]
  H --> I[Optional R2 publication]
  G --> J[current.json written last]
  I --> J
```

### 1. Source collection

The EDL pipeline collects public NSE archive data, market and company data, official delivery files, corporate actions, filings, announcements, index data, F&O information, surveillance lists, and market data needed for the selected refresh. Source availability is not assumed: failed required stages stop publication.

### 2. History maintenance

The pipeline maintains local OHLCV, index OHLCV, delivery, scanner-history, and filing-history caches. Weekday refreshes add official recent data. The weekly workflow overlays available adjusted history so longer lookbacks can be retained without downloading full history on every weekday run.

### 3. Normalization and calculations

The pipeline standardizes securities and calculates:

- Mainboard eligibility, listing metadata, market cap, classifications, and current tradability fields.
- OHLCV-derived moving averages, returns, RVOL, turnover, highs/lows, ATR/ADR, gaps, and pattern inputs.
- Relative-strength and breadth datasets with aligned benchmark sessions.
- Fundamental, earnings, shareholding, delivery, corporate-action, surveillance, F&O, and IPO artifacts.
- Data-quality and universe-reconciliation reports.

### 4. Artifact validation and promotion

The full refresh runs in an isolated temporary stage. It validates schema, required fields, counts, freshness, and cross-artifact dates before promotion. A failed stage or quality check leaves the previously published public files unchanged. Promotion rolls back files on ordinary exceptions, including frontend-publication errors; this is not a filesystem transaction across every file or protection against every process crash. Shared history caches may have been updated even when public promotion fails.

### 5. Browser snapshot publication

`frontend/publish_snapshot.py` reads validated EDL artifacts, calculates the browser-safe metrics and preset results, freezes local Python inputs for custom evaluations, and creates a content-hash revision.

It writes immutable revision files first, verifies the release, and writes `current.json` last. A same-session correction therefore gets a new immutable revision rather than overwriting an earlier result.

Each browser revision contains `stocks.json`, `stocks.json.gz`, `ipos.json`, and `release.json`. Condition and preset catalogues live in `frontend/src/data/` and ship with the application build. Frozen Python evaluation inputs live under `DO NOT DELETE EDL PIPELINE/.scanner_cache/revisions/<revision>/`; serving a frontend revision does not automatically make those private backend files available on another server.

### 6. Chart generation and R2 upload

The chart builder runs before temporary news and filings directories are removed. It creates one compressed JSON payload per symbol, validates the chart index, payload symbol, session, and content revision, then uploads immutable objects to R2 when configuration is complete.

### Chart payload and event retention

| Field/group | Content and window |
| --- | --- |
| Identity | Schema version, symbol, session (`asOfDate`), and first available candle (`historyStartDate`). |
| `candles` | Date, open, high, low, close, volume; all available cached sessions through the published session. |
| `volumeEvents.highestEver` / `lowestEver` | Highest/lowest daily volume across available history, not an independently guaranteed inception archive. |
| Monthly volume records | Highest-volume day in each of the latest 60 represented months. |
| Quarterly volume records | Highest- and lowest-volume day in each of the latest 20 represented quarters. |
| Yearly volume records | Highest-volume day in each of the latest 10 represented years. |
| `corporateActions` | Available actions whose ex-date is no later than the published session. |
| `earnings` | Available earnings records filed by the published session. |
| `regulatoryAnnouncements` | Available official announcements; no fixed item-count cap in the builder. |
| `marketNews` | Latest 50 available items. Optional source failure can leave this empty. |

The builder does not truncate candles to four years. A four-year chart means its input cache supplied roughly four years. Weekly execution alone is not proof that every symbol has inception history. Missing candles or event arrays must not be described as complete history. Zero-volume sessions remain valid inputs to low-volume records.

### Generated public artifacts

| Artifact | Contents |
| --- | --- |
| `all_stocks_fundamental_analysis.json.gz` | Canonical stock snapshot and published fundamental fields. |
| `sector_analytics.json.gz` | Sector and industry analytics. |
| `market_breadth.json.gz` / `market_breadth_v2.json.gz` | Current and historical breadth outputs. |
| `breadth_universe_snapshot.json.gz` | Fixed eligible universe used for breadth and RS calculations. |
| `all_indices_history_v2.json.gz` / `all_indices_list.json` | Published index metadata and history. |
| `corporate_action_ledger.json.gz`, `nse_corporate_actions.json.gz` | Corporate-action data used by published features and charts. |
| `nse_fno_ban.json.gz`, `rs_rating_daily.json.gz` | F&O ban and daily RS-rating artifacts. |
| `ipo_screener.json.gz` | IPO catalogue source. |
| `shareholding_history.json.gz`, `quarterly_financial_history.json.gz` | Published historical shareholding and financial records. |
| `data_quality.json`, `mainboard_universe_report.json`, `nse_universe_reconciliation.json` | Quality, universe, and reconciliation diagnostics. |
| `pipeline_report.json` | Release execution and final-validation report, generated on each successful pipeline run. |

## Storage, caching, and R2

| Data | Where it lives | Why |
| --- | --- | --- |
| Source code and compact public scanner releases | Git | Reviewable application and immutable browser release history. |
| Current browser pointer | Git/static host | Small release authority for the frontend. |
| Per-symbol chart payloads | Cloudflare R2 | On-demand delivery without growing Git history by every chart revision. |
| Raw OHLCV, delivery, and filing caches | Local workspace and GitHub Actions cache | Fast incremental pipeline runs. |
| Long-term raw-history backup | Private R2 backup, planned | Recovery when an Actions cache is evicted. |
| Current workspace preferences | Browser local storage | User-local state without a server account or named-screen library. |

GitHub Actions cache is an accelerator, not durable data storage. It may be evicted. Raw-history recovery should come from the planned private backup, not from an assumed cache hit.

### R2 behavior

R2 configuration is controlled by:

```text
EDL_CHART_STORAGE=r2
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_PUBLIC_BASE_URL
R2_BUCKET=nexus-screener-chart-data
```

When one of the required R2 settings is absent, the scanner release still publishes without chart URLs and logs the missing settings. When all settings are present, an upload, verification, retention, or archive failure stops publication and preserves the previous active release.

R2 retention is:

- Daily chart revisions: 90 calendar days.
- Month-end chart revisions: retained indefinitely.
- The first successful release of a new month archives the prior month’s latest successful session.

The 90-day lifecycle age is based on object upload time and deletion is asynchronous. If publication remains down for more than 90 days, an active daily revision can expire before rollover archival. Month-end retention therefore requires successful publication and monitoring; it is not a guarantee during an indefinite outage. Private raw-history backup and automatic restoration are planned, not implemented by chart publication.

See `docs/r2-chart-publication.md` (private notes) for the object layout and lifecycle details.

## Local development

### Prerequisites

- Python 3.9 or later.
- Node.js and npm compatible with `frontend/package-lock.json`.
- `rclone` only if directly testing an R2 upload.

### Pipeline setup

```bash
cd "DO NOT DELETE EDL PIPELINE"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python3 -m unittest discover -s tests -v
python3 -m compileall -q .
```

Run the complete pipeline when you intend to refresh local market files:

```bash
python3 run_full_pipeline.py
```

Diagnostic mode skips the OHLCV refresh and never promotes a new public release:

```bash
EDL_FETCH_OHLCV=0 python3 run_full_pipeline.py
```

### Publish local browser data

From the repository root, after a validated pipeline run:

```bash
python3 frontend/publish_snapshot.py
```

### Run the AI Worker locally

```bash
npm install
npm run dev:ai
```

It serves `/api/screener/ai-compile` on port 8787 and reads `frontend/public/data/` (run `python3 frontend/site_data.py ai-choices` after a local publication).

## Configuration and production deployment

### Configuration reference

| Setting | Default / purpose |
| --- | --- |
| `EDL_BASE_DIR` | Override pipeline data root; otherwise the pipeline's configured local directory. |
| `EDL_FETCH_OHLCV` | True; false selects diagnostic behavior rather than normal public promotion. |
| `EDL_FETCH_OPTIONAL` | False; enables optional acquisition stages when selected. |
| `EDL_CLEANUP_INTERMEDIATE` | True; temporary fetch directories are removed after their consumers run. |
| `EDL_EOD2_DATA_DIR` | Existing long-history checkout used for the adjusted-history overlay. |
| `EDL_CHART_STORAGE` | `local` by default; `r2` selects remote chart publication. Other values are rejected. |
| `R2_ACCOUNT_ID` | Required for configured R2 publication; account containing the bucket. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Required server-side S3-compatible credentials. Never place them in frontend variables or public artifacts. |
| `R2_PUBLIC_BASE_URL` | Required public chart origin; browser access and CORS must work from the frontend origin. |
| `R2_BUCKET` | `nexus-screener-chart-data` unless overridden. |

Pipeline Boolean settings accept familiar true/false forms (`1/0`, `yes/no`, `on/off`); invalid values warn and use the default. Consult the workflow and source for additional source-specific settings rather than assuming this table enumerates every fetcher's tuning option.

### What a production installation needs

1. **Worker:** deploy the `nexus-scanner` Worker (`npm run deploy`), which serves `/data/*` from R2 and the AI compiler. The UI is Nexus Journal's.
2. **Release authority:** deploy immutable revision directories before updating `data/current.json`. Revalidate the pointer; cache immutable revision URLs for reuse. Keep the JSON fallback available alongside gzip.
3. **Chart origin:** when charts are enabled, expose the R2 URL template with suitable browser CORS and gzip delivery. A scanner-only release legitimately has no chart URLs.
4. **Operator monitoring:** watch failed workflows, stale session pointers, missing history, archive failures, and object expiry. Scheduled time is not a completion guarantee.

### Release identity and retry boundaries

Scanner revisions are content-addressed from their inputs and generated content. Chart revisions validate compressed symbol payloads and their content digest. R2 uploads use immutable revision paths and publish the scanner pointer only after required upload/verification succeeds. An existing immutable object must agree with the intended release; it must not be overwritten with different data.

Missing R2 configuration skips charts and permits fresh scanner publication. Once configuration is complete, upload failures stop publication. Recover and rerun the normal publisher; do not patch `current.json` to point at a partly uploaded chart set.

## Recovery and troubleshooting

### Refresh fails before publication

Inspect the workflow's failed stage and local `pipeline_failure_report.json` or `data_quality_failure.json` where generated. Fix the failed source, schema, freshness, or quality gate, then rerun the normal pipeline. Public promotion is gated; do not bypass validation just to advance the session date. Retain the prior valid release until recovery succeeds.

### History is missing or shorter than expected

First inspect a symbol's actual earliest/latest cache dates and its chart `historyStartDate`. A successful Actions cache restore or weekly run does not prove complete inception coverage. Check symbol identity/ISIN mappings before merging another cache.

To synchronize a bounded date range from an existing compatible EDL history directory, run from the pipeline directory:

```bash
python3 sync_local_scanner_history.py \
  --source-root /path/to/existing/EDL \
  --from-date 2026-09-29 \
  --as-of-date 2026-10-01
```

The dates above are examples; choose the missing range. The source directory needs its identity map and history files. The synchronizer validates identities and merges history with official overlays. Without `--source-root`, it can fetch the requested missing daily data. A bounded daily recovery is not an inception backfill.

After successful history recovery, regenerate the charts and scanner release from matching artifacts:

```bash
# From the pipeline directory, after data/session validation
python3 build_chart_artifacts.py
cd ..
python3 frontend/publish_snapshot.py
```

The complete pipeline normally handles this ordering. Do not regenerate a newer pointer from mismatched financial, OHLCV, delivery, and chart sessions. Private R2 raw-history backups and automatic restore are still planned; the existing R2 chart files are derived outputs, not a replacement for all source caches.

### Browser requests fail or results are unavailable

| Symptom | Check |
| --- | --- |
| Snapshot cannot load | Pointer and immutable URLs exist; JSON/gzip content, revision, session, and row count agree. |
| Presets work but custom history rules fail | Python fallback is running and has the requested frozen revision/history. |
| Insufficient history | Required full lookback and warmup exist for that symbol. Newly listed securities may legitimately lack them. |
| History not aligned | Latest cached trading session agrees with the released screen date. |
| Chart unavailable | Release includes chart URLs; object exists; browser CORS/decompression works; symbol/session validation passes. |
| Missing earnings/news markers | Source data was acquired before cleanup and the records satisfy the release cutoff. Empty optional event arrays can be valid. |
| Old preferences reappear | Current workspace state is restored from this browser origin's local storage. |

For a rollback, redeploy a known valid immutable release and its compatible application/backend inputs through the normal deployment process. Ensure retained R2 objects still exist before restoring a pointer. Reverting a Git commit alone does not recreate expired R2 objects or evicted private history.

## Automated refreshes

### Daily weekday workflow

At 16:00 IST, Monday through Friday, the daily workflow restores available caches, runs the Python and scanner-publication tests, refreshes market inputs, calculates artifacts, publishes the browser snapshot, optionally uploads charts, and commits validated generated files.

### Weekly adjusted-history workflow

At 09:00 IST each Sunday, the weekly workflow restores its history caches, updates the adjusted-history checkout, overlays the long-history inputs, runs the same validation and publication sequence, and commits the result.

Both workflows use the same concurrency group. A daily release cannot race a weekly release.

## Testing, data quality, and limits

### Commands

```bash
# EDL pipeline tests
cd "DO NOT DELETE EDL PIPELINE"
python3 -m unittest discover -s tests -v

# Browser snapshot and R2 publication tests
cd ..
python3 -m unittest discover -s frontend -p 'test_*.py' -v

# Shared catalogue and Worker tests
cd frontend
npm test
npm run typecheck
```

### Match states

| State | Meaning |
| --- | --- |
| Match | All required inputs were available and the rule passed. |
| No match | All required inputs were available and the rule failed. |
| Unavailable | A required input was missing, insufficient, stale, or misaligned to the screen session. |

Unavailable is a deliberate result. It is used for missing OHLCV history, insufficient moving-average warmup, delivery gaps, unavailable historical snapshots, absent index membership, stale financial data, and unsupported intraday history. It never becomes a positive match.

### Important limits

- Historical technical screening needs local OHLCV history aligned to the requested session.
- Intraday turnover modes remain unavailable until intraday history is collected.
- Historical values for current-only fields, such as classification or P/E, cannot be reconstructed from a future snapshot.
- Data sources can change format or fail; a successful code test does not prove a particular upstream source returned complete live data.
- R2 charts are absent from scanner-only releases when R2 is not configured.

Read `DO NOT DELETE EDL PIPELINE/docs/DATA_LIMITATIONS.md` (private notes) and `DO NOT DELETE EDL PIPELINE/docs/PIPELINE_INTEGRITY.md` (private notes) before operating a live refresh.

## Further reading

- [Pipeline guide](DO%20NOT%20DELETE%20EDL%20PIPELINE/README.md)
- Trend condition engine (private notes)
- Market breadth methodology (private notes)
- NSE delivery data (private notes)
- R2 chart publication (private notes)
- [Frontend guide](frontend/README.md)
- [Contribution guide](CONTRIBUTING.md)

## License

[MIT](LICENSE)
