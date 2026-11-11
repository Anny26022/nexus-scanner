"""US Historical Snapshot Backfill Engine (Up to 5 Years).

Reconstructs point-in-time daily snapshots ({session}.json.gz) for Nexus Scanner US
from validated historical sources:
1. Daily EOD OHLCV history (Dhan US / ticks host OHLCV archives 2021-2026)
2. Benchmark OHLCV (SPY.csv)
3. Multi-Quarter Historical Fundamentals Ledger (quarterly_financial_history.json.gz)
4. Finviz Thematic & Sector Classification (us_thematic_universe.json)
5. Cross-sectional Technical Indicator & Breadth Engine (SMAs, RSI, VCP, ADR, RS Rating vs SPY)
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

# Add paths for EDL pipeline and frontend modules
ROOT_DIR = Path(__file__).resolve().parent.parent
EDL_SRC = ROOT_DIR / "DO NOT DELETE EDL PIPELINE" / "src"
FRONTEND_DIR = ROOT_DIR / "frontend"
for p in (str(EDL_SRC), str(FRONTEND_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from edl_pipeline.markets.us import calendar
from edl_pipeline.markets import UNITED_STATES


def parse_date(date_str: str) -> date:
    return date.fromisoformat(date_str)


def calculate_technicals_us(opens: np.ndarray, closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, volumes: np.ndarray) -> Dict[str, Any]:
    """Calculate core US screener indicators given price arrays."""
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

    # EMAs
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

    # Volume SMAs & Turnover ($ Millions)
    avg_vol_20 = float(np.mean(volumes[-21:-1])) if n >= 21 else (float(np.mean(volumes)) if n > 0 else 1.0)
    rvol = float(current_volume / avg_vol_20) if avg_vol_20 > 0 else 1.0
    turnover_20_m = float(np.mean(closes[-20:] * volumes[-20:]) / 1e6) if n >= 20 else (current_close * current_volume / 1e6)
    turnover_50_m = float(np.mean(closes[-50:] * volumes[-50:]) / 1e6) if n >= 50 else None
    turnover_100_m = float(np.mean(closes[-100:] * volumes[-100:]) / 1e6) if n >= 100 else None
    dollar_volume_m = float(current_close * current_volume / 1e6)

    # 52-Week High / Low (252 NYSE sessions)
    lookback_52w = min(n, 252)
    high_52w = float(np.max(highs[-lookback_52w:]))
    low_52w = float(np.min(lows[-lookback_52w:]))
    dist_52w_high_pct = float(((current_close - high_52w) / high_52w) * 100.0) if high_52w > 0 else 0.0
    dist_52w_low_pct = float(((current_close - low_52w) / low_52w) * 100.0) if low_52w > 0 else 0.0

    # All-Time High / Low
    all_time_high = float(np.max(highs))
    all_time_low = float(np.min(lows))
    dist_ath_pct = float(((current_close - all_time_high) / all_time_high) * 100.0) if all_time_high > 0 else 0.0

    # ADR (20D): Mean of (High - Low) / Close * 100
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

    # Gap percentage
    gap_pct = float(((current_open / closes[-2]) - 1.0) * 100.0) if n >= 2 and closes[-2] > 0 else 0.0

    # 5-Year Return (1,260 NYSE sessions)
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

    return {
        "open": round(current_open, 2),
        "high": round(current_high, 2),
        "low": round(current_low, 2),
        "close": round(current_close, 2),
        "volume": int(current_volume),
        "changePct": round(change_pct, 2),
        "sma10": round(sma10, 2),
        "sma20": round(sma20, 2),
        "sma50": round(sma50, 2),
        "sma200": round(sma200, 2),
        "ema20": round(ema20, 2),
        "ema50": round(ema50, 2),
        "ema200": round(ema200, 2),
        "rvol": round(rvol, 2),
        "daily_turnover_20_m": round(turnover_20_m, 2),
        "daily_turnover_50_m": round(turnover_50_m, 2) if turnover_50_m is not None else None,
        "daily_turnover_100_m": round(turnover_100_m, 2) if turnover_100_m is not None else None,
        "turnover_m": round(dollar_volume_m, 2),
        "dist52wHighPct": round(dist_52w_high_pct, 2),
        "dist52wLowPct": round(dist_52w_low_pct, 2),
        "allTimeHigh": round(all_time_high, 2),
        "allTimeLow": round(all_time_low, 2),
        "distAthPct": round(dist_ath_pct, 2),
        "adr20Pct": round(adr20_pct, 2),
        "atr14": round(atr14, 2),
        "gapPct": round(gap_pct, 2),
        "return5yPct": round(return_5y_pct, 2) if return_5y_pct is not None else None,
        "rsi14": round(rsi14, 2),
        "close_above_sma20": current_close > sma20,
        "close_above_sma50": current_close > sma50,
        "close_above_sma200": current_close > sma200,
        "sma50_above_sma200": sma50 > sma200,
    }


def registered_session_dates(manifest_path: Optional[Path]) -> Set[str]:
    """Return dates already registered in the sessions manifest."""
    if not manifest_path or not manifest_path.exists():
        return set()
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {item["date"] for item in data.get("sessions", []) if "date" in item}
    except Exception:
        return set()


def main():
    parser = argparse.ArgumentParser(description="Generate US Historical Daily Snapshots (point-in-time)")
    parser.add_argument("--pipeline-dir", type=Path, default=None, help="Path to US root data directory")
    parser.add_argument("--start-date", type=parse_date, required=True, help="Start Date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=parse_date, required=True, help="End Date (YYYY-MM-DD)")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/historical_snapshots/us"), help="Output directory for snapshot files")
    parser.add_argument("--update-sessions-manifest", type=Path, default=Path("frontend/public/data/us/sessions.json"), help="Path to us/sessions.json")
    parser.add_argument("--dry-run", action="store_true", help="Verify execution plan without generating files")
    args = parser.parse_args()

    pipeline_dir = args.pipeline_dir or Path(os.environ.get("EDL_US_BASE_DIR", ROOT_DIR / "DO NOT DELETE EDL PIPELINE"))
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Nexus Scanner US Historical Snapshot Backfill ===")
    print(f"Pipeline Directory: {pipeline_dir}")
    print(f"Target Window: {args.start_date} to {args.end_date}")
    print(f"Output Directory: {output_dir}")

    # 1. Load Thematic & Universe Metadata
    thematic_file = pipeline_dir / "us_thematic_universe.json"
    if not thematic_file.is_file():
        thematic_file = ROOT_DIR / "DO NOT DELETE EDL PIPELINE" / "us_thematic_universe.json"
    universe_meta: Dict[str, Dict[str, Any]] = {}
    if thematic_file.is_file():
        try:
            with open(thematic_file, "r", encoding="utf-8") as f:
                raw_thematic = json.load(f)
                universe_meta = raw_thematic.get("stocks") or raw_thematic
            print(f"Loaded {len(universe_meta)} stocks from thematic universe metadata.")
        except Exception as e:
            print(f"Warning: could not load thematic universe: {e}")

    # 2. Discover OHLCV CSVs
    ohlcv_dir = pipeline_dir / "ohlcv_data"
    if not ohlcv_dir.is_dir():
        print(f"Error: OHLCV directory not found at {ohlcv_dir}")
        sys.exit(1)

    csv_files = sorted(ohlcv_dir.glob("*.csv"))
    print(f"Found {len(csv_files)} stock OHLCV histories in {ohlcv_dir}")

    # 3. Load Benchmark History (SPY)
    spy_csv = pipeline_dir / "indices_ohlcv_data" / "SPY.csv"
    if not spy_csv.is_file():
        spy_csv = ohlcv_dir / "SPY.csv"
    spy_df = pd.DataFrame()
    if spy_csv.is_file():
        try:
            spy_df = pd.read_csv(spy_csv)
            spy_df["Date"] = pd.to_datetime(spy_df["Date"]).dt.date
            spy_df.sort_values("Date", inplace=True)
            print(f"Loaded SPY benchmark with {len(spy_df)} sessions.")
        except Exception as e:
            print(f"Warning: could not load SPY benchmark: {e}")

    # 4. Load Fundamentals History
    financials_by_symbol = {}
    q_file = pipeline_dir / "quarterly_financial_history.json.gz"
    if not q_file.is_file():
        q_file = pipeline_dir / "quarterly_financial_history.json"
    if q_file.is_file():
        try:
            q_bytes = q_file.read_bytes()
            q_data = json.loads(gzip.decompress(q_bytes) if q_bytes[:2] == b"\x1f\x8b" else q_bytes)
            for rec in q_data.get("records", []):
                financials_by_symbol.setdefault(rec["symbol"], []).append(rec)
            print(f"Loaded historical fundamentals for {len(financials_by_symbol)} symbols.")
        except Exception as e:
            print(f"Warning: could not load quarterly financials: {e}")

    # 5. Determine Trading Sessions in Target Window
    sessions_in_window = []
    curr = args.start_date
    while curr <= args.end_date:
        if calendar.is_nyse_session_day(curr):
            sessions_in_window.append(curr)
        curr += timedelta(days=1)

    registered = registered_session_dates(args.update_sessions_manifest)
    target_sessions = [s for s in sessions_in_window if s.isoformat() not in registered]
    print(f"NYSE sessions in window: {len(sessions_in_window)}. New to process: {len(target_sessions)}")

    if args.dry_run:
        print("[DRY RUN] Plan verified successfully. Exiting without generating files.")
        return

    # Pre-load stock histories for speed
    print("Loading OHLCV data into memory...")
    t_load = time.time()
    stock_histories = {}
    for csv_file in csv_files:
        sym = csv_file.stem.upper()
        try:
            df = pd.read_csv(csv_file)
            if df.empty or "Date" not in df.columns or "Close" not in df.columns:
                continue
            df["Date"] = pd.to_datetime(df["Date"]).dt.date
            df.sort_values("Date", inplace=True)
            stock_histories[sym] = df
        except Exception:
            continue
    print(f"Loaded {len(stock_histories)} stock histories in {time.time() - t_load:.1f}s.")

    # 6. Generate Historical Snapshots
    generated_sessions = []
    for session_date in target_sessions:
        session_str = session_date.isoformat()
        t_session = time.time()
        print(f"\nProcessing US session: {session_str}...")

        snapshot_stocks = []
        advances = 0
        declines = 0
        above_20dma = 0
        above_50dma = 0
        above_200dma = 0

        # SPY slice for RS calculations
        spy_sub = spy_df[spy_df["Date"] <= session_date] if not spy_df.empty else pd.DataFrame()
        spy_c = spy_sub["Close"].to_numpy() if not spy_sub.empty else np.array([])

        for sym, df in stock_histories.items():
            sub = df[df["Date"] <= session_date]
            if sub.empty:
                continue
            # Stock must have traded within last 7 calendar days to be considered active
            last_date = sub["Date"].iloc[-1]
            if (session_date - last_date).days > 7:
                continue

            c_vals = sub["Close"].to_numpy(dtype=float)
            o_vals = sub["Open"].to_numpy(dtype=float) if "Open" in sub else c_vals
            h_vals = sub["High"].to_numpy(dtype=float) if "High" in sub else c_vals
            l_vals = sub["Low"].to_numpy(dtype=float) if "Low" in sub else c_vals
            v_vals = sub["Volume"].to_numpy(dtype=float) if "Volume" in sub else np.ones_like(c_vals)

            tech = calculate_technicals_us(o_vals, c_vals, h_vals, l_vals, v_vals)
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

            # Point-in-time Financials
            fins = financials_by_symbol.get(sym, [])
            valid_fins = [f for f in fins if f.get("filing_date") and f["filing_date"][:10] <= session_str]
            latest_fin = sorted(valid_fins, key=lambda x: x.get("period_end") or x.get("quarter_end") or "")[-1] if valid_fins else None

            days_since_earnings = None
            if latest_fin and latest_fin.get("filing_date"):
                try:
                    filing_d = date.fromisoformat(latest_fin["filing_date"][:10])
                    days_since_earnings = max(0, (session_date - filing_d).days)
                except Exception:
                    pass

            meta = universe_meta.get(sym, {})
            name = meta.get("name") or sym
            sector = meta.get("sector") or "Unclassified"
            industry = meta.get("industry") or "Unclassified"

            # Reconstruct stock row for US snapshot
            item = {
                "symbol": sym,
                "name": name,
                "currency": "USD",
                "market": "us",
                "sector": sector,
                "industry": industry,
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
                "rupeeVolumeCrore": tech["turnover_m"],  # provider amount unit ($1M) in engine
                "turnoverCrore": tech["turnover_m"],
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
                "gapPct": tech["gapPct"],
                "return5yPct": tech["return5yPct"],
                "daysSinceEarnings": days_since_earnings,
                "earningsDate": latest_fin.get("filing_date")[:10] if latest_fin and latest_fin.get("filing_date") else None,
                "quarterlySales": latest_fin.get("sales") if latest_fin else None,
                "quarterlyNetProfit": latest_fin.get("net_profit") if latest_fin else None,
                "quarterlyEps": latest_fin.get("eps") if latest_fin else None,
                "quarterlyOpm": latest_fin.get("opm") if latest_fin else None,
                "marketCapCrore": (meta.get("market_cap") / 1e6) if meta.get("market_cap") and meta.get("market_cap") > 1e6 else meta.get("market_cap"),
                "shortFloatPct": meta.get("short_float_percent"),
                "shortRatio": meta.get("short_ratio"),
                "insiderOwnPct": meta.get("insider_own_percent"),
                "institutionalOwnPct": meta.get("institutional_own_percent"),
                "promoterHoldingPct": meta.get("insider_own_percent"),
                "fiiHoldingPct": meta.get("institutional_own_percent"),
                "metrics": {
                    "return5": round(((tech["close"] / c_vals[-6]) - 1) * 100, 2) if len(c_vals) >= 6 else None,
                    "return21": round(((tech["close"] / c_vals[-22]) - 1) * 100, 2) if len(c_vals) >= 22 else None,
                    "return63": round(((tech["close"] / c_vals[-64]) - 1) * 100, 2) if len(c_vals) >= 64 else None,
                    "return126": round(((tech["close"] / c_vals[-127]) - 1) * 100, 2) if len(c_vals) >= 127 else None,
                    "return252": round(((tech["close"] / c_vals[-253]) - 1) * 100, 2) if len(c_vals) >= 253 else None,
                    "turnover20": tech["daily_turnover_20_m"],
                    "turnover50": tech["daily_turnover_50_m"],
                    "turnover100": tech["daily_turnover_100_m"],
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
                    "breakout_52w": bool(tech["dist52wHighPct"] >= -2.0 and tech["rvol"] >= 1.5),
                    "vcp_contraction": bool(tech["adr20Pct"] <= 3.5 and tech["dist52wHighPct"] >= -15.0),
                    "gap_up_earnings": bool(tech["gapPct"] >= 3.0 and days_since_earnings is not None and days_since_earnings <= 3),
                },
            }
            snapshot_stocks.append(item)

        # Cross-sectional RS Rating (1-99 percentile)
        rs_candidates = []
        for s in snapshot_stocks:
            m = s["metrics"]
            if m["return63"] is not None and m["return126"] is not None and m["return252"] is not None:
                score = (0.4 * (m["return63"] or 0.0) +
                         0.2 * (m["return126"] or 0.0) +
                         0.2 * (m["return252"] or 0.0) +
                         0.2 * (m.get("return21") or 0.0))
                rs_candidates.append((s, score))

        if rs_candidates:
            rs_candidates.sort(key=lambda x: x[1])
            tot = len(rs_candidates)
            for rank_idx, (stk, _) in enumerate(rs_candidates):
                rs_rating = int(round((rank_idx / max(1, tot - 1)) * 98.0)) + 1
                stk["rsRsi"] = rs_rating
                stk["metrics"]["rsRating"] = rs_rating

        breadth_record = {
            "sessionDate": session_str,
            "advances": advances,
            "declines": declines,
            "unchanged": max(0, len(snapshot_stocks) - (advances + declines)),
            "above20dma": above_20dma,
            "above50dma": above_50dma,
            "above200dma": above_200dma,
            "totalStocks": len(snapshot_stocks),
        }

        # Build raw payload and hash
        raw_payload = {
            "schemaVersion": 4,
            "asOfDate": session_str,
            "market": "us",
            "currency": "USD",
            "amountUnit": 1_000_000,
            "totalStocks": len(snapshot_stocks),
            "stocks": snapshot_stocks,
            "breadth": breadth_record,
            "technicalMetricsVersion": 1,
            "extendedMetricsVersion": 1,
            "presetRuleMatchesVersion": 1,
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

    print(f"\nSuccessfully generated {len(generated_sessions)} historical daily snapshots in {output_dir}")

    # Update us/sessions.json manifest
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

        for s_date, s_hash in generated_sessions:
            s_str = s_date.strftime("%Y-%m-%d")
            existing[s_str] = {
                "date": s_str,
                "revision": s_hash,
                "label": s_str,
                "isHistorical": True,
                "market": "us",
            }

        sorted_sessions = sorted(existing.values(), key=lambda x: x["date"], reverse=True)
        manifest_payload = {
            "version": 1,
            "market": "us",
            "currency": "USD",
            "sessions": sorted_sessions,
        }
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(manifest_payload, f, indent=2)
            f.write("\n")
        print(f"Updated US sessions manifest at {manifest_file} ({len(sorted_sessions)} total sessions)")


if __name__ == "__main__":
    main()
