# EDL Pipeline - Dhan ScanX Data Integration

> **Single command to refresh everything:** `python3 run_full_pipeline.py`

---

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The project also has package metadata in `pyproject.toml`, so editable installs work:

```bash
pip install -e .
edl-pipeline
```

Copy `.env.example` only if your shell tooling automatically loads env files. The scripts read normal environment variables directly.
When using the installed `edl-pipeline` command outside this folder, set `EDL_BASE_DIR` to the absolute pipeline directory.

The wheel includes the scanner, runtime scripts, and byte-identical copies of
the pinned breadth methodology and filing-label mapping. Repository inputs keep
precedence; installed copies are used only when those source files are absent.
`edl-pipeline --help` and split-phase argument validation match the script.
The wheel does not bundle the frontend publisher or repository-level optional
index-reference tooling; use the checkout for the complete repository refresh.

CI builds an sdist, builds its wheel, installs into a fresh environment, and
checks imports, resource consumers, stage preparation and the installed CLI
outside the checkout. It does not fetch or publish live data. Reproduce with:

```bash
python3 -m pip install 'setuptools>=69' wheel build
python3 ../tools/check_pipeline_wheel.py
```

## 🚀 Master Pipeline Runner

```bash
python3 run_full_pipeline.py
```

Runs the fetch, analysis, enrichment, breadth, and compression stages in dependency order and produces `all_stocks_fundamental_analysis.json.gz`.
The runner also writes `pipeline_report.json` with script status, artifact validation results, byte sizes, configuration flags, and the final exit code.

**Configuration flags:**
- `FETCH_OHLCV = True/False` — Include stock/index OHLCV sync. Stock OHLCV is incremental and currently defaults to roughly four years of history when no local CSV exists.
- `FETCH_OPTIONAL = True/False` — Include optional standalone ETF data.
- `CLEANUP_INTERMEDIATE = True/False` — Delete intermediate JSON/CSV files after successful compression.

The same flags can be overridden without editing source:
```bash
EDL_FETCH_OHLCV=0 EDL_CLEANUP_INTERMEDIATE=0 python3 run_full_pipeline.py
```

### Refresh checkpoints and runtime

Daily and weekly Actions use the same runner in two phases:

```bash
python3 run_full_pipeline.py --phase fetch --stage /tmp/edl-refresh-example
python3 run_full_pipeline.py --phase build --stage /tmp/edl-refresh-example
```

Use a new stage directory and the same configuration for both commands. Fetch
writes a validated checkpoint without publishing; build resumes it, validates
all final artifacts, publishes, and removes the stage on success. The default
command still runs both phases together. Failed stages remain available for
inspection; start a new fetch for a new trading session.

Actions restore separate price and enrichment caches first. The previous
combined cache is used only when both split caches miss; a partial miss keeps
the newer cache and rebuilds the missing group from sources. This prevents
older combined files from being merged into newer cache contents.
They save incremental history after successful or failed fetch attempts before
build, then save updated enrichment caches even if build fails. Cache-save failures do
not block publication. Eviction or an interrupted save can still require a
backfill; these caches are an optimization, not durable storage.

Historical Actions cache-save steps for October 4 and 6 took 4–6 seconds for
the combined history cache and 0–4 seconds for the EOD2 checkout (a cache hit
can skip upload). These step times include packaging and upload. New split-cache
upload times remain unmeasured until a full refresh runs with this configuration.

Filing classifications are cached per symbol after merging duplicate source
labels, keyed by classifier inputs and classifier/mapping content. EOD2 retains
the existing import behavior without a separate fingerprint checkpoint. The
classification cache lives in the existing ignored history directory. Full indicator/count history is
retained; only breadth contribution lists outside the published date window are
omitted. The existing three fetch lanes separate filings, OHLCV, and the smaller
reference/enrichment fetches, avoiding a serial tail behind filings. Configured
per-script worker limits and pagination remain unchanged. Stock artifact writers
remain ordered; per-thread HTTP sessions reuse connections.

The latest completed NSE bhavcopy is fetched before universe filtering. Securities
listed after its session are deferred until that session is available and recorded
in `mainboard_universe_report.json`. Missing or invalid source dates stop filtering.
The master map retains each NSE `ListingDate`, which bounds new provider history
requests without removing older cached candles. Canonical OHLCV dates use a fast
ISO parser with the existing legacy-date fallback; calculations are unchanged.

`pipeline_report.json` includes per-script validation time. Filing logs report
load, PDF enrichment, classification and serialization times plus process peak
RSS. Publication keeps rollback copies on disk instead of loading all old and
new artifacts into RAM. The filing archive and validators still load JSON in
memory; this does not eliminate every memory cost. Measure the next full Actions
run before claiming an overall speedup.

Official NSE gap recovery loads each symbol once and writes its recovered
candles together. Raw prices are accepted only after the symbol's adjusted
EOD2 history boundary, or into an empty cache. Gaps within adjusted history or
an existing cache with an unknown price basis remain for provider sync and
the existing completeness checks. Recovery I/O failures also fall through to
provider sync; they do not bypass validation.

### Optional EOD2 historical bootstrap

The normal daily refresh uses the official NSE full bhavcopy for the latest
closed session and Dhan only for an in-market provisional candle or a missing
history fallback. To seed longer **adjusted**
daily OHLCV history from a local checkout of EOD2's data repository, set its
path for one full refresh:

```bash
git clone --depth 1 https://github.com/BennyThadikaran/eod2_data.git ~/data/eod2_data
EDL_EOD2_DATA_DIR=~/data/eod2_data python3 run_full_pipeline.py
```

The importer joins renamed segments by ISIN, not ticker filename. When EOD2's
current symbol-to-ISIN map also verifies the security, it imports that complete
symbol file instead of clipping it at the current ISIN's start date; renamed
ISIN segments then take precedence on overlapping dates. It overlays EOD2's
adjusted history, retains local candles newer than EOD2's snapshot, and writes
the existing `ohlcv_data/*.csv` cache format. No Parquet layer is added because
the scanner already consumes this CSV cache. Official NSE delivery-history
files remain the source for delivery-percent screens.

The canonical field contract intentionally follows the underlying exchange
data: EOD2 supplies split/bonus-adjusted OHLC while `Volume` remains the actual
historical traded quantity. Delivery quantities and percentages also remain
unadjusted. Dhan history is a missing-history fallback, not the authority for
retroactively rewriting volume; observed Dhan volume adjustment varies across
corporate actions. The EOD2 import report publishes these policies explicitly
so downstream scanners do not mistake raw traded quantity for synthetic
split-adjusted chart volume.

The repository's **Weekly Adjusted OHLCV Refresh** GitHub Action runs each
Sunday at 09:00 IST. It restores a cached EOD2 data checkout, fast-forwards it
from upstream, and invokes this same pipeline with `EDL_EOD2_DATA_DIR` set.
The weekday **Daily Data Refresh** also restores and updates EOD2 before it
runs the pipeline, then relies on the official NSE close for the latest
completed session. Its EOD2 update is best-effort: an upstream or network
failure is reported but does not prevent publication from the available local
history and official daily inputs.

### Mainboard universe and NSE reconciliation

Every refresh downloads and validates NSE's current `EQUITY_L.csv`. ScanX
is first captured as a raw source snapshot, then the current official NSE SME
market-watch feed is removed before the canonical universe is used by
fundamentals, OHLCV, breadth, rankings, or scanner artifacts. The retained
`sme_market_data.json.gz` is source coverage only; no SME symbol appears in
the scanner universe. `mainboard_universe_report.json` records the raw,
excluded, and final counts for each refresh.

Membership requires a symbol in the freshly validated NSE equity list after
SME exclusion. Absent symbols are reported under `excluded_unlisted`. Listed
symbols with different provider/NSE ISINs remain eligible and are reported under
`isin_mismatches`; reconciliation does not overwrite their ISIN or security ID.
Each entry distinguishes `isin_mismatch` from `missing_provider_isin` via its
`reason` field.
All refresh modes fetch the existing official bhavcopy once before filtering so listings
after its completed session are deferred. The report includes `session_date`,
`deferred_listings` with reason `listing_after_session`, and their count. Listings
on the session date remain eligible; deferred stocks are reconsidered each run.
Missing, stale, or future session metadata stops filtering before any output is written.
A reconciliation that would exclude more than 5% of the pre-reconciliation
mainboard universe fails before writing outputs, guarding against a truncated
listing response. Stdout reports SME exclusions, unlisted exclusions and ISIN
discrepancy counts.
A listing download/validation failure stops the refresh instead of filtering
against stale data. NSE-only listings still require provider enrichment.

`nse_universe_reconciliation.json` reports NSE
`EQ` listings that are absent from ScanX; they remain pending until ScanX
supplies an ISIN, security ID, and positive price. A row still absent after
two observed weekday sessions is marked as an alert. Rights and non-`EQ`
series are reported separately and never treated as IPO candidates.

### Pipeline Phases
```
PHASE 1 (Core):       Dhan + SME → fresh NSE listings + bhavcopy → universe filter → fundamentals
PHASE 2 (3 lanes):    filings | delivery history → EOD2 → NSE close → Dhan history fallback + live ScanX | references + other enrichment
PHASE 2.5 (Indices): index history sync after all fetch lanes finish
PHASE 3 (Analysis):   bulk_market_analyzer.py (creates base JSON)
PHASE 4 (Injection):  advanced_metrics_processor.py → process_market_breadth.py → add_corporate_events.py (LAST!)
PHASE 5 (Output):     gzip compression of final artifacts
```

⚠️ **Rule**: `bulk_market_analyzer.py` MUST run before Phase 4. `add_corporate_events.py` MUST be the very last script.

### Reliability Notes
- The pipeline preserves the existing public/undocumented endpoint behavior, but critical foundation scripts now exit non-zero when they cannot produce their required files.
- JSON and gzip writes are atomic, so interrupted writes do not leave half-written final artifacts in place.
- Shared HTTP POST calls use bounded retries with exponential backoff for transient upstream/network errors.
- Known script outputs are validated after each script runs. Required script validation failures stop the pipeline; optional/enrichment validation failures are reported as warnings.
- Final release artifacts are validated before the runner returns success: `all_stocks_fundamental_analysis.json.gz`, `sector_analytics.json.gz`, `market_breadth.json.gz`, and `all_indices_list.json`.
- Non-critical enrichment failures are reported in the final runner summary so a refresh can finish while still showing incomplete sections.
- Shared helpers live in `pipeline_utils.py`, `dhan_next_utils.py`, `nse_archive_utils.py`, and `ohlcv_utils.py` to keep request, JSON, gzip, path, Next.js, NSE archive, and OHLCV parsing behavior consistent.
- Importable package code lives under `src/edl_pipeline/`. The top-level scripts remain compatibility wrappers so existing automation can keep running `python3 run_full_pipeline.py` and individual script names.
- See `docs/DATA_LIMITATIONS.md` before relying on generated artifacts. This project is not affiliated with Dhan, NSE, Google, or any exchange, and outputs are not investment advice.

### Unofficial Endpoint Reference

The full endpoint dossier is in [`docs/DHAN_UNOFFICIAL_ENDPOINTS.md`](docs/DHAN_UNOFFICIAL_ENDPOINTS.md). It documents every public/unofficial source currently used by this repo: Dhan ScanX, Dhan static ScanX, Dhan news, Dhan tick history, Dhan Next.js data files, Google Sheets Gviz surveillance lists, and NSE archive CSVs.

For data lineage, see [`docs/DHAN_ENDPOINT_TO_ARTIFACT_MAP.md`](docs/DHAN_ENDPOINT_TO_ARTIFACT_MAP.md), which maps each endpoint to the script, raw artifact, transform, and final fields it affects.

### Verification
```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q .
python3 -m pip install -e . --dry-run
```

The unit tests cover deterministic transform helpers without calling live Dhan/NSE endpoints. Run `python3 run_full_pipeline.py` only when you want a full live data refresh.

### Daily trend screens

The local condition engine evaluates the eight daily trend conditions over the
published OHLCV cache without making a provider request. See
[`docs/TREND_CONDITION_ENGINE.md`](docs/TREND_CONDITION_ENGINE.md) and run:

```bash
python3 screen_trend_conditions.py --request examples/trend-screen-request.json
```

---

## 📡 Quick API Reference (Endpoints, Payloads & Limits)

This section is a compact overview. The detailed, repo-grounded source reference lives in [`docs/DHAN_UNOFFICIAL_ENDPOINTS.md`](docs/DHAN_UNOFFICIAL_ENDPOINTS.md).

### 1. Full Market Data — `fetch_dhan_data.py`
| Key | Value |
|---|---|
| **URL** | `https://ow-scanx-analytics.dhan.co/customscan/fetchdt` |
| **Method** | `POST` |
| **Page Size** | `count: 5000` (returns all ~2,775 in one call) |
| **Output** | `dhan_data_response.json` + `master_isin_map.json` |

```json
{
  "data": {
    "type": "full", "whichpage": "nse_total_market",
    "filters": [], "sort": "Mcap", "sorder": "desc",
    "count": 5000, "page": 1
  }
}
```

### 2. Fundamental Data (Results & Ratios) — `fetch_fundamental_data.py`
| Key | Value |
|---|---|
| **URL** | `https://open-web-scanx.dhan.co/scanx/fundamental` |
| **Method** | `POST` |
| **Pagination** | Per-ISIN (iterates `master_isin_map.json`) |
| **Timeout** | 30s |
| **Output** | `fundamental_data.json` (35 MB) |

The raw ScanX payload also contains dated `sHp` ownership rows.  The pipeline
publishes these separately as `shareholding_history.json.gz`: promoter, FII,
DII, public holding and shareholder count by provider reporting period.  It
records when the pipeline observed each row and does **not** infer a filing
date, so historical scanner snapshots cannot be rewritten with data first
seen later.

```json
{"data": {"isin": "<ISIN>"}}
```

### 3. Company Filings (Hybrid) — `fetch_company_filings.py`
Fetches from **TWO** endpoints and merges results for maximum coverage.

| Key | Value |
|---|---|
| **URL 1** | `https://ow-static-scanx.dhan.co/staticscanx/company_filings` |
| **URL 2** | `https://ow-static-scanx.dhan.co/staticscanx/lodr` |
| **Method** | `POST` |
| **Page Size** | `count: 100`; page 1 every refresh, remaining LODR pages once per symbol |
| **Threads** | 8 (bounded historical backfill) |
| **Dedup** | By `news_id` + `news_date` + `caption` |
| **Output** | `company_filings/{SYMBOL}_filings.json` |

```json
{"data": {"isin": "<ISIN>", "pg_no": 1, "count": 100}}
```

LODR returns `total_pages`. The first successful history fetch follows every
page and saves the merged metadata in `filing_history_data/`; subsequent daily
runs fetch only page 1 and merge new disclosures. `filing_history.json.gz` is
the published, durable ledger. It contains timestamps and filing metadata, not
invented financial values from attachment PDFs.

`quarterly_financial_history.json.gz` joins those real disclosure timestamps
to the provider's quarter-indexed numerical statements. Rows retain their
`CONSOLIDATED` or `STANDALONE` provenance; standalone results never fill a
missing consolidated result. The statement values are a current provider
observation, so strict point-in-time screens continue to require a snapshot
observed on or before the requested date.

### 4. Live Announcements — `fetch_new_announcements.py`
| Key | Value |
|---|---|
| **URL** | `https://ow-static-scanx.dhan.co/staticscanx/announcements` |
| **Method** | `POST` |
| **Threads** | 40 |
| **Output** | `all_company_announcements.json` |

```json
{"data": {"isin": "<ISIN>"}}
```

### 5. Advanced Indicators (Pivot, EMA, SMA) — `fetch_advanced_indicators.py`
| Key | Value |
|---|---|
| **URL** | `https://ow-static-scanx.dhan.co/staticscanx/indicator` |
| **Method** | `POST` |
| **Threads** | 50 |
| **Requires** | `Sid` (Security ID from `master_isin_map.json`) |
| **Output** | `advanced_indicator_data.json` (8.3 MB) |

```json
{
  "exchange": "NSE", "segment": "E",
  "security_id": "<Sid>", "isin": "<ISIN>",
  "symbol": "<SYMBOL>", "minute": "D"
}
```

### 6. Market News Feed — `fetch_market_news.py`
| Key | Value |
|---|---|
| **URL** | `https://news-live.dhan.co/v2/news/getLiveNews` |
| **Method** | `POST` |
| **Page Size** | `limit: 50` (per stock) |
| **Max Tested** | `limit: 100` works, pagination via `page_no` |
| **Threads** | 15 |
| **Output** | `market_news/{SYMBOL}_news.json` |

```json
{
  "categories": ["ALL"], "page_no": 0, "limit": 50,
  "first_news_timeStamp": 0, "last_news_timeStamp": 0,
  "news_feed_type": "live",
  "stock_list": ["<ISIN>"], "entity_id": ""
}
```

### 7. Corporate Actions — official NSE, with ScanX earnings fallback
| Key | Value |
|---|---|
| **Primary URL** | `https://www.nseindia.com/api/corporates-corporateActions` |
| **Primary range** | 2018 onward, with one-year forward event context |
| **Primary outputs** | `nse_corporate_actions.json`, `nse_corporate_action_adjustments.json` |
| **Fallback** | ScanX quarterly-result announcements only |
| **Fallback outputs** | `history_earnings_events.json`, `upcoming_earnings_events.json` |

The official ledger retains the NSE action subject, ISIN, ex-date, record-date,
and an explicit adjustment mode. A factor is published only for a parsed,
deterministic split, bonus, or consolidation; schemes and demergers stay marked
for manual review.

### 8. Surveillance Lists (ASM/GSM) — `fetch_surveillance_lists.py`
| Key | Value |
|---|---|
| **URL** | Google Sheets Gviz endpoint (fallback: Dhan Next.js API) |
| **Method** | `GET` |
| **Output** | `nse_asm_list.json`, `nse_gsm_list.json` |

### 9. Circuit Stocks — `fetch_circuit_stocks.py`
| Key | Value |
|---|---|
| **URL** | `https://ow-scanx-analytics.dhan.co/customscan/fetchdt` |
| **Method** | `POST` |
| **Page Size** | `count: 500` |
| **Output** | `upper_circuit_stocks.json`, `lower_circuit_stocks.json` |

### 10. Bulk/Block Deals — `fetch_bulk_block_deals.py`
| Key | Value |
|---|---|
| **URL** | `https://ow-static-scanx.dhan.co/staticscanx/deal` |
| **Method** | `POST` |
| **Page Size** | `pagecount: 50` (auto-paginates all pages) |
| **Output** | `bulk_block_deals.json` |

```json
{"data": {"defaultpage": "N", "pageno": 1, "pagecount": 50}}
```

### 11. Price Bands — `fetch_incremental_price_bands.py` / `fetch_complete_price_bands.py`
| Key | Value |
|---|---|
| **URL (Incremental)** | `https://nsearchives.nseindia.com/content/equities/eq_band_changes_{date}.csv` |
| **URL (Complete)** | `https://nsearchives.nseindia.com/content/equities/sec_list_{date}.csv` |
| **Method** | `GET` (CSV download) |
| **Output** | `incremental_price_bands.json`, `complete_price_bands.json` |

### 12. Historical OHLCV — `fetch_all_ohlcv.py`
| Key | Value |
|---|---|
| **URL** | `https://openweb-ticks.dhan.co/getDataH` |
| **Method** | `POST` |
| **Threads** | 15 |
| **Start** | Incremental; defaults to ~2 years when no local stock CSV exists |
| **Interval** | `D` (Daily candles) |
| **Output** | `ohlcv_data/{SYMBOL}.csv` |

```json
{
  "EXCH": "NSE", "SYM": "<SYMBOL>", "SEG": "E", "INST": "EQUITY",
  "SEC_ID": "<Sid>", "EXPCODE": 0,
  "INTERVAL": "D", "START": <INCREMENTAL_START>, "END": <CURRENT_TIMESTAMP>
}
```

---

## 📂 Standalone / Optional Scripts

| Script | URL | Output |
|---|---|---|
| `fetch_fno_data.py` | `customscan/fetchdt` (filter: `FnoFlag=1`, count: 500) | `fno_stocks_response.json` |
| `fetch_fno_lot_sizes.py` | `dhan.co/nse-fno-lot-size/` (Next.js data) | `fno_lot_sizes_cleaned.json` |
| `fetch_fno_expiry.py` | `dhan.co/_next/data/{buildId}/fno-expiry-calendar.json` | `fno_expiry_calendar.json` |
| `fetch_all_indices.py` | `customscan/fetchdt` (count: 500) | `all_indices_list.json` |
| `fetch_etf_data.py` | `customscan/fetchdt` (filter: `ETFFlag`, count: 1000) | `etf_data_response.json` |

> **Note**: `fetch_all_indices.py` is used by the default runner because index OHLCV and breadth calculations depend on it. ETF and standalone F&O scans remain optional.

---

## 🛠 Project Files

### Core Pipeline Scripts
| File | Role |
|---|---|
| `run_full_pipeline.py` | **Master Runner** — single command to produce everything |
| `fetch_dhan_data.py` | Fetches 2,775 stocks → `dhan_data_response.json` + `master_isin_map.json` |
| `fetch_fundamental_data.py` | Fetches quarterly results & ratios → `fundamental_data.json` |
| `fetch_company_filings.py` | Hybrid filing engine (LODR + Legacy) → `company_filings/` |
| `fetch_new_announcements.py` | Live corporate announcements → `all_company_announcements.json` |
| `fetch_advanced_indicators.py` | Pivot Points, EMA/SMA signals → `advanced_indicator_data.json` |
| `fetch_market_news.py` | AI-sentiment news (50/stock) → `market_news/` |
| `fetch_nse_corporate_actions.py` | Official NSE actions + deterministic adjustment factors |
| `fetch_corporate_actions.py` | ScanX quarterly-result-event fallback only |
| `fetch_surveillance_lists.py` | ASM/GSM lists → `nse_asm_list.json`, `nse_gsm_list.json` |
| `fetch_circuit_stocks.py` | Upper/Lower circuit → `upper/lower_circuit_stocks.json` |
| `fetch_bulk_block_deals.py` | Bulk/Block deals (30 days) → `bulk_block_deals.json` |
| `fetch_incremental_price_bands.py` | Daily price band changes → `incremental_price_bands.json` |
| `fetch_complete_price_bands.py` | All securities bands → `complete_price_bands.json` |
| `fetch_all_ohlcv.py` | Incremental stock OHLCV history → `ohlcv_data/` |
| `fetch_indices_ohlcv.py` | Incremental index OHLCV history → `indices_ohlcv_data/` |
| `bulk_market_analyzer.py` | Builds base `all_stocks_fundamental_analysis.json` |
| `advanced_metrics_processor.py` | Injects ADR, RVOL, ATH, Turnover |
| `process_earnings_performance.py` | Injects post-earnings returns |
| `enrich_fno_data.py` | Injects F&O flag, lot size, next expiry |
| `process_market_breadth.py` | Injects RS ratings and writes `sector_analytics.json` |
| `process_historical_market_breadth.py` | Writes historical breadth CSV data |
| `add_corporate_events.py` | Injects Event Markers, Announcements, News Feed (FINAL) |
| `single_stock_analyzer.py` | Utility to inspect a single stock |
| `pipeline_utils.py` | Shared paths, headers, JSON, gzip, and ScanX helpers |
| `nse_archive_utils.py` | Shared NSE archive CSV lookup/parsing helpers |
| `ohlcv_utils.py` | Shared OHLCV candle parsing and CSV read/write helpers |
| `src/edl_pipeline/runner.py` | Importable pipeline runner used by `run_full_pipeline.py` |
| `src/edl_pipeline/artifacts.py` | Stage script lists and generated artifact names |
| `src/edl_pipeline/config.py` | Environment-backed runtime configuration |
| `src/edl_pipeline/schemas.py` | Stable public output field names |
| `src/edl_pipeline/transforms/` | Modular transform implementations behind legacy wrappers |
| `src/edl_pipeline/sources/` | Source endpoint facades for future fetcher cleanup |

### Standalone Scripts
| File | Role |
|---|---|
| `fetch_fno_data.py` | 207 F&O stocks |
| `fetch_fno_lot_sizes.py` | F&O lot sizes |
| `fetch_fno_expiry.py` | Expiry calendar |
| `fetch_etf_data.py` | ETF scan |

---

## 📊 Output Field Reference (`all_stocks_fundamental_analysis.json`)

**The published artifact uses Scanner Schema v3. Counts can change as Dhan/NSE source coverage changes.**

The pipeline now publishes only the canonical Scanner Schema v3 artifact.
Legacy display labels below exist only in the transient internal file before the
final standardization stage; they are never present in the published JSON or
gzip artifact.

### Scanner Schema v3

The scanner uses normalized snake_case keys instead of parsing display strings.
Direct ScanX dashboard fields include `exchange`, `instrument`, `segment`,
`close`, `open`, `high`, `low`, `volume`, `change_percent`,
`market_cap_crore`, `shares_outstanding`, `share_capital`, `sector`,
`perf_1w`, `perf_1m`, `perf_3m`, `perf_6m`, `perf_12m`, `sma10`, `sma20`,
`sma50`, `sma200`, and `rsi14`. `shares_outstanding` is the ScanX
`TotalShares` value, not a market-cap-derived estimate. `share_capital` is
preserved exactly as supplied by ScanX until its unit is independently
documented.

The fundamental endpoint supplies `industry` and ownership percentages.
`rupee_volume` is calculated from close and volume; `free_float_percent` is
the non-promoter ownership percentage; and `float_shares` is calculated from
`shares_outstanding × free_float_percent`.

The OHLCV stage calculates `avg_volume_20`, `avg_rupee_volume_20`,
`relative_volume_20`, `atr14`, `atr_percent_14`, `adr20`, `adr_percent_20`,
and the boolean scan signals for moving-average relationships, candles,
breakouts, 52-week highs, NR7, inside days, and bullish engulfing patterns.
Fields requiring insufficient price history are written as `null`.

Relative-strength ratings and industry RS ranks are not generated. Sector and
industry analytics contain only moving-average and 52-week-high breadth.

### 1. Identity & Classification
`Symbol`, `Name`, `Listing Date`, `Basic Industry`, `Sector`, `Index`

### 2. Fundamentals (Quarterly)
`Latest Quarter`, `Net Profit Latest/Previous/2Q/3Q/LastYr Quarter`, `EPS Latest/Previous/2Q/3Q/LastYr Quarter`, `Sales Latest/Previous/2Q/3Q/LastYr Quarter`, `OPM Latest/Previous/2Q/3Q/LastYr Quarter`, `QoQ %` and `YoY %` for all, `Sales Growth 5 Years(%)`

### 3. Valuation Ratios
`Market Cap(Cr.)`, `Stock Price(₹)`, `P/E`, `Forward P/E`, `Historical P/E 5`, `PEG`, `ROE(%)`, `ROCE(%)`, `D/E`, `OPM TTM(%)`, `EPS Last Year`, `EPS 2 Years Back`

### 4. Ownership & Float
`FII % change QoQ`, `DII % change QoQ`, `Free Float(%)`, `Float Shares(Cr.)`

### 5. Technical Indicators
| Field | Example |
|---|---|
| `RSI (14)` | `62.5` |
| `SMA Status` | `SMA 20: Above (4.9%) \| SMA 50: Above (24.1%)` |
| `EMA Status` | `EMA 20: Above (6.3%) \| EMA 200: Above (72.6%)` |
| `Technical Sentiment` | `RSI: Neutral \| MACD: Bearish` |
| `Pivot Point` | `245.50` |

### 6. Price Performance
| Field | Description |
|---|---|
| `1 Day/Week/Month/3M/6M/1Y Returns(%)` | Period returns |
| `% from 52W High` | Distance from 52-week peak |
| `% from 52W Low` | Distance from 52-week bottom |
| `% from ATH` | Distance from All-Time High |
| `Gap Up %` | Today's gap |
| `Day Range(%)` | Intraday high-low spread |

### 7. Volume & Liquidity
| Field | Description |
|---|---|
| `RVOL` | Relative Volume (vs 20-day avg) |
| `200 Days EMA Volume` | Long-term volume trend |
| `% from 52W High 200 Days EMA Volume` | Volume trend vs peak |
| `Daily Rupee Turnover 20/50/100(Cr.)` | Turnover moving averages |
| `30 Days Average Rupee Volume(Cr.)` | Monthly volume |

### 8. Volatility
`5/14/20/30 Days MA ADR(%)` — Average Daily Range over different periods.

### 9. Circuit & Price Bands
`Circuit Limit` — Current circuit limit band (e.g., `20%`).

### 10. Earnings Tracking
| Field | Description |
|---|---|
| `Quarterly Results Date` | Date of the latest financial results filing |
| `Returns since Earnings(%)` | % change from pre-earnings close to current price |
| `Max Returns since Earnings(%)` | Peak % gain since results day |

### 11. Event Markers (`Event Markers` field)
| Icon | Name | Trigger |
|---|---|---|
| **★: LTASM / STASM** | Surveillance | Stock in ASM groups |
| **📊: Results Recently Out** | Results | Results released in last 7 days |
| **🔑: Insider Trading** | Insider | SEBI Reg 7(2) / Form C in last 15 days |
| **📦: Block Deal** | Deals | Bulk/Block deal in last 7 days |
| **#: +/- Revision** | Circuit | Price band revision detected |
| **⏰: Results (DD-Mon)** | Upcoming | Results upcoming (with date) |
| **🎁: Bonus (DD-Mon)** | Bonus | Upcoming bonus (with date) |
| **✂️: Split (DD-Mon)** | Split | Upcoming split (with date) |
| **💸: Dividend (DD-Mon)** | Dividend | Upcoming dividend (with date) |
| **📈: Rights (DD-Mon)** | Rights | Upcoming rights issue (with date) |

### 12. Recent Announcements (Regulatory)
`Recent Announcements` — Top 5 regulatory filings with `Date`, `Headline`, `URL` (PDF link).

### 13. News Feed (Media)
`News Feed` — Top 5 real-time news items with `Title`, `Sentiment` (positive/negative/neutral), `Date`.

---
**Note**: This folder is part of the EDL Pipeline. **DO NOT DELETE**.
# Publication safety

The public entrypoint now stages each refresh, validates the complete output set,
and preserves the last published dataset on failure. See
[Pipeline integrity](docs/PIPELINE_INTEGRITY.md) for coverage gates, freshness
limits, per-symbol availability, and the intentional zero-to-null corrections.

The upcoming-results calendar is fetched by `fetch_earnings_calendar.py` from
`https://www.nexusjournal.co.in/data/earnings-calendar.json`. Its records are
mapped to canonical NSE EQ symbols and published through the existing
`earnings_calendar.json.gz` / `earnings-calendar.json.gz` artifacts. Dates are
labelled as scheduled results, rather than assumed board-meeting dates. ScanX
fills missing symbols; a failed fetch retains the previous calendar and records
`available: false` plus the fetch error. There are no direct BSE calendar API
requests or ScraperAPI credentials required for this source.
