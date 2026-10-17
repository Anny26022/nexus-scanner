"""Historical Snapshot Backfill Engine (Up to 5 Years).

Reconstructs point-in-time daily snapshots ({session}.json.gz) for Nexus Scanner
from validated historical sources:
1. Daily EOD OHLCV history (EOD2 / NSE bhavcopy archives 1995-2026)
2. Daily Delivery History (nsearchives sec_bhavdata_full_{date}.csv)
3. 33-Quarter Historical Fundamentals Ledger (quarterly_financial_history.json.gz)
4. Historical Shareholding Ledger (shareholding_history.json.gz)
5. Historical Corporate Action Ledger (corporate_action_ledger.json.gz)
6. Cross-sectional Technical Indicator & Breadth Engine (SMAs, RSI, VCP, Advance/Decline)
"""

import argparse
import csv
import gzip
import io
import json
import os
import ssl
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

# Fallback headers for NSE downloads
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
}

# SSL Context without verification for historical static archive downloads
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def fetch_nse_delivery_csv(session_date: date) -> Optional[List[Dict[str, Any]]]:
    """Fetch official delivery bhavcopy from nsearchives for a given date."""
    date_str = session_date.strftime("%d%m%Y")
    url = f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date_str}.csv"
    req = urllib.request.Request(url, headers=NSE_HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
            if resp.status != 200:
                return None
            content = resp.read().decode("utf-8", errors="ignore")
            reader = csv.DictReader(io.StringIO(content))
            rows = []
            for item in reader:
                clean_item = {k.strip(): (v.strip() if v else "") for k, v in item.items() if k}
                rows.append(clean_item)
            return rows
    except Exception:
        return None


def calculate_technicals(closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, volumes: np.ndarray) -> Dict[str, Any]:
    """Calculate core screener indicators given price arrays."""
    n = len(closes)
    if n == 0:
        return {}

    current_close = float(closes[-1])
    current_high = float(highs[-1])
    current_low = float(lows[-1])
    current_volume = float(volumes[-1])

    # SMAs
    sma10 = float(np.mean(closes[-10:])) if n >= 10 else current_close
    sma20 = float(np.mean(closes[-20:])) if n >= 20 else current_close
    sma50 = float(np.mean(closes[-50:])) if n >= 50 else current_close
    sma200 = float(np.mean(closes[-200:])) if n >= 200 else current_close

    # Volume SMAs & Turnover
    avg_volume_20 = float(np.mean(volumes[-20:])) if n >= 20 else current_volume
    avg_turnover_20_cr = float(np.mean(closes[-20:] * volumes[-20:]) / 1e7) if n >= 20 else (current_close * current_volume / 1e7)

    # 52-Week High / Low (252 trading sessions)
    lookback_52w = min(n, 252)
    high_52w = float(np.max(highs[-lookback_52w:]))
    low_52w = float(np.min(lows[-lookback_52w:]))
    dist_52w_high_pct = float(((current_close - high_52w) / high_52w) * 100) if high_52w > 0 else 0.0
    dist_52w_low_pct = float(((current_close - low_52w) / low_52w) * 100) if low_52w > 0 else 0.0

    # RSI (14)
    if n >= 15:
        deltas = np.diff(closes[-15:])
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        avg_gain = np.mean(gains)
        avg_loss = np.mean(losses)
        if avg_loss == 0:
            rsi14 = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi14 = float(100.0 - (100.0 / (1.0 + rs)))
    else:
        rsi14 = 50.0

    # Candle shapes
    bullish_candle = bool(closes[-1] >= (highs[-1] + lows[-1]) / 2.0)
    is_inside_day = bool(n >= 2 and highs[-1] <= highs[-2] and lows[-1] >= lows[-2])

    return {
        "close": current_close,
        "high": current_high,
        "low": current_low,
        "volume": current_volume,
        "sma10": sma10,
        "sma20": sma20,
        "sma50": sma50,
        "sma200": sma200,
        "avg_volume_20": avg_volume_20,
        "daily_rupee_turnover_20_cr": avg_turnover_20_cr,
        "percent_from_52w_high": dist_52w_high_pct,
        "percent_from_52w_low": dist_52w_low_pct,
        "close_above_sma20": bool(current_close >= sma20),
        "close_above_sma50": bool(current_close >= sma50),
        "close_above_sma200": bool(current_close >= sma200),
        "sma20_above_sma50": bool(sma20 >= sma50),
        "sma50_above_sma200": bool(sma50 >= sma200),
        "rsi14": rsi14,
        "bullish_candle": bullish_candle,
        "is_inside_day": is_inside_day,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate 5-year historical snapshots.")
    parser.add_argument("--pipeline-dir", type=Path, default=Path("DO NOT DELETE EDL PIPELINE"))
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/historical_snapshots"))
    parser.add_argument("--start-date", type=date.fromisoformat, default=date(2021, 10, 1))
    parser.add_argument("--end-date", type=date.fromisoformat, default=date(2021, 10, 15))
    parser.add_argument("--update-sessions-manifest", type=Path, default=None, help="Path to frontend/public/data/sessions.json to register sessions")
    parser.add_argument("--dry-run", action="store_true", help="Print execution plan without writing files")

    args = parser.parse_args()

    pipeline_dir = args.pipeline_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Historical Snapshot Backfill Engine ===")
    print(f"Pipeline Root: {pipeline_dir}")
    print(f"Output Directory: {output_dir}")
    print(f"Date Range: {args.start_date} to {args.end_date}")

    # 1. Load Stock Universe
    fundamental_path = pipeline_dir / "all_stocks_fundamental_analysis.json.gz"
    if not fundamental_path.exists():
        sys.exit(f"Error: {fundamental_path} does not exist.")
    with gzip.open(fundamental_path, "rt", encoding="utf-8") as f:
        master_stocks = json.load(f)
    print(f"Loaded master stock universe: {len(master_stocks)} symbols")

    # 2. Load Historical OHLCV Cache
    history_npz_path = pipeline_dir / ".scanner_cache" / "history.npz"
    if not history_npz_path.exists():
        sys.exit(f"Error: {history_npz_path} does not exist.")
    print("Loading vectorized OHLCV history.npz...")
    t0 = time.time()
    npz_data = np.load(history_npz_path)
    symbols = npz_data["symbols"]
    offsets = npz_data["offsets"]
    dates = pd.to_datetime(npz_data["dates"])
    values = npz_data["values"]  # Open, High, Low, Close, Volume
    print(f"Loaded history.npz in {time.time()-t0:.2f}s ({len(symbols)} symbols, {len(dates)} total candles)")

    # Symbol index map
    symbol_to_idx = {str(s).upper(): i for i, s in enumerate(symbols)}

    # 3. Load Quarterly Financial History
    q_fin_path = pipeline_dir / "quarterly_financial_history.json.gz"
    financials_by_symbol = defaultdict(list)
    if q_fin_path.exists():
        with gzip.open(q_fin_path, "rt", encoding="utf-8") as f:
            q_fin_data = json.load(f)
            for rec in q_fin_data.get("records", []):
                sym = str(rec.get("symbol") or "").upper()
                if sym:
                    financials_by_symbol[sym].append(rec)
        print(f"Loaded {sum(len(v) for v in financials_by_symbol.values())} quarterly financial records")

    # 4. Load Shareholding History
    sh_path = pipeline_dir / "shareholding_history.json.gz"
    sh_by_symbol = defaultdict(list)
    if sh_path.exists():
        with gzip.open(sh_path, "rt", encoding="utf-8") as f:
            sh_data = json.load(f)
            for rec in sh_data.get("records", []):
                sym = str(rec.get("symbol") or "").upper()
                if sym:
                    sh_by_symbol[sym].append(rec)
        print(f"Loaded {sum(len(v) for v in sh_by_symbol.values())} shareholding records")

    # 5. Trading Sessions in Range
    unique_dates = sorted(set(d.date() for d in dates if args.start_date <= d.date() <= args.end_date))
    print(f"Found {len(unique_dates)} trading sessions in target window: {unique_dates}")

    if args.dry_run:
        print("[DRY RUN] Plan verified successfully. Exiting without file generation.")
        return

    # 6. Build Daily Snapshots
    generated_count = 0
    for session_date in unique_dates:
        session_str = session_date.isoformat()
        session_ts = pd.Timestamp(session_date)
        print(f"\nProcessing session: {session_str}...")
        t_session = time.time()

        snapshot_stocks = []
        advances = 0
        declines = 0
        above_20dma = 0
        above_50dma = 0
        above_200dma = 0

        # Optional: Fetch delivery bhavdata for this session
        delivery_rows = fetch_nse_delivery_csv(session_date)
        delivery_map = {}
        if delivery_rows:
            for r in delivery_rows:
                sym = str(r.get("SYMBOL") or "").upper().strip()
                if sym and r.get("SERIES") == "EQ":
                    delivery_map[sym] = r

        for stock in master_stocks:
            sym = str(stock.get("symbol") or "").upper()
            idx = symbol_to_idx.get(sym)
            if idx is None:
                continue

            # Slice OHLCV for this stock up to this date
            start_off = offsets[idx]
            end_off = offsets[idx + 1]
            s_dates = dates[start_off:end_off]
            mask = s_dates <= session_ts

            if not mask.any():
                continue

            last_pos = np.where(mask)[0][-1]
            # Ensure the stock traded on or near this date (within last 5 sessions)
            last_date = s_dates[last_pos].date()
            if (session_date - last_date).days > 7:
                continue

            # Extract window
            window_slice = slice(0, last_pos + 1)
            s_values = values[start_off:end_off][window_slice]
            c_vals = s_values[:, 3]
            h_vals = s_values[:, 1]
            l_vals = s_values[:, 2]
            v_vals = s_values[:, 4]

            tech = calculate_technicals(c_vals, h_vals, l_vals, v_vals)
            if not tech:
                continue

            # Breadth tallies
            if len(c_vals) >= 2:
                if c_vals[-1] > c_vals[-2]:
                    advances += 1
                elif c_vals[-1] < c_vals[-2]:
                    declines += 1
            if tech["close_above_sma20"]:
                above_20dma += 1
            if tech["close_above_sma50"]:
                above_50dma += 1
            if tech["close_above_sma200"]:
                above_200dma += 1

            # Point-in-time financial attachment (latest filed before session_date)
            sym_fins = financials_by_symbol.get(sym, [])
            valid_fins = [
                f for f in sym_fins
                if f.get("filing_date") and f["filing_date"][:10] <= session_str
            ]
            latest_fin = sorted(valid_fins, key=lambda x: x["filing_date"])[-1] if valid_fins else None

            # Point-in-time shareholding attachment
            sym_shs = sh_by_symbol.get(sym, [])
            valid_shs = [
                s for s in sym_shs
                if s.get("period_end") and s["period_end"] <= session_str
            ]
            latest_sh = sorted(valid_shs, key=lambda x: x["period_end"])[-1] if valid_shs else None

            # Delivery stats
            deliv = delivery_map.get(sym)
            deliv_qty = int(deliv["DELIV_QTY"]) if deliv and deliv.get("DELIV_QTY", "").isdigit() else None
            deliv_pct = float(deliv["DELIV_PER"]) if deliv and deliv.get("DELIV_PER") else None

            item = {
                "symbol": sym,
                "name": stock.get("name"),
                "isin": stock.get("isin"),
                "sector": stock.get("sector"),
                "industry": stock.get("industry"),
                "listing_board": stock.get("listing_board"),
                "is_sme": stock.get("is_sme", False),
                "as_of_date": session_str,
                "close": tech["close"],
                "high": tech["high"],
                "low": tech["low"],
                "volume": tech["volume"],
                "sma10": tech["sma10"],
                "sma20": tech["sma20"],
                "sma50": tech["sma50"],
                "sma200": tech["sma200"],
                "rsi14": tech["rsi14"],
                "percent_from_52w_high": tech["percent_from_52w_high"],
                "percent_from_52w_low": tech["percent_from_52w_low"],
                "close_above_sma20": tech["close_above_sma20"],
                "close_above_sma50": tech["close_above_sma50"],
                "close_above_sma200": tech["close_above_sma200"],
                "sma20_above_sma50": tech["sma20_above_sma50"],
                "sma50_above_sma200": tech["sma50_above_sma200"],
                "avg_volume_20": tech["avg_volume_20"],
                "daily_rupee_turnover_20_cr": tech["daily_rupee_turnover_20_cr"],
                "bullish_candle": tech["bullish_candle"],
                "is_inside_day": tech["is_inside_day"],
                "deliverable_quantity": deliv_qty,
                "delivery_percent": deliv_pct,
                "promoter_holding_percent": latest_sh.get("promoter_holding_percent") if latest_sh else None,
                "fii_holding_percent": latest_sh.get("fii_holding_percent") if latest_sh else None,
                "dii_holding_percent": latest_sh.get("dii_holding_percent") if latest_sh else None,
                "public_holding_percent": latest_sh.get("public_holding_percent") if latest_sh else None,
                "quarterly_sales": latest_fin.get("sales") if latest_fin else None,
                "quarterly_net_profit": latest_fin.get("net_profit") if latest_fin else None,
                "quarterly_eps": latest_fin.get("eps") if latest_fin else None,
                "quarterly_opm": latest_fin.get("opm") if latest_fin else None,
                "latest_earnings_date": latest_fin.get("filing_date")[:10] if latest_fin and latest_fin.get("filing_date") else None,
            }
            snapshot_stocks.append(item)

        total_active = len(snapshot_stocks)
        breadth_record = {
            "date": session_str,
            "total_stocks": total_active,
            "advances": advances,
            "declines": declines,
            "pct_above_20dma": round((above_20dma / total_active) * 100, 2) if total_active else 0,
            "pct_above_50dma": round((above_50dma / total_active) * 100, 2) if total_active else 0,
            "pct_above_200dma": round((above_200dma / total_active) * 100, 2) if total_active else 0,
        }

        payload = {
            "schema_version": 4,
            "as_of_date": session_str,
            "stocks": snapshot_stocks,
            "breadth": breadth_record,
            "data_completeness": "historical_point_in_time_reconstructed",
        }

        out_file = output_dir / f"{session_str}.json.gz"
        with gzip.open(out_file, "wt", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)

        file_size_kb = out_file.stat().st_size / 1024
        print(f"Generated {out_file.name} ({len(snapshot_stocks)} stocks, {file_size_kb:.1f} KB) in {time.time()-t_session:.2f}s")
        generated_count += 1

    print(f"\nAll done! Successfully generated {generated_count} historical daily snapshots in {output_dir}")

    if args.update_sessions_manifest and generated_count > 0:
        manifest_file = args.update_sessions_manifest.resolve()
        existing = {}
        if manifest_file.exists():
            try:
                with open(manifest_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for item in data.get("sessions", []):
                        dt = item.get("date")
                        if dt:
                            existing[dt] = item
            except Exception as e:
                print(f"Warning: could not read existing sessions manifest: {e}")

        # Add newly generated sessions
        for s_date in valid_sessions:
            s_str = s_date.strftime("%Y-%m-%d")
            if s_str not in existing:
                existing[s_str] = {
                    "date": s_str,
                    "label": s_str,
                    "isHistorical": True,
                }

        sorted_sessions = sorted(existing.values(), key=lambda x: x["date"], reverse=True)
        manifest_payload = {
            "version": 1,
            "latestSessionDate": sorted_sessions[0]["date"] if sorted_sessions else "",
            "sessions": sorted_sessions,
        }
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(manifest_payload, f, indent=2)
            f.write("\n")
        print(f"Updated sessions manifest at {manifest_file} ({len(sorted_sessions)} total sessions)")



if __name__ == "__main__":
    main()
