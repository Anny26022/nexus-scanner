# 5-Year Historical Snapshot Backfill & Architecture Guide

## 1. Overview
Nexus Scanner supports point-in-time historical screening up to 5 years into the past (e.g., 2021–2026). This document details how historical daily snapshots are accumulated, what data is available from official exchange sources vs. what is ephemeral, and how the production engine operates.

---

## 2. Point-in-Time Data Feasibility Matrix

| Data Dimension | Coverage Back to 5 Years | Official Data Source | Implementation Method |
| :--- | :---: | :--- | :--- |
| **OHLCV Price Data** | **100% Available** | NSE Bhavcopy Archives (`cm{date}bhav.csv.zip`) & EOD2 | Vectorized slice from `.scanner_cache/history.npz` |
| **Technical Indicators (SMA, EMA, RSI)** | **100% Available** | Derived from historical OHLCV | Mathematical calculation on price history |
| **Volume & Turnover** | **100% Available** | NSE Historical Bhavcopies | Extracted directly from exchange traded quantities |
| **Delivery Percentage & Deliverable Qty** | **100% Available** | `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date}.csv` | Fetched daily from NSE static archive |
| **Market Breadth (% > 20/50/200 DMA)** | **100% Available** | Computed across active universe | Calculated cross-sectionally for every session |
| **Shareholding Patterns (Promoter/FII/DII)** | **100% Available** | `shareholding_history.json.gz` (NSE/ScanX 2006–2026) | Point-in-time join matching `period_end <= session_date` |
| **Quarterly Financial Statements** | **Available from 2020+** | `quarterly_financial_history.json.gz` (55,945 filings) | Point-in-time join matching `filing_date <= session_date` |
| **F&O Ban List** | **Reconstructable** | `fo{date}bhav.csv.zip` Open Interest archives | Recomputed via MWPL (Open Interest > 95% threshold) |
| **Surveillance Lists (ASM / GSM)** | **Ephemeral (Null)** | Circular PDFs (Not archived statically by NSE) | Defaulted to `null` with completeness badge |

---

## 3. Backfill Execution Engine

The production script [`tools/generate_historical_snapshots.py`](../tools/generate_historical_snapshots.py) reconstructs point-in-time snapshots for any custom date range.

### Command Line Usage:
```bash
# Generate snapshots for a specific date range (e.g., October 2021)
python3 tools/generate_historical_snapshots.py \
  --pipeline-dir "DO NOT DELETE EDL PIPELINE" \
  --output-dir "outputs/historical_snapshots" \
  --start-date 2021-10-01 \
  --end-date 2021-10-15

# Dry run to verify date range without generating files
python3 tools/generate_historical_snapshots.py --dry-run
```

### Performance Benchmark:
- **Loading Universe & 7.2M Candles**: ~1.4 seconds.
- **Per-Session Snapshot Generation**: **~0.5 to 0.6 seconds** per trading day.
- **5-Year Full Backfill (~1,250 trading days)**: **~10 to 12 minutes** total run time.
- **Compressed Storage Footprint**: ~265 KB per daily snapshot $\times$ 1,250 days $\approx$ **~330 MB to 600 MB** total storage.

---

## 4. Cloudflare R2 Distribution & Serving

Historical snapshots follow the storage hierarchy:
```
r2://nexus-snapshots/history/{YYYY}/{YYYY-MM-DD}.json.gz
```
- Snapshots are served via Cloudflare Workers with immutable HTTP `Cache-Control: public, max-age=31536000, immutable` headers.
- Since past historical snapshots never change, CDN cache hit ratios reach **>99%**, resulting in **~4ms** response times for historical backtests.
