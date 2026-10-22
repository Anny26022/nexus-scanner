# 5-Year Historical Snapshot Backfill & Architecture Guide

## 1. Overview
Nexus Scanner supports point-in-time historical screening up to 5 years into the past (e.g., 2021–2026). This document details how historical daily snapshots are accumulated, what data is available from official exchange sources vs. what is ephemeral, and how the production engine operates.

Daily publication uploads and verifies one immutable scanner archive per session at `snapshots/YYYY-MM-DD.json.gz`, then registers it in `frontend/public/data/sessions.json`. Different dates have separate files; reruns preserve the original archived date and revision while the latest release can still advance. Daily/weekly refreshes and backfills share a workflow queue to avoid losing session entries.

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

## 3. Backfill Execution Engine

The production script [`tools/generate_historical_snapshots.py`](../tools/generate_historical_snapshots.py) reconstructs point-in-time snapshots for any custom date range.

### Command Line Usage:
```bash
# Generate snapshots for a specific date range (e.g., Q4 2021)
python3 tools/generate_historical_snapshots.py \
  --pipeline-dir "DO NOT DELETE EDL PIPELINE" \
  --output-dir "outputs/historical_snapshots" \
  --start-date 2021-10-01 \
  --end-date 2021-12-31

# Dry run to verify date range without generating files
python3 tools/generate_historical_snapshots.py --dry-run
```

### Performance & Chunking Guidance:
- **Cached Execution**: **~0.6 seconds** per trading session once Bhavcopy and Price Band files are cached in `.scanner_cache/historical_downloads/`.
- **Uncached Network Execution**: **~2.5 seconds** per trading session (due to sequential NSE archive downloads).
- **Execution Strategy**: Rather than attempting all 1,250 days (~5 years) in a single GitHub Actions run, backfill jobs should be executed in quarterly or yearly chunks (e.g. 60–250 sessions per workflow run). This prevents network rate limiting from NSE archives and keeps individual runs within 3–10 minutes.
- **Compressed Storage Footprint**: ~400–460 KB per daily snapshot $\times$ 1,250 days $\approx$ **~500 MB** total storage on Cloudflare R2.

---

## 4. Cloudflare R2 Distribution & Serving

Historical snapshots follow the storage hierarchy:
```
r2://nexus-snapshots/history/{YYYY}/{YYYY-MM-DD}.json.gz
```
- Snapshots are served via Cloudflare Workers with immutable HTTP `Cache-Control: public, max-age=31536000, immutable` headers.
- Since past historical snapshots never change, CDN cache hit ratios reach **>99%**, resulting in **~4ms** response times for historical backtests.
