# 5-Year Historical Snapshot Backfill & Architecture Guide

## 1. Overview
Nexus Scanner supports point-in-time historical screening up to 5 years into the past (e.g., 2021–2026). This document details how historical daily snapshots are accumulated, what data is available from official exchange sources vs. what is ephemeral, and how the production engine operates.

---

## 2. Point-in-Time Data Feasibility Matrix

| Data Dimension | Coverage Back to 5 Years | Official Data Source | Implementation Method & Caveats |
| :--- | :---: | :--- | :--- |
| **OHLCV Price Data** | **100% Available** | NSE Bhavcopy Archives (`cm{date}bhav.csv.zip`) & EOD2 | Vectorized slice from `.scanner_cache/history.npz` |
| **Technical Indicators (SMA, EMA, RSI)** | **100% Available** | Derived from historical OHLCV | Mathematical calculation on price history |
| **Volume & Turnover** | **100% Available** | NSE Historical Bhavcopies | Extracted directly from exchange traded quantities |
| **Delivery Percentage & Deliverable Qty** | **100% Available** | `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date}.csv` | Fetched daily from NSE static archive with local disk caching |
| **Market Breadth (% > 20/50/200 DMA)** | **100% Available** | Computed across active universe | Calculated cross-sectionally for every session |
| **Shareholding Patterns (Promoter/FII/DII)** | **Qualified (Null for 2021–2025)** | `shareholding_history.json.gz` | Strictly enforced `observed_on <= session_date`. As current ledger entries were first observed in Oct 2026, historical holdings prior to observation remain null |
| **Quarterly Financial Statements** | **Available from 2021-10+** | `quarterly_financial_history.json.gz` (55,945 filings) | Point-in-time join matching `filing_date <= session_date` |
| **F&O Eligibility & Ban List** | **Unavailable (Null)** | NSE replaces lists daily | Marked `null` / unavailable to avoid lookahead and false assumptions |
| **Surveillance Lists (ASM / GSM)** | **Reconstructed where circulars exist** | Official NSE circulars & price bands | Extracted from daily circulars and price band archives; null if incomplete |
| **Stock Universe Survivorship** | **Survivorship-Biased** | Current master stock universe | Snapshots include today's surviving companies; historically delisted or merged securities are omitted |

---

## 3. Rebuild and publish historical sessions

After merging the screener and backfill changes, run **Backfill Historical Snapshots**
on `main`. Choose the date range and enable **Upload generated snapshots to Cloudflare R2**.
The workflow regenerates existing dates using the shared RS/setup calculations, verifies
R2 readbacks, then commits the updated session pointers for frontend deployment.

The command-line equivalent requires the existing R2 credentials:

```bash
python3 tools/backfill_historical_snapshots.py \
  --start-date 2021-10-01 --end-date 2021-12-31 --upload-r2
```

Omit `--upload-r2` to generate preview artifacts without changing R2 or session pointers.
Add `--dry-run` to inspect the plan without writing files or contacting R2.
The command reuses `generate_historical_snapshots.py`; it does not maintain a second
calculation engine or modify frozen backend revisions.

Run large date ranges in chunks to stay within the workflow timeout and exchange archive
rate limits. The restored OHLCV cache must cover the requested sessions; the backfill does
not invent missing prices, historical universe membership, or financial disclosures.

## 4. Cloudflare R2 distribution

New historical objects use immutable revision paths:

```text
r2://nexus-screener-chart-data/snapshots/{YYYY-MM-DD}/{revision}.json.gz
```

Each payload records its RS methodology and coverage limits. The selected historical date
stays the same when its calculation changes; its revision changes. All uploads must pass
full-byte readback verification before `sessions.json` is updated. Failed runs leave the
published pointers unchanged, and objects from earlier revisions remain readable.

The browser requests the selected revision's object. Only a 404 falls back to the legacy
`snapshots/{date}.json.gz?v={revision}` location; revision/session mismatches remain errors.
Session pointers revalidate, while revision objects can be cached as immutable.
