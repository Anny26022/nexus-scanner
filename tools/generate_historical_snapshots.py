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
import hashlib
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

# Add frontend to sys.path for scanner_bridge
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if str(FRONTEND_DIR) not in sys.path:
    sys.path.insert(0, str(FRONTEND_DIR))
import scanner_bridge as bridge

# Add pipeline directory to sys.path for shared RS and setup engines
PIPELINE_DIR = Path(__file__).resolve().parent.parent / "DO NOT DELETE EDL PIPELINE"
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

try:
    from build_rs_ratings import (
        compute_stock_returns,
        calculate_composite_score,
        percentile_rank,
        check_rs_line_52w_high,
        FRONT_WEIGHTED_BENCHMARK_FILENAME,
    )
    from build_market_screens import (
        calculate_atr_series,
        detect_vcp,
        detect_darvas,
        detect_flags,
        detect_cup_with_handle,
        detect_tight_weeks,
        evaluate_minervini_trend,
        evaluate_weinstein_stage,
    )
except ImportError:
    compute_stock_returns = None
    calculate_composite_score = None
    percentile_rank = None
    check_rs_line_52w_high = None
    FRONT_WEIGHTED_BENCHMARK_FILENAME = "NIFTY_500.csv"
    calculate_atr_series = None
    detect_vcp = None
    detect_darvas = None
    detect_flags = None
    detect_cup_with_handle = None
    detect_tight_weeks = None
    evaluate_minervini_trend = None
    evaluate_weinstein_stage = None

# Fallback headers for NSE downloads
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
}

# SSL Context without verification for historical static archive downloads
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def fetch_nse_delivery_csv(session_date: date, cache_dir: Optional[Path] = None) -> Optional[List[Dict[str, Any]]]:
    """Fetch official delivery bhavcopy from nsearchives for a given date, with disk caching."""
    date_str = session_date.strftime("%d%m%Y")
    cached_file = cache_dir / f"sec_bhavdata_full_{date_str}.csv" if cache_dir else None
    if cached_file and cached_file.exists():
        try:
            with open(cached_file, "r", encoding="utf-8", errors="ignore") as f:
                reader = csv.DictReader(f)
                return [{k.strip(): (v.strip() if v else "") for k, v in item.items() if k} for item in reader]
        except Exception:
            pass

    url = f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date_str}.csv"
    req = urllib.request.Request(url, headers=NSE_HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
            if resp.status != 200:
                return None
            content = resp.read().decode("utf-8", errors="ignore")
            if cached_file:
                try:
                    cached_file.parent.mkdir(parents=True, exist_ok=True)
                    cached_file.write_text(content, encoding="utf-8")
                except Exception:
                    pass
            reader = csv.DictReader(io.StringIO(content))
            rows = []
            for item in reader:
                clean_item = {k.strip(): (v.strip() if v else "") for k, v in item.items() if k}
                rows.append(clean_item)
            return rows
    except Exception:
        return None


def fetch_nse_price_bands(session_date: date, cache_dir: Optional[Path] = None) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Fetch official daily price bands and GSM remarks from nsearchives sec_list_{date}.csv, with disk caching."""
    date_str = session_date.strftime("%d%m%Y")
    cached_file = cache_dir / f"sec_list_{date_str}.csv" if cache_dir else None
    content = None
    if cached_file and cached_file.exists():
        try:
            content = cached_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            pass

    if content is None:
        url = f"https://nsearchives.nseindia.com/content/equities/sec_list_{date_str}.csv"
        req = urllib.request.Request(url, headers=NSE_HEADERS)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
                if resp.status == 200:
                    content = resp.read().decode("utf-8", errors="ignore")
                    if cached_file:
                        try:
                            cached_file.parent.mkdir(parents=True, exist_ok=True)
                            cached_file.write_text(content, encoding="utf-8")
                        except Exception:
                            pass
        except Exception:
            pass

    band_map = {}
    gsm_remarks = {}
    if content:
        reader = csv.reader(io.StringIO(content))
        header = next(reader, None)
        if header:
            for row in reader:
                if len(row) >= 4:
                    sym = row[0].strip().upper()
                    band = row[3].strip()
                    if sym:
                        band_map[sym] = band if band and band != "-" else "No Band"
                if len(row) >= 5:
                    sym = row[0].strip().upper()
                    remark = row[4].strip().upper()
                    if sym and "GSM" in remark:
                        stage = remark.split("STAGE")[-1].replace("-", "").strip() or "I"
                        gsm_remarks[sym] = stage
    return band_map, gsm_remarks


def fetch_nse_surveillance_for_date(session_date: date, cache_dir: Optional[Path] = None) -> Dict[str, Dict[str, Any]]:
    """Fetch and parse official ASM/GSM circular lists for a given trading date, with disk caching."""
    date_str = session_date.strftime("%d-%m-%Y")
    cached_file = cache_dir / f"surveillance_{date_str}.json" if cache_dir else None
    if cached_file and cached_file.exists():
        try:
            with open(cached_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    try:
        import zipfile
        import openpyxl
    except ImportError:
        return {}

    url = f"https://www.nseindia.com/api/circulars?fromDate={date_str}&toDate={date_str}"
    req = urllib.request.Request(url, headers=NSE_HEADERS)
    surveillance_map = {}
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
            if resp.status != 200:
                return {}
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
            items = payload.get("data", [])
            for c in items:
                link = c.get("circFilelink") or ""
                sub = (c.get("sub") or "").upper()
                if not (link.endswith(".zip") and ("ASM" in sub or "GSM" in sub or "SURVEILLANCE" in sub)):
                    continue
                try:
                    c_req = urllib.request.Request(link, headers=NSE_HEADERS)
                    with urllib.request.urlopen(c_req, context=SSL_CTX, timeout=8) as c_resp:
                        zf = zipfile.ZipFile(io.BytesIO(c_resp.read()))
                        for name in zf.namelist():
                            if not (name.endswith(".xlsx") or name.endswith(".xls")):
                                continue
                            wb = openpyxl.load_workbook(io.BytesIO(zf.read(name)), data_only=True)
                            for sheetname in wb.sheetnames:
                                s = wb[sheetname]
                                is_asm_sheet = "ASM" in sheetname.upper() or "ASM" in str(s.cell(1, 1).value or "").upper()
                                is_gsm_sheet = "GSM" in sheetname.upper() or "GSM" in str(s.cell(1, 1).value or "").upper()
                                for r in range(2, s.max_row + 1):
                                    row_vals = [s.cell(r, col).value for col in range(1, min(s.max_column + 1, 10))]
                                    isin = None
                                    symbol = None
                                    stage = "I"
                                    for v in row_vals:
                                        if isinstance(v, str):
                                            v_clean = v.strip().upper()
                                            if len(v_clean) == 12 and v_clean.startswith("INE"):
                                                isin = v_clean
                                            elif v_clean in {"I", "II", "III", "IV"}:
                                                stage = v_clean
                                            elif 2 <= len(v_clean) <= 15 and v_clean.isalnum() and not v_clean.startswith("INE"):
                                                if not symbol:
                                                    symbol = v_clean
                                    if symbol:
                                        entry = surveillance_map.setdefault(symbol, {
                                            "isAsm": False, "asmStage": None,
                                            "isGsm": False, "gsmStage": None,
                                            "surveillanceAvailable": True
                                        })
                                        if is_asm_sheet:
                                            entry["isAsm"] = True
                                            entry["asmStage"] = stage
                                        if is_gsm_sheet:
                                            entry["isGsm"] = True
                                            entry["gsmStage"] = stage
                except Exception:
                    pass
    except Exception:
        pass

    if cached_file and surveillance_map:
        try:
            cached_file.parent.mkdir(parents=True, exist_ok=True)
            with open(cached_file, "w", encoding="utf-8") as f:
                json.dump(surveillance_map, f)
        except Exception:
            pass

    return surveillance_map


def check_consecutive_quarters(quarter_dates: List[date]) -> bool:
    """Verify that a sequence of 4 quarter ends represents 4 consecutive, unbroken reporting quarters."""
    if len(quarter_dates) != 4:
        return False
    for i in range(3):
        diff = (quarter_dates[i + 1] - quarter_dates[i]).days
        # Normal quarter spacing is between 80 and 100 days
        if not (80 <= diff <= 100):
            return False
    return True


def calculate_technicals(opens: np.ndarray, closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, volumes: np.ndarray) -> Dict[str, Any]:
    """Calculate core screener indicators given price arrays."""
    n = len(closes)
    if n == 0:
        return {}

    current_open = float(opens[-1]) if len(opens) else float(closes[-1])
    current_close = float(closes[-1])
    current_high = float(highs[-1])
    current_low = float(lows[-1])
    current_volume = float(volumes[-1])

    change_pct = float(((current_close / closes[-2]) - 1.0) * 100.0) if n >= 2 and closes[-2] > 0 else 0.0

    # SMAs
    sma10 = float(np.mean(closes[-10:])) if n >= 10 else current_close
    sma20 = float(np.mean(closes[-20:])) if n >= 20 else current_close
    sma50 = float(np.mean(closes[-50:])) if n >= 50 else current_close
    sma200 = float(np.mean(closes[-200:])) if n >= 200 else current_close

    # EMAs (approximate via exponential weighting over last 4*period bars for performance)
    def calc_ema(arr: np.ndarray, period: int) -> float:
        if len(arr) < period:
            return float(arr[-1])
        lookback = min(len(arr), period * 4)
        sub = arr[-lookback:]
        k = 2.0 / (period + 1.0)
        ema = float(sub[0])
        for val in sub[1:]:
            ema = (val * k) + (ema * (1.0 - k))
        return ema

    ema20 = calc_ema(closes, 20)
    ema50 = calc_ema(closes, 50)
    ema200 = calc_ema(closes, 200)

    # Volume SMAs & Turnover
    avg_vol_20 = float(np.mean(volumes[-21:-1])) if n >= 21 else (float(np.mean(volumes)) if n > 0 else 1.0)
    rvol = float(current_volume / avg_vol_20) if avg_vol_20 > 0 else 1.0
    avg_turnover_20_cr = float(np.mean(closes[-20:] * volumes[-20:]) / 1e7) if n >= 20 else (current_close * current_volume / 1e7)
    avg_turnover_50_cr = float(np.mean(closes[-50:] * volumes[-50:]) / 1e7) if n >= 50 else None
    avg_turnover_100_cr = float(np.mean(closes[-100:] * volumes[-100:]) / 1e7) if n >= 100 else None
    rupee_volume_crore = float(current_close * current_volume / 1e7)

    # 52-Week High / Low (252 trading sessions)
    lookback_52w = min(n, 252)
    high_52w = float(np.max(highs[-lookback_52w:]))
    low_52w = float(np.min(lows[-lookback_52w:]))
    dist_52w_high_pct = float(((current_close - high_52w) / high_52w) * 100) if high_52w > 0 else 0.0
    dist_52w_low_pct = float(((current_close - low_52w) / low_52w) * 100) if low_52w > 0 else 0.0

    # All-Time High / Low
    all_time_high = float(np.max(highs))
    all_time_low = float(np.min(lows))
    dist_ath_pct = float(((current_close - all_time_high) / all_time_high) * 100.0) if all_time_high > 0 else 0.0

    # ADR (20D): Mean of (High - Low) / Close * 100 over last 20 days
    adr20_pct = float(np.mean((highs[-20:] - lows[-20:]) / closes[-20:] * 100.0)) if n >= 20 else float(np.mean((highs - lows) / closes * 100.0))

    # ATR (14): Wilder's 14-period True Range
    if n >= 15:
        sub_c = closes[-56:]
        sub_h = highs[-56:]
        sub_l = lows[-56:]
        prev_c = sub_c[:-1]
        tr = np.maximum(sub_h[1:] - sub_l[1:], np.maximum(np.abs(sub_h[1:] - prev_c), np.abs(sub_l[1:] - prev_c)))
        atr = float(np.mean(tr[:14]))
        for val in tr[14:]:
            atr = (atr * 13.0 + float(val)) / 14.0
        atr14 = float(atr)
    else:
        atr14 = float(np.mean(highs - lows))

    # Gap percentage (today's open vs yesterday's close)
    gap_pct = float(((current_open / closes[-2]) - 1.0) * 100.0) if n >= 2 and closes[-2] > 0 else 0.0

    # 5-Year Return (1,260 sessions)
    return_5y_pct = float(((current_close / closes[-1261]) - 1.0) * 100.0) if n >= 1261 and closes[-1261] > 0 else None

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
        "open": current_open,
        "close": current_close,
        "high": current_high,
        "low": current_low,
        "volume": current_volume,
        "changePct": change_pct,
        "rvol": rvol,
        "rupeeVolumeCrore": rupee_volume_crore,
        "sma10": sma10,
        "sma20": sma20,
        "sma50": sma50,
        "sma200": sma200,
        "ema20": ema20,
        "ema50": ema50,
        "ema200": ema200,
        "avg_volume_20": avg_vol_20,
        "daily_rupee_turnover_20_cr": round(avg_turnover_20_cr, 2),
        "daily_rupee_turnover_50_cr": round(avg_turnover_50_cr, 2) if avg_turnover_50_cr is not None else None,
        "daily_rupee_turnover_100_cr": round(avg_turnover_100_cr, 2) if avg_turnover_100_cr is not None else None,
        "dist52wHighPct": dist_52w_high_pct,
        "dist52wLowPct": dist_52w_low_pct,
        "allTimeHigh": round(all_time_high, 2),
        "allTimeLow": round(all_time_low, 2),
        "distAthPct": round(dist_ath_pct, 2),
        "adr20Pct": round(adr20_pct, 2),
        "atr14": round(atr14, 2),
        "gapPct": round(gap_pct, 2),
        "return5yPct": round(return_5y_pct, 2) if return_5y_pct is not None else None,
        "close_above_sma20": bool(current_close >= sma20),
        "close_above_sma50": bool(current_close >= sma50),
        "close_above_sma200": bool(current_close >= sma200),
        "sma20_above_sma50": bool(sma20 >= sma50),
        "sma50_above_sma200": bool(sma50 >= sma200),
        "rsi14": rsi14,
        "bullish_candle": bullish_candle,
        "is_inside_day": is_inside_day,
    }



def compute_ohlcv_fingerprint(pipeline_dir: Path) -> str:
    ohlcv_dir = pipeline_dir / "ohlcv_data"
    if not ohlcv_dir.exists():
        return ""
    paths = sorted(ohlcv_dir.glob("*.csv"))
    entries = []
    for p in paths:
        if p.is_file():
            stat = p.stat()
            entries.append((f"ohlcv_data/{p.name}", stat.st_size, stat.st_mtime_ns))
    return hashlib.sha256(json.dumps(entries).encode()).hexdigest()


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

    # Cache directory for historical downloads
    cache_dir = pipeline_dir / ".scanner_cache" / "historical_downloads"
    cache_dir.mkdir(parents=True, exist_ok=True)

    # 2. Load Historical OHLCV Cache
    history_npz_path = pipeline_dir / ".scanner_cache" / "history.npz"
    ohlcv_dir = pipeline_dir / "ohlcv_data"

    rebuild_history = not history_npz_path.exists()
    if not rebuild_history:
        try:
            with np.load(history_npz_path, allow_pickle=False) as chk:
                npz_rev = str(chk.get("revision", ""))
                chk_dates = pd.to_datetime(chk["dates"])
                marker = pipeline_dir / "scanner_revision.json"
                if marker.exists():
                    try:
                        manifest = json.loads(marker.read_text())
                        expected_rev = manifest.get("historyRevision")
                    except Exception:
                        expected_rev = compute_ohlcv_fingerprint(pipeline_dir)
                else:
                    expected_rev = compute_ohlcv_fingerprint(pipeline_dir)

                if expected_rev and npz_rev != expected_rev:
                    print(f"history.npz revision ({npz_rev[:12]}) differs from source CSV fingerprint ({expected_rev[:12]}), rebuilding...")
                    rebuild_history = True

                if not rebuild_history and len(chk_dates) > 0 and args.end_date > chk_dates.max().date():
                    if ohlcv_dir.exists() and any(ohlcv_dir.glob("*.csv")):
                        print(f"Target end date {args.end_date} exceeds history.npz max date {chk_dates.max().date()}, checking for newer ohlcv_data...")
                        rebuild_history = True
        except Exception as e:
            print(f"history.npz check warning: {e}; will rebuild if ohlcv_data exists.")
            rebuild_history = True

    if rebuild_history:
        if ohlcv_dir.exists() and any(ohlcv_dir.glob("*.csv")):
            print("Compiling .scanner_cache/history.npz from ohlcv_data...")
            sys.path.insert(0, str(pipeline_dir / "src"))
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "frontend"))
            try:
                from scanner_cache import ScannerCache
                sc = ScannerCache()
                sc.refresh(pipeline_dir)
                for csv_file in ohlcv_dir.glob("*.csv"):
                    sc.frame(pipeline_dir, csv_file.stem, as_of="2099-12-31")
                sc.save_frames(pipeline_dir)
                print("Successfully compiled .scanner_cache/history.npz from ohlcv_data!")
            except Exception as e:
                sys.exit(f"Failed to compile history.npz from ohlcv_data: {e}")
        else:
            sys.exit(f"Error: Neither {history_npz_path} nor {ohlcv_dir} exists.")

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

    # 5. Load Corporate Action Ledger
    ca_path = pipeline_dir / "corporate_action_ledger.json.gz"
    actions_by_symbol = defaultdict(list)
    if ca_path.exists():
        with gzip.open(ca_path, "rt", encoding="utf-8") as f:
            ca_data = json.load(f)
            for rec in ca_data.get("records", []):
                sym = str(rec.get("symbol") or "").upper()
                if sym:
                    actions_by_symbol[sym].append(rec)
        print(f"Loaded {sum(len(v) for v in actions_by_symbol.values())} corporate action records")

    # 6. Trading Sessions in Range
    unique_dates = sorted(set(d.date() for d in dates if args.start_date <= d.date() <= args.end_date))
    print(f"Found {len(unique_dates)} trading sessions in target window: {unique_dates}")

    if args.dry_run:
        print("[DRY RUN] Plan verified successfully. Exiting without file generation.")
        return

    # Load benchmark for RS Line 52w High
    bench_file = pipeline_dir / "indices_ohlcv_data" / FRONT_WEIGHTED_BENCHMARK_FILENAME
    bench_df_all = None
    if bench_file.exists():
        try:
            bench_df_all = pd.read_csv(bench_file)
            bench_df_all["Date"] = pd.to_datetime(bench_df_all["Date"]).dt.date
            print(f"Loaded benchmark {FRONT_WEIGHTED_BENCHMARK_FILENAME} ({len(bench_df_all)} bars)")
        except Exception as e:
            print(f"Warning: could not load benchmark {bench_file}: {e}")

    # 6. Build Daily Snapshots
    generated_sessions = []
    for session_date in unique_dates:
        session_str = session_date.isoformat()
        session_ts = pd.Timestamp(session_date)
        print(f"\nProcessing session: {session_str}...")
        t_session = time.time()

        bench_df_session = None
        if bench_df_all is not None:
            bench_df_session = bench_df_all[bench_df_all["Date"] <= session_date].tail(300)

        snapshot_stocks = []
        stock_series_data = {}
        advances = 0
        declines = 0
        above_20dma = 0
        above_50dma = 0
        above_200dma = 0

        # Optional: Fetch delivery bhavdata for this session (with disk caching)
        delivery_rows = fetch_nse_delivery_csv(session_date, cache_dir)
        delivery_map = {}
        if delivery_rows:
            for r in delivery_rows:
                sym = str(r.get("SYMBOL") or "").upper().strip()
                if sym and r.get("SERIES") == "EQ":
                    delivery_map[sym] = r

        # Fetch official NSE daily price bands & GSM remarks from sec_list_{date}.csv (with disk caching)
        price_bands_map, gsm_remarks_map = fetch_nse_price_bands(session_date, cache_dir)

        # Fetch official NSE ASM/GSM circular surveillance lists for this session (with disk caching)
        surveillance_map = fetch_nse_surveillance_for_date(session_date, cache_dir)

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

            o_vals = s_values[:, 0]
            tech = calculate_technicals(o_vals, c_vals, h_vals, l_vals, v_vals)
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

            # Point-in-time financial attachment (strictly filed on or before session_date)
            sym_fins = financials_by_symbol.get(sym, [])
            valid_fins = [
                f for f in sym_fins
                if f.get("filing_date") and f["filing_date"][:10] <= session_str
            ]
            quarter_map = {}
            for f in valid_fins:
                qe = f.get("quarter_end")
                if not qe:
                    continue
                existing = quarter_map.get(qe)
                if existing is None:
                    quarter_map[qe] = f
                elif f.get("report_type") == "CONSOLIDATED" and existing.get("report_type") != "CONSOLIDATED":
                    quarter_map[qe] = f
                elif f.get("report_type") == existing.get("report_type") and f.get("filing_date", "") > existing.get("filing_date", ""):
                    quarter_map[qe] = f
            sorted_fins = sorted(quarter_map.values(), key=lambda x: x["quarter_end"])
            latest_fin = sorted_fins[-1] if sorted_fins else None

            days_since_earnings = None
            if latest_fin and latest_fin.get("filing_date"):
                try:
                    filing_d = date.fromisoformat(latest_fin["filing_date"][:10])
                    days_since_earnings = max(0, (session_date - filing_d).days)
                except Exception:
                    pass

            # Strict 4-consecutive-quarter TTM calculation
            ttm_sales = None
            ttm_rev = None
            ttm_profit = None
            ttm_eps = None
            ttm_opm = None
            ttm_sales_growth = None
            ttm_profit_growth = None
            ttm_rev_growth = None

            if len(sorted_fins) >= 4:
                trailing_4q = sorted_fins[-4:]
                try:
                    trailing_dates = [date.fromisoformat(f["quarter_end"][:10]) for f in trailing_4q]
                    if check_consecutive_quarters(trailing_dates):
                        ttm_sales = round(sum(f.get("sales", 0.0) or 0.0 for f in trailing_4q if f.get("sales") is not None), 2)
                        ttm_rev = round(sum(f.get("revenue", 0.0) or 0.0 for f in trailing_4q if f.get("revenue") is not None), 2)
                        ttm_profit = round(sum(f.get("net_profit", 0.0) or 0.0 for f in trailing_4q if f.get("net_profit") is not None), 2)
                        ttm_eps = round(sum(f.get("eps", 0.0) or 0.0 for f in trailing_4q if f.get("eps") is not None), 2)

                        # Weighted operating profit / sales * 100
                        tot_op = sum((f.get("sales", 0.0) or 0.0) * (f.get("opm", 0.0) or 0.0) / 100.0 for f in trailing_4q if f.get("sales") is not None and f.get("opm") is not None)
                        if ttm_sales > 0:
                            ttm_opm = round((tot_op / ttm_sales) * 100.0, 2)

                        # YoY 4-quarter growth comparison (must be spaced ~365 days prior)
                        if len(sorted_fins) >= 8:
                            prev_4q = sorted_fins[-8:-4]
                            prev_dates = [date.fromisoformat(f["quarter_end"][:10]) for f in prev_4q]
                            if check_consecutive_quarters(prev_dates) and (trailing_dates[0] - prev_dates[0]).days in range(350, 380):
                                prev_sales = sum(f.get("sales", 0.0) or 0.0 for f in prev_4q if f.get("sales") is not None)
                                prev_profit = sum(f.get("net_profit", 0.0) or 0.0 for f in prev_4q if f.get("net_profit") is not None)
                                prev_rev = sum(f.get("revenue", 0.0) or 0.0 for f in prev_4q if f.get("revenue") is not None)
                                if prev_sales > 0 and ttm_sales > 0:
                                    ttm_sales_growth = round(((ttm_sales / prev_sales) - 1.0) * 100.0, 2)
                                if prev_profit > 0 and ttm_profit > 0:
                                    ttm_profit_growth = round(((ttm_profit / prev_profit) - 1.0) * 100.0, 2)
                                if prev_rev > 0 and ttm_rev > 0:
                                    ttm_rev_growth = round(((ttm_rev / prev_rev) - 1.0) * 100.0, 2)
                except Exception:
                    pass

            # Point-in-time Market cap and P/E derivation
            mcap_crore = None
            pe_ratio = None
            if ttm_eps and ttm_eps > 0:
                pe_ratio = round(tech["close"] / ttm_eps, 2)
            if latest_fin and latest_fin.get("net_profit") and latest_fin.get("eps") and latest_fin["eps"] > 0:
                shares = (latest_fin["net_profit"] * 1e7) / latest_fin["eps"]
                mcap_crore = round((shares * tech["close"]) / 1e7, 2)

            # Point-in-time shareholding with SEBI LODR Regulation 31 statutory lag (21 days post quarter-end)
            sym_shs = sh_by_symbol.get(sym, [])
            valid_shs = []
            for s in sym_shs:
                pe_str = s.get("period_end")
                if not pe_str:
                    continue
                try:
                    pe_d = date.fromisoformat(pe_str[:10])
                    if pe_d + timedelta(days=21) <= session_date:
                        valid_shs.append(s)
                except Exception:
                    continue
            valid_shs.sort(key=lambda x: x["period_end"])
            latest_sh = valid_shs[-1] if valid_shs else None
            prev_sh = valid_shs[-2] if len(valid_shs) >= 2 else None
            fii_qoq = None
            dii_qoq = None
            if latest_sh and prev_sh:
                if latest_sh.get("fii_holding_percent") is not None and prev_sh.get("fii_holding_percent") is not None:
                    fii_qoq = round(latest_sh["fii_holding_percent"] - prev_sh["fii_holding_percent"], 2)
                if latest_sh.get("dii_holding_percent") is not None and prev_sh.get("dii_holding_percent") is not None:
                    dii_qoq = round(latest_sh["dii_holding_percent"] - prev_sh["dii_holding_percent"], 2)

            # Point-in-time Corporate Actions & Dividends
            sym_actions = actions_by_symbol.get(sym, [])
            valid_actions = [
                a for a in sym_actions
                if a.get("ex_date") and a["ex_date"] <= session_str
            ]
            div_actions = [
                a for a in valid_actions
                if "DIVIDEND" in (a.get("action_type") or "") and a.get("dividend_per_share") is not None
            ]
            latest_div = sorted(div_actions, key=lambda x: x["ex_date"])[-1] if div_actions else None
            
            trailing_1y_start = (session_date - timedelta(days=365)).isoformat()
            trailing_1y_divs = [
                a for a in div_actions
                if a["ex_date"] >= trailing_1y_start
            ]
            trailing_div_sum = sum(a["dividend_per_share"] for a in trailing_1y_divs)
            div_yield_pct = round((trailing_div_sum / tech["close"]) * 100, 2) if tech["close"] > 0 and trailing_div_sum > 0 else None

            # Delivery & VWAP stats from official NSE Bhavcopy for this session
            deliv = delivery_map.get(sym)
            deliv_qty = int(deliv["DELIV_QTY"]) if deliv and deliv.get("DELIV_QTY", "").isdigit() else None
            deliv_pct = float(deliv["DELIV_PER"]) if deliv and deliv.get("DELIV_PER") else None
            vwap = None
            if deliv:
                try:
                    raw_avg = deliv.get("AVG_PRICE", "").strip()
                    if raw_avg and raw_avg.replace(".", "", 1).isdigit() and float(raw_avg) > 0:
                        vwap = float(raw_avg)
                    elif deliv.get("TURNOVER_LACS") and deliv.get("TTL_TRD_QNTY"):
                        turnover_lacs = float(deliv["TURNOVER_LACS"])
                        ttl_qty = float(deliv["TTL_TRD_QNTY"])
                        if ttl_qty > 0:
                            vwap = round((turnover_lacs * 100_000.0) / ttl_qty, 2)
                except Exception:
                    pass

            surv_info = surveillance_map.get(sym)
            surv_avail = bool(surveillance_map) or bool(gsm_remarks_map)
            is_asm = surv_info["isAsm"] if surv_info else (False if bool(surveillance_map) else None)
            asm_stage = surv_info["asmStage"] if surv_info else None
            
            # Combine GSM circular state with sec_list Remarks
            is_gsm = (surv_info and surv_info["isGsm"]) or (sym in gsm_remarks_map)
            gsm_stage = (surv_info and surv_info["gsmStage"]) or gsm_remarks_map.get(sym)
            if not surv_avail:
                is_gsm = None

            # Official price band for this session
            circuit_limit = price_bands_map.get(sym) or stock.get("circuit_limit") or "20"

            # Reconstruct item explicitly without leaking 2026 current-master stock values
            item = {
                "symbol": sym,
                "name": stock.get("name") or sym,
                "isin": stock.get("isin") or "",
                "sector": stock.get("sector") or "Unclassified",
                "industry": stock.get("industry") or "Unclassified",
                "series": stock.get("series") or "EQ",
                "listingDate": stock.get("listing_date") or "",
                "isSme": stock.get("is_sme", False),
                "isFno": None,
                "fnoBan": None,
                "fnoBanAsOfDate": None,
                "tradingview": None,
                "indexMemberships": [],
                "circuitLimit": circuit_limit,
                "surveillanceAvailable": surv_avail,
                "surveillanceAsOfDate": session_str if surv_avail else None,
                "isAsm": is_asm,
                "asmStage": asm_stage,
                "isGsm": is_gsm,
                "gsmStage": gsm_stage,
                "asOfDate": session_str,
                "metadataAsOfDate": session_str,
                "historyAligned": True,
                "open": tech["open"],
                "high": tech["high"],
                "low": tech["low"],
                "close": tech["close"],
                "volume": tech["volume"],
                "changePct": tech["changePct"],
                "rvol": tech["rvol"],
                "rupeeVolumeCrore": tech["rupeeVolumeCrore"],
                "vwap": vwap,
                "vwapAsOfDate": session_str if vwap is not None else None,
                "deliveryPct": deliv_pct,
                "deliverableQuantity": deliv_qty,
                "rsi14": tech["rsi14"],
                "sma10": tech["sma10"],
                "sma20": tech["sma20"],
                "sma50": tech["sma50"],
                "sma200": tech["sma200"],
                "ema20": tech["ema20"],
                "ema50": tech["ema50"],
                "ema200": tech["ema200"],
                "dist52wHighPct": tech["dist52wHighPct"],
                "dist52wLowPct": tech["dist52wLowPct"],
                "allTimeHigh": tech["allTimeHigh"],
                "allTimeLow": tech["allTimeLow"],
                "distAthPct": tech["distAthPct"],
                "adr20Pct": tech["adr20Pct"],
                "atr14": tech["atr14"],
                "return5yPct": tech["return5yPct"],
                "dividendPerShare": latest_div.get("dividend_per_share") if latest_div else None,
                "dividendExDate": latest_div.get("ex_date") if latest_div else None,
                "dividendYieldPct": div_yield_pct,
                "promoterHoldingPct": latest_sh.get("promoter_holding_percent") if latest_sh else None,
                "fiiHoldingPct": latest_sh.get("fii_holding_percent") if latest_sh else None,
                "diiHoldingPct": latest_sh.get("dii_holding_percent") if latest_sh else None,
                "publicHoldingPct": latest_sh.get("public_holding_percent") if latest_sh else None,
                "numberOfShareholders": latest_sh.get("number_of_shareholders") if latest_sh else None,
                "fiiChangePctQoq": fii_qoq,
                "diiChangePctQoq": dii_qoq,
                "quarterlySales": latest_fin.get("sales") if latest_fin else None,
                "quarterlyNetProfit": latest_fin.get("net_profit") if latest_fin else None,
                "quarterlyEps": latest_fin.get("eps") if latest_fin else None,
                "quarterlyOpm": latest_fin.get("opm") if latest_fin else None,
                "earningsDate": latest_fin.get("filing_date")[:10] if latest_fin and latest_fin.get("filing_date") else None,
                "daysSinceEarnings": days_since_earnings,
                "ttmSalesCrore": ttm_sales,
                "ttmRevenueCrore": ttm_rev,
                "ttmNetProfitCrore": ttm_profit,
                "epsTtm": ttm_eps,
                "opmTtmPct": ttm_opm,
                "ttmSalesGrowthPct": ttm_sales_growth,
                "ttmNetProfitGrowthPct": ttm_profit_growth,
                "ttmRevenueGrowthPct": ttm_rev_growth,
                "marketCapCrore": mcap_crore,
                "peRatio": pe_ratio,
                "pbRatio": None,
                "pegRatio": None,
                "evEbitda": None,
                "roePct": None,
                "rocePct": None,
                "roaPct": None,
                "debtToEquity": None,
                "currentRatio": None,
                "interestCoverage": None,
                "salesGrowth5yPct": None,
                "epsGrowth1yPct": None,
                "epsCagr3yPct": None,
                "revenueCagr3yPct": None,
                "opm5YearsAgoPct": None,
                "averageRoe3yPct": None,
                "averageRoa3yPct": None,
                "averageOpm5yPct": None,
                "medianSalesGrowth5yPct": None,
                "freeCashFlowCrore": None,
                "borrowingsCrore": None,
                "cwipCrore": None,
                "fixedAssetsCrore": None,
                "financingCashFlowCrore": None,
                "totalRevenueLakh": None,
                "totalIncomeLakh": None,
                "totalExpenseLakh": None,
                "profitBeforeTaxLakh": None,
                "totalTaxExpensesLakh": None,
                "netProfitLakh": None,
                "totalEquityLakh": None,
                "totalAssetsLakh": None,
                "currentAssetsLakh": None,
                "currentLiabilitiesLakh": None,
                "nonCurrentAssetsLakh": None,
                "nonCurrentLiabilitiesLakh": None,
                "totalLiabilitiesLakh": None,
                "operatingCashFlowLakh": None,
                "investingCashFlowLakh": None,
                "netCashFlowLakh": None,
                "industryPeRatio": None,
                "faceValue": None,
                "epsLastYear": None,
                "epsTwoYearsBack": None,
                "metrics": {
                    "return5": round(((tech["close"] / c_vals[-6]) - 1) * 100, 2) if len(c_vals) >= 6 else None,
                    "return21": round(((tech["close"] / c_vals[-22]) - 1) * 100, 2) if len(c_vals) >= 22 else None,
                    "return63": round(((tech["close"] / c_vals[-64]) - 1) * 100, 2) if len(c_vals) >= 64 else None,
                    "return126": round(((tech["close"] / c_vals[-127]) - 1) * 100, 2) if len(c_vals) >= 127 else None,
                    "return252": round(((tech["close"] / c_vals[-253]) - 1) * 100, 2) if len(c_vals) >= 253 else None,
                    "turnover20": tech["daily_rupee_turnover_20_cr"],
                    "turnover50": tech["daily_rupee_turnover_50_cr"],
                    "turnover100": tech["daily_rupee_turnover_100_cr"],
                    "gapPct": tech["gapPct"],
                    "historySessions": len(c_vals),
                    "sma10": tech["sma10"],
                    "sma20": tech["sma20"],
                    "sma50": tech["sma50"],
                    "sma200": tech["sma200"],
                    "ema20": tech["ema20"],
                    "ema50": tech["ema50"],
                    "ema200": tech["ema200"],
                    "rsi14": tech["rsi14"],
                },
                "presetMatches": {
                    "trend_template": bool(tech["close_above_sma50"] and tech["close_above_sma200"] and tech["sma50_above_sma200"]),
                    "lib-stage-two": bool(tech["close_above_sma50"] and tech["close_above_sma200"] and tech["sma50_above_sma200"]),
                    "lib-52w-high-breakout": bool(tech["dist52wHighPct"] >= -0.5),
                    "lib-20d-high-thrust": bool(tech["changePct"] >= 4.0 and tech["rvol"] >= 2.0),
                    "mom_rvol": bool(tech["rvol"] >= 1.5),
                },
                "presetRuleMatches": {
                    "trend_template": bool(tech["close_above_sma50"] and tech["close_above_sma200"] and tech["sma50_above_sma200"]),
                    "lib-stage-two": bool(tech["close_above_sma50"] and tech["close_above_sma200"] and tech["sma50_above_sma200"]),
                    "lib-52w-high-breakout": bool(tech["dist52wHighPct"] >= -0.5),
                    "lib-20d-high-thrust": bool(tech["changePct"] >= 4.0 and tech["rvol"] >= 2.0),
                    "mom_rvol": bool(tech["rvol"] >= 1.5),
                },
            }
            snapshot_stocks.append(item)
            stock_series_data[sym] = (c_vals, h_vals, l_vals, v_vals, s_dates[window_slice])

        # 1. Compute cross-sectional RS rating (1-99) using audited multi-horizon engine
        comp_scores_map = {}
        comp_scores_21_map = {}
        for it in snapshot_stocks:
            sym = it["symbol"]
            series = stock_series_data.get(sym)
            if not series:
                continue
            c_arr = series[0]
            c_list = c_arr.tolist() if isinstance(c_arr, np.ndarray) else list(c_arr)
            ret_dict = compute_stock_returns(c_list) if compute_stock_returns else None
            if ret_dict:
                score = calculate_composite_score(ret_dict) if calculate_composite_score else None
                if score is not None:
                    comp_scores_map[sym] = score

            if compute_stock_returns and len(c_list) >= 147:
                ret_dict_21 = compute_stock_returns(c_list, offset=21)
                if ret_dict_21:
                    score_21 = calculate_composite_score(ret_dict_21) if calculate_composite_score else None
                    if score_21 is not None:
                        comp_scores_21_map[sym] = score_21

        # Percentile rank (1-99)
        rs_ranks = percentile_rank(comp_scores_map) if (percentile_rank and comp_scores_map) else {}
        rs_ranks_21 = percentile_rank(comp_scores_21_map) if (percentile_rank and comp_scores_21_map) else {}

        # Fallback to legacy 4-horizon RS if module was not importable
        if not rs_ranks:
            eligible_rs = []
            for it in snapshot_stocks:
                m = it.get("metrics") or {}
                r21, r63, r126, r252 = m.get("return21"), m.get("return63"), m.get("return126"), m.get("return252")
                if r21 is not None and r63 is not None and r126 is not None and r252 is not None:
                    comp = 0.40 * r21 + 0.20 * r63 + 0.20 * r126 + 0.20 * r252
                    eligible_rs.append((it["symbol"], comp))
            if eligible_rs:
                eligible_rs.sort(key=lambda x: x[1])
                n_rs = len(eligible_rs)
                rs_ranks = {sym: int(round(1.0 + 98.0 * pos / max(1, n_rs - 1))) for pos, (sym, _) in enumerate(eligible_rs)}

        # 2. Enrich with RS ratings, Setup Geometry, Trend Template & Stage Status
        for it in snapshot_stocks:
            sym = it["symbol"]
            comp_rs = rs_ranks.get(sym)
            it["rsRating"] = comp_rs
            rs_21 = rs_ranks_21.get(sym)
            rs_change = (comp_rs - rs_21) if (comp_rs is not None and rs_21 is not None) else None
            it["rsChange21d"] = rs_change
            it["rs_change_21d"] = rs_change

            series = stock_series_data.get(sym)
            if not series or len(series[0]) < 5:
                it["setupGeometry"] = None
                it["setup_geometry"] = None
                it["trendTemplate"] = None
                it["trend_template"] = None
                it["stageStatus"] = None
                it["stage_status"] = None
                it["isRsLine52wHigh"] = False
                it["is_rs_line_52w_high"] = False
                it["isLiquidScreen"] = False
                it["is_liquid_screen"] = False
                it["tradedValueMean20dCr"] = None
                it["tradedValueMedian20dCr"] = None
                it["dataCompleteness"] = bridge.data_completeness(it)
                continue
            c_arr, h_arr, l_arr, v_arr, s_dt = series
            date_strs = [d.strftime("%Y-%m-%d") for d in s_dt]

            cur_c = float(c_arr[-1])
            cur_v = float(v_arr[-1])
            s50 = float(np.mean(c_arr[-50:])) if len(c_arr) >= 50 else None
            h52 = float(np.max(h_arr[-min(len(h_arr), 252):]))

            # RS line 52w high vs benchmark
            is_rs_high = False
            if check_rs_line_52w_high and bench_df_session is not None and len(c_arr) >= 20:
                try:
                    stock_df = pd.DataFrame({"Date": [d.date() for d in s_dt], "Close": c_arr})
                    is_rs_high = check_rs_line_52w_high(stock_df, bench_df_session)
                except Exception:
                    is_rs_high = False

            # Setups
            vcp = detect_vcp(h_arr, l_arr, c_arr, v_arr, date_strs) if detect_vcp else None
            darvas = detect_darvas(h_arr, l_arr, c_arr) if detect_darvas else None
            flag = detect_flags(h_arr, l_arr, c_arr, v_arr) if detect_flags else None
            cup = detect_cup_with_handle(h_arr, l_arr, c_arr) if detect_cup_with_handle else None
            tight_wks = detect_tight_weeks(c_arr, date_strs, s50, comp_rs) if detect_tight_weeks else None

            # Volume Breakout
            prior_50_high = float(np.max(h_arr[-51:-1])) if len(h_arr) >= 51 else float(np.max(h_arr[:-1]))
            rvol_50d = (cur_v / max(1.0, float(np.mean(v_arr[-50:])))) if len(v_arr) >= 50 else 1.0
            vol_breakout = bool(cur_c > prior_50_high and rvol_50d >= 2.0)

            # Pocket Pivot
            pocket_pivot = False
            if len(c_arr) >= 11 and cur_c > c_arr[-2] and s50 and cur_c > s50 and (comp_rs or 0) >= 60:
                down_day_vols = [v_arr[-i] for i in range(2, 12) if c_arr[-i] < c_arr[-i-1]]
                max_down_vol = max(down_day_vols) if down_day_vols else 0.0
                pocket_pivot = bool(cur_v > max_down_vol)

            # Multi-Year Breakout
            myb = False
            myb_details = None
            lookback_myb = min(len(c_arr), 750)
            if lookback_myb >= 300:
                prior_win = h_arr[-lookback_myb:-1]
                ceil_val = float(np.max(prior_win))
                ceil_idx = int(np.argmax(prior_win))
                ceil_age = len(prior_win) - 1 - ceil_idx
                if ceil_age >= 250 and cur_c > ceil_val:
                    above_pct = ((cur_c - ceil_val) / ceil_val) * 100.0
                    if above_pct <= 15.0:
                        myb = True
                        myb_details = {
                            "matched": True,
                            "ceilingPrice": round(ceil_val, 2),
                            "ceiling_price": round(ceil_val, 2),
                            "ceilingHeldDays": ceil_age,
                            "ceiling_held_days": ceil_age,
                            "distanceAbovePct": round(above_pct, 2),
                            "distance_above_pct": round(above_pct, 2),
                        }

            # Coiled
            rng10 = ((float(np.max(h_arr[-10:])) - float(np.min(l_arr[-10:]))) / float(np.max(h_arr[-10:]))) * 100.0 if len(h_arr) >= 10 else 100.0
            atr10_series = calculate_atr_series(h_arr, l_arr, c_arr, 10) if calculate_atr_series else np.zeros(len(c_arr))
            atr50_series = calculate_atr_series(h_arr, l_arr, c_arr, 50) if calculate_atr_series else np.zeros(len(c_arr))
            atr_ratio = (atr10_series[-1] / atr50_series[-1]) if (len(c_arr) >= 50 and atr50_series[-1] > 0) else 1.0
            v10 = float(np.mean(v_arr[-10:])) if len(v_arr) >= 10 else float(v_arr[-1])
            v50 = float(np.mean(v_arr[-50:])) if len(v_arr) >= 50 else v10
            vol_dry_10 = (v10 / max(1.0, v50)) if v50 > 0 else 1.0
            from_52h = ((h52 - cur_c) / h52 * 100.0) if h52 > 0 else 100.0

            coiled = bool(rng10 <= 10.0 and atr_ratio <= 0.85 and vol_dry_10 < 0.90 and s50 and cur_c > s50 and from_52h <= 15.0 and (comp_rs or 0) >= 60)

            # Trend template and stage
            trend_res = evaluate_minervini_trend(c_arr, h_arr, l_arr, comp_rs) if evaluate_minervini_trend else {"score": 0, "is_leader": False, "checks": {}, "fails": []}
            stage_res = evaluate_weinstein_stage(c_arr) if evaluate_weinstein_stage else {"stage": 1, "slope_20d": 0.0, "just_entered_stage_2": False}

            # Liquidity
            traded_val_20d = c_arr[-20:] * v_arr[-20:]
            mean_val_cr = float(np.mean(traded_val_20d)) / 1e7
            median_val_cr = float(np.median(traded_val_20d)) / 1e7
            is_liquid = bool(mean_val_cr >= 10.0)

            setup_geometry = {
                "vcp": vcp,
                "darvasBox": darvas,
                "darvas_box": darvas,
                "cupWithHandle": cup,
                "cup_with_handle": cup,
                "bullFlag": flag,
                "flag": flag,
                "pocketPivot": pocket_pivot,
                "pocket_pivot": pocket_pivot,
                "volumeBreakout": vol_breakout,
                "volume_breakout": vol_breakout,
                "multiYearBreakout": myb_details if myb else None,
                "multi_year_breakout": myb_details if myb else None,
                "coiled": coiled,
                "tightWeeks": tight_wks,
                "tight_weeks": tight_wks,
            }

            it["setupGeometry"] = setup_geometry
            it["setup_geometry"] = setup_geometry
            it["trendTemplate"] = trend_res
            it["trend_template"] = trend_res
            it["stageStatus"] = stage_res
            it["stage_status"] = stage_res
            it["isRsLine52wHigh"] = is_rs_high
            it["is_rs_line_52w_high"] = is_rs_high
            it["isLiquidScreen"] = is_liquid
            it["is_liquid_screen"] = is_liquid
            it["tradedValueMean20dCr"] = round(mean_val_cr, 2)
            it["tradedValueMedian20dCr"] = round(median_val_cr, 2)

            # Calculate default eligibility (market cap >= 1000 Cr, close >= 10, 50d turnover >= 5 Cr, and 20d mean turnover >= 10 Cr)
            mcap_cr = it.get("marketCapCrore")
            p_close = it.get("close")
            t50_val = (it.get("metrics") or {}).get("turnover50")
            default_eligible = bool(
                (mcap_cr is not None and mcap_cr >= 1000.0) and
                (p_close is not None and p_close >= 10.0) and
                (t50_val is None or t50_val >= 5.0) and
                is_liquid
            )

            # Rule-only matches without default eligibility constraints
            ms_rule_matches = {
                "lib-ms-vcp": bool(vcp),
                "lib-ms-darvas": bool(darvas and (darvas.get("state") in ("confirmed", "breakout") or darvas.get("status") in ("confirmed", "breakout"))),
                "lib-ms-coiled": bool(coiled),
                "lib-ms-tight-weeks": bool(tight_wks),
                "lib-ms-stage-2": (stage_res.get("stage") == 2),
                "lib-ms-just-entered-stage-2": bool(stage_res.get("just_entered_stage_2", False)),
                "lib-ms-trend-leaders": bool(trend_res.get("is_leader", False)),
                "lib-ms-pocket-pivot": bool(pocket_pivot),
                "lib-ms-volume-breakout": bool(vol_breakout),
                "lib-ms-multi-year-breakout": bool(myb),
                "lib-ms-rs-leaders-80": bool((comp_rs or 0) >= 80),
                "lib-ms-rs-line-high": bool(is_rs_high),
                "lib-ms-liquid-screen": is_liquid,
                "lib-ms-cup-handle": bool(cup),
                "lib-ms-cup-with-handle": bool(cup),
                "lib-ms-bull-flag": bool(flag),
            }

            if "presetRuleMatches" not in it:
                it["presetRuleMatches"] = {}
            it["presetRuleMatches"].update(ms_rule_matches)

            # Preset matches require BOTH rule-match and default eligibility
            it["presetMatches"].update({
                k: bool(v and default_eligible) for k, v in ms_rule_matches.items()
            })
            for k in ("trend_template", "lib-stage-two", "lib-52w-high-breakout", "lib-20d-high-thrust", "mom_rvol"):
                if k in it["presetMatches"]:
                    it["presetMatches"][k] = bool(it["presetRuleMatches"].get(k) and default_eligible)

            # Calculate dataCompleteness
            it["dataCompleteness"] = bridge.data_completeness(it)

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

        raw_payload = {
            "schemaVersion": 4,
            "presetRuleMatchesVersion": 1,
            "asOfDate": session_str,
            "totalStocks": len(snapshot_stocks),
            "stocks": snapshot_stocks,
            "breadth": breadth_record,
            "pointInTimeCoverage": {
                "survivorshipBias": "Stock universe restricted to current surviving master list; historical delisted/merged securities omitted",
                "shareholding": "Point-in-time quarter end filings with 21-day SEBI LODR statutory reporting lag",
                "financials": "Point-in-time disclosure filing dates; TTM requires 4 consecutive quarters without temporal gaps",
                "balanceSheetRatios": "unavailable (annual balance sheet time-series not maintained)",
                "fnoEligibility": "unavailable",
                "fnoBan": "unavailable",
                "indexMemberships": "unavailable (constituent change history not backfilled)",
                "tradingview": "unavailable",
                "surveillance": "Reconstructed from official NSE circulars where complete" if surv_avail else "incomplete_circular_chain",
            },
            "dataCompleteness": "historical_reconstructed_with_survivorship_qualification",
        }
        json_bytes = json.dumps(raw_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        session_hash = hashlib.sha256(json_bytes).hexdigest()
        raw_payload["revision"] = session_hash

        out_file = output_dir / f"{session_str}.json.gz"
        with gzip.open(out_file, "wt", encoding="utf-8") as f:
            json.dump(raw_payload, f, separators=(",", ":"), ensure_ascii=False)

        file_size_kb = out_file.stat().st_size / 1024
        print(f"Generated {out_file.name} ({len(snapshot_stocks)} stocks, {file_size_kb:.1f} KB, rev {session_hash[:12]}) in {time.time()-t_session:.2f}s")
        generated_sessions.append((session_date, session_hash))

    print(f"\nAll done! Successfully generated {len(generated_sessions)} historical daily snapshots in {output_dir}")

    if args.update_sessions_manifest and generated_sessions:
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

        # Add newly generated sessions with their exact revision hashes
        for s_date, s_hash in generated_sessions:
            s_str = s_date.strftime("%Y-%m-%d")
            existing[s_str] = {
                "date": s_str,
                "revision": s_hash,
                "label": s_str,
                "isHistorical": True,
            }

        sorted_sessions = sorted(existing.values(), key=lambda x: x["date"], reverse=True)
        manifest_payload = {
            "version": 1,
            "sessions": sorted_sessions,
        }
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(manifest_payload, f, indent=2)
            f.write("\n")
        print(f"Updated sessions manifest at {manifest_file} ({len(sorted_sessions)} total sessions)")



if __name__ == "__main__":
    main()
