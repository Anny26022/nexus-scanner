"""US Historical Snapshot Backfill Engine (Up to 5 Years).

Reconstructs point-in-time daily snapshots ({session}.json.gz) for Nexus Scanner US from:
1. Daily EOD OHLCV history (the US root's ohlcv_data, NYSE sessions only)
2. Benchmark OHLCV (indices_ohlcv_data/SPY.csv), for RS ratings against SPY
3. Stock names and classification (Dhan's US screener list; Finviz's sector and industry where Dhan has none)
4. Reported earnings dates from the quarterly ledger (quarterly_financial_history.json.gz), when the root has it

Technicals reuse the live US implementations (edl_pipeline.scanner.indicators: SMA, EMA, Wilder RSI and ATR;
build_rs_ratings: SPY-relative RS). A value whose window is not yet filled stays null, as in the live snapshot.

Not point-in-time, so left null in every backfilled session: statement figures (the ledger holds today's restated
quarters, not what was known on the session), market cap, ownership and short interest (current values only).
"""

import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional, Set

import numpy as np
import pandas as pd

# Add paths for EDL pipeline and frontend modules
ROOT_DIR = Path(__file__).resolve().parent.parent
EDL_ROOT = ROOT_DIR / "DO NOT DELETE EDL PIPELINE"
EDL_SRC = EDL_ROOT / "src"
FRONTEND_DIR = ROOT_DIR / "frontend"
for p in (str(EDL_ROOT), str(EDL_SRC), str(FRONTEND_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from edl_pipeline.markets.us import calendar  # noqa: E402
from edl_pipeline.scanner.indicators import indicator_series  # noqa: E402
from build_rs_ratings import close_history, rank_first_ratings, relative_strength_scores  # noqa: E402

OHLCV_COLUMNS = ["Open", "High", "Low", "Close", "Volume"]
SESSIONS_52W = 252
SESSIONS_5Y = 1260
RETURN_HORIZONS = (5, 21, 63, 126, 252)


def parse_date(date_str: str) -> date:
    return date.fromisoformat(date_str)


def session_frame(df: pd.DataFrame) -> pd.DataFrame:
    """A history's NYSE-session bars, numeric, oldest first, one bar per date; empty when columns are missing."""
    if df.empty or "Date" not in df.columns or any(column not in df.columns for column in OHLCV_COLUMNS):
        return pd.DataFrame(columns=["Date", *OHLCV_COLUMNS])
    frame = df[["Date", *OHLCV_COLUMNS]].copy()
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce").dt.normalize()
    for column in OHLCV_COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.replace([np.inf, -np.inf], np.nan).dropna()
    # A bar on a weekend or NYSE holiday is not a session (a copied quote or a provider artefact).
    frame = frame[frame["Date"].dt.date.map(calendar.is_nyse_session_day).astype(bool)]
    return frame.sort_values("Date").drop_duplicates("Date", keep="last").reset_index(drop=True)


def technical_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Per-session indicators for a session_frame; each row uses only that bar and earlier ones.

    Warm-up rows stay NaN until the indicator's full window exists (no shortened windows).
    """
    close, high, low, volume, open_ = frame["Close"], frame["High"], frame["Low"], frame["Volume"], frame["Open"]
    previous_close = close.shift(1)
    out = pd.DataFrame(index=frame.index)
    out["open"], out["high"], out["low"], out["close"], out["volume"] = open_, high, low, close, volume
    out["changePct"] = (close / previous_close.where(previous_close > 0) - 1.0) * 100.0
    out["gapPct"] = (open_ / previous_close.where(previous_close > 0) - 1.0) * 100.0
    for period in (10, 20, 50, 200):
        out[f"sma{period}"] = indicator_series(frame, "SMA", period)
    for period in (20, 50, 200):
        out[f"ema{period}"] = indicator_series(frame, "EMA", period)
    # Wilder RSI and ATR, the live US implementations (build.stock_metrics, advanced_metrics_processor).
    out["rsi14"] = indicator_series(frame, "RSI", 14)
    out["atr14"] = indicator_series(frame, "ATR", 14)
    # Relative volume against the prior 20 sessions, as the live relative_volume_20.
    prior_volume = volume.shift(1).rolling(20, min_periods=20).mean()
    out["rvol"] = volume / prior_volume.where(prior_volume > 0)
    traded_m = close * volume / 1e6
    out["turnover_m"] = traded_m
    for period in (20, 50, 100):
        out[f"daily_turnover_{period}_m"] = traded_m.rolling(period, min_periods=period).mean()
    high_52w = high.rolling(SESSIONS_52W, min_periods=SESSIONS_52W).max()
    low_52w = low.rolling(SESSIONS_52W, min_periods=SESSIONS_52W).min()
    out["dist52wHighPct"] = (close - high_52w) / high_52w.where(high_52w > 0) * 100.0
    out["dist52wLowPct"] = (close - low_52w) / low_52w.where(low_52w > 0) * 100.0
    all_time_high, all_time_low = high.cummax(), low.cummin()
    out["allTimeHigh"], out["allTimeLow"] = all_time_high, all_time_low
    out["distAthPct"] = (close - all_time_high) / all_time_high.where(all_time_high > 0) * 100.0
    # The live adr_percent_20: mean of (High - Low) / Low over 20 sessions.
    out["adr20Pct"] = ((high - low) / low.where(low > 0) * 100.0).rolling(20, min_periods=20).mean()
    out["return5yPct"] = (close / close.shift(SESSIONS_5Y).where(lambda s: s > 0) - 1.0) * 100.0
    for horizon in RETURN_HORIZONS:
        out[f"return{horizon}"] = (close / close.shift(horizon).where(lambda s: s > 0) - 1.0) * 100.0
    out["historySessions"] = np.arange(1, len(frame) + 1)
    return out


def _number(value: Any, digits: int = 2) -> Optional[float]:
    if value is None:
        return None
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


def _above(left: Optional[float], right: Optional[float]) -> Optional[bool]:
    """left > right, or None when either is unavailable (never a false negative from missing history)."""
    return None if left is None or right is None else bool(left > right)


ROUNDED = ("open", "high", "low", "close", "changePct", "gapPct", "sma10", "sma20", "sma50", "sma200",
           "ema20", "ema50", "ema200", "rsi14", "atr14", "rvol", "turnover_m", "daily_turnover_20_m",
           "daily_turnover_50_m", "daily_turnover_100_m", "dist52wHighPct", "dist52wLowPct", "allTimeHigh",
           "allTimeLow", "distAthPct", "adr20Pct", "return5yPct", *(f"return{h}" for h in RETURN_HORIZONS))


def row_technicals(row: pd.Series) -> Dict[str, Any]:
    tech: Dict[str, Any] = {key: _number(row[key]) for key in ROUNDED}
    tech["volume"] = int(row["volume"])
    tech["historySessions"] = int(row["historySessions"])
    tech["close_above_sma20"] = _above(tech["close"], tech["sma20"])
    tech["close_above_sma50"] = _above(tech["close"], tech["sma50"])
    tech["close_above_sma200"] = _above(tech["close"], tech["sma200"])
    tech["sma50_above_sma200"] = _above(tech["sma50"], tech["sma200"])
    return tech


def calculate_technicals_us(opens: np.ndarray, closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, volumes: np.ndarray) -> Dict[str, Any]:
    """Core US screener indicators for the last of these consecutive session bars."""
    if len(closes) == 0:
        return {}
    frame = pd.DataFrame({"Open": opens, "High": highs, "Low": lows, "Close": closes, "Volume": volumes},
                         dtype=float).reset_index(drop=True)
    return row_technicals(technical_frame(frame).iloc[-1])


def preset_matches(tech: Dict[str, Any], days_since_earnings: Optional[int]) -> Dict[str, bool]:
    """The preset rules; a rule whose inputs are unavailable does not match."""
    def ready(*keys):
        return all(tech.get(key) is not None for key in keys)

    trend = ready("close_above_sma50", "close_above_sma200", "sma50_above_sma200") and bool(
        tech["close_above_sma50"] and tech["close_above_sma200"] and tech["sma50_above_sma200"])
    return {
        "trend_template": trend,
        "lib-stage-two": trend,
        "lib-52w-high-breakout": ready("dist52wHighPct") and tech["dist52wHighPct"] >= -0.5,
        "lib-20d-high-thrust": ready("changePct", "rvol") and tech["changePct"] >= 4.0 and tech["rvol"] >= 2.0,
        "mom_rvol": ready("rvol") and tech["rvol"] >= 1.5,
        "breakout_52w": ready("dist52wHighPct", "rvol") and tech["dist52wHighPct"] >= -2.0 and tech["rvol"] >= 1.5,
        "vcp_contraction": ready("adr20Pct", "dist52wHighPct") and tech["adr20Pct"] <= 3.5 and tech["dist52wHighPct"] >= -15.0,
        "gap_up_earnings": ready("gapPct") and tech["gapPct"] >= 3.0 and days_since_earnings is not None and days_since_earnings <= 3,
    }


def rs_ratings_vs_spy(close_histories: Dict[str, pd.DataFrame], spy: pd.DataFrame, session_date: date) -> Dict[str, int]:
    """Front-weighted RS ratings against SPY for one session, by the live build_rs_ratings method.

    `close_histories` are each stock's Date/Close bars up to the session; the universe is that session's stocks.
    """
    benchmark = spy[spy["Date"].dt.date <= session_date]
    if benchmark.empty or benchmark["Date"].iloc[-1].date() != session_date:
        return {}
    scores: Dict[str, Dict[str, float]] = {}
    for symbol, history in close_histories.items():
        relative = relative_strength_scores(history, benchmark, session_date)
        if relative is not None:
            for key, value in relative.items():
                scores.setdefault(key, {})[symbol] = value
    if not scores:
        return {}
    return rank_first_ratings(scores).get("front_weighted", {})


def registered_session_dates(manifest_path: Optional[Path]) -> Set[str]:
    """Dates already registered in the sessions manifest; only a missing manifest means none.

    A manifest that exists but cannot be read raises, so a backfill never rewrites the archive index from scratch.
    """
    if not manifest_path or not manifest_path.exists():
        return set()
    return set(read_sessions_manifest(manifest_path))


def read_sessions_manifest(manifest_path: Path) -> Dict[str, Dict[str, Any]]:
    with open(manifest_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    sessions = data.get("sessions") if isinstance(data, dict) else None
    if not isinstance(sessions, list) or not all(isinstance(item, dict) and item.get("date") for item in sessions):
        raise ValueError(f"Invalid sessions manifest at {manifest_path}: expected a sessions list with dates")
    return {item["date"]: item for item in sessions}


def write_atomically(path: Path, data: bytes):
    """Write next to the destination, then rename, so an interrupted run never leaves a partial file there."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def load_stock_metadata(pipeline_dir: Path, fetch_universe: Optional[Callable[[str], List[dict]]] = None) -> Dict[str, Dict[str, Any]]:
    """Each symbol's name, sector and industry: Dhan's US screener list (the live build's source), then Finviz's.

    Reads the root's mainboard_scanx_data.json when a build left one; otherwise fetches the list from Dhan.
    """
    listing = pipeline_dir / "mainboard_scanx_data.json"
    if listing.is_file():
        rows = json.loads(listing.read_text(encoding="utf-8"))
    else:
        if fetch_universe is None:
            from edl_pipeline.markets.us import dhan
            fetch_universe = dhan.fetch_universe
        rows = fetch_universe("stock")
    metadata: Dict[str, Dict[str, Any]] = {}
    for row in rows or []:
        symbol = str(row.get("Sym") or "").strip().upper()
        if symbol:
            metadata[symbol] = {"name": row.get("DispSym") or None, "sector": row.get("Sector") or None,
                                "industry": row.get("SubSector") or None}
    ownership_file = pipeline_dir / "us_ownership_universe.json"
    if not ownership_file.is_file():
        ownership_file = EDL_ROOT / "us_ownership_universe.json"
    if ownership_file.is_file():
        for symbol, entry in json.loads(ownership_file.read_text(encoding="utf-8")).items():
            meta = metadata.setdefault(str(symbol).upper(), {"name": None, "sector": None, "industry": None})
            meta["sector"] = meta["sector"] or entry.get("finviz_sector") or None
            meta["industry"] = meta["industry"] or entry.get("finviz_industry") or None
    return metadata


def load_reported_earnings(pipeline_dir: Path) -> Dict[str, List[str]]:
    """Each symbol's reported earnings dates (oldest first); estimated filing dates are left out."""
    q_file = pipeline_dir / "quarterly_financial_history.json.gz"
    if not q_file.is_file():
        q_file = pipeline_dir / "quarterly_financial_history.json"
    if not q_file.is_file():
        print("Quarterly ledger not in the root; earnings dates are unavailable.")
        return {}
    q_bytes = q_file.read_bytes()
    q_data = json.loads(gzip.decompress(q_bytes) if q_bytes[:2] == b"\x1f\x8b" else q_bytes)
    reported: Dict[str, Set[str]] = {}
    for rec in q_data.get("records", []):
        filing = (rec.get("filing_date") or "")[:10]
        if rec.get("symbol") and filing and rec.get("filing_date_basis", "reported") != "estimated":
            reported.setdefault(str(rec["symbol"]).upper(), set()).add(filing)
    return {symbol: sorted(dates) for symbol, dates in reported.items()}


def build_stock_row(symbol: str, tech: Dict[str, Any], meta: Dict[str, Any], session_str: str, metadata_as_of: str,
                    earnings_date: Optional[str], days_since_earnings: Optional[int]) -> Dict[str, Any]:
    return {
        "symbol": symbol,
        "name": meta.get("name") or symbol,
        "currency": "USD",
        "market": "us",
        "sector": meta.get("sector"),
        "industry": meta.get("industry"),
        "asOfDate": session_str,
        # Names and classification are today's (they rarely change); everything below is as of the session.
        "metadataAsOfDate": metadata_as_of,
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
        "earningsDate": earnings_date,
        # No point-in-time source: the ledger holds today's (possibly restated) quarters, and market cap,
        # ownership and short interest are current values. Unavailable rather than misdated.
        "quarterlySales": None,
        "quarterlyNetProfit": None,
        "quarterlyEps": None,
        "quarterlyOpm": None,
        "marketCapCrore": None,
        "shortFloatPct": None,
        "shortRatio": None,
        "insiderOwnPct": None,
        "institutionalOwnPct": None,
        "promoterHoldingPct": None,
        "fiiHoldingPct": None,
        "metrics": {
            **{f"return{h}": tech[f"return{h}"] for h in (5, 21, 63, 126, 252)},
            "turnover20": tech["daily_turnover_20_m"],
            "turnover50": tech["daily_turnover_50_m"],
            "turnover100": tech["daily_turnover_100_m"],
            "gapPct": tech["gapPct"],
            "historySessions": tech["historySessions"],
            **{key: tech[key] for key in ("sma10", "sma20", "sma50", "sma200", "ema20", "ema50", "ema200", "rsi14")},
        },
        "presetMatches": preset_matches(tech, days_since_earnings),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate US Historical Daily Snapshots (point-in-time)")
    parser.add_argument("--pipeline-dir", type=Path, default=None, help="Path to US root data directory")
    parser.add_argument("--start-date", type=parse_date, required=True, help="Start Date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=parse_date, required=True, help="End Date (YYYY-MM-DD)")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/historical_snapshots/us"), help="Output directory for snapshot files")
    parser.add_argument("--update-sessions-manifest", type=Path, default=Path("frontend/public/data/us/sessions.json"), help="Path to us/sessions.json")
    parser.add_argument("--dry-run", action="store_true", help="Verify execution plan without generating files")
    args = parser.parse_args()
    if args.start_date > args.end_date:
        parser.error(f"--start-date {args.start_date} is after --end-date {args.end_date}")

    pipeline_dir = args.pipeline_dir or Path(os.environ.get("EDL_US_BASE_DIR", EDL_ROOT))
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=== Nexus Scanner US Historical Snapshot Backfill ===")
    print(f"Pipeline Directory: {pipeline_dir}")
    print(f"Target Window: {args.start_date} to {args.end_date}")
    print(f"Output Directory: {output_dir}")

    # 1. Discover OHLCV CSVs and the SPY benchmark (both required)
    ohlcv_dir = pipeline_dir / "ohlcv_data"
    if not ohlcv_dir.is_dir() or not any(ohlcv_dir.glob("*.csv")):
        sys.exit(f"Error: no US price history at {ohlcv_dir}; run the US daily refresh to seed it first.")
    spy_csv = pipeline_dir / "indices_ohlcv_data" / "SPY.csv"
    if not spy_csv.is_file():
        sys.exit(f"Error: SPY benchmark history missing at {spy_csv}; RS ratings need it.")
    csv_files = sorted(ohlcv_dir.glob("*.csv"))
    print(f"Found {len(csv_files)} stock OHLCV histories in {ohlcv_dir}")

    # 2. Determine trading sessions in the target window (read the manifest first: an unreadable one stops here)
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
    if not target_sessions:
        return

    spy_df = close_history(spy_csv)
    spy_df["Date"] = spy_df["Date"].dt.normalize()
    print(f"Loaded SPY benchmark with {len(spy_df)} sessions.")
    universe_meta = load_stock_metadata(pipeline_dir)
    metadata_as_of = date.today().isoformat()
    print(f"Loaded names and classification for {len(universe_meta)} symbols.")
    earnings_by_symbol = load_reported_earnings(pipeline_dir)

    # 3. Pre-compute each stock's per-session technicals once (each row only reads earlier bars)
    print("Loading OHLCV data into memory...")
    t_load = time.time()
    latest_target = max(target_sessions)
    stocks = {}
    for csv_file in csv_files:
        sym = csv_file.stem.upper()
        try:
            frame = session_frame(pd.read_csv(csv_file))
        except Exception as error:
            print(f"  skipped {sym}: {error}")
            continue
        frame = frame[frame["Date"].dt.date <= latest_target].reset_index(drop=True)
        if frame.empty:
            continue
        stocks[sym] = {
            "rows": {d: i for i, d in enumerate(frame["Date"].dt.date)},
            "technicals": technical_frame(frame),
            "closes": frame[["Date", "Close"]],
        }
    print(f"Loaded {len(stocks)} stock histories in {time.time() - t_load:.1f}s.")

    # 4. Generate historical snapshots
    generated_sessions = []
    for session_date in target_sessions:
        session_str = session_date.isoformat()
        t_session = time.time()
        print(f"\nProcessing US session: {session_str}...")

        snapshot_stocks = []
        close_histories = {}
        advances = declines = above_20dma = above_50dma = above_200dma = 0

        for sym, stock in stocks.items():
            # Only a stock with a bar on this very session is in it (no stale or carried-forward bar).
            position = stock["rows"].get(session_date)
            if position is None:
                continue
            tech = row_technicals(stock["technicals"].iloc[position])
            close_histories[sym] = stock["closes"].iloc[:position + 1]

            # Breadth tallies; a stock without the window's history is not counted either way.
            if tech["changePct"] is not None:
                if tech["changePct"] > 0:
                    advances += 1
                elif tech["changePct"] < 0:
                    declines += 1
            above_20dma += tech["close_above_sma20"] is True
            above_50dma += tech["close_above_sma50"] is True
            above_200dma += tech["close_above_sma200"] is True

            earnings = [d for d in earnings_by_symbol.get(sym, ()) if d <= session_str]
            earnings_date = earnings[-1] if earnings else None
            days_since_earnings = (session_date - date.fromisoformat(earnings_date)).days if earnings_date else None

            snapshot_stocks.append(build_stock_row(sym, tech, universe_meta.get(sym, {}), session_str, metadata_as_of,
                                                   earnings_date, days_since_earnings))

        # RS Rating vs SPY (1-99), as build_rs_ratings ranks the live US release
        ratings = rs_ratings_vs_spy(close_histories, spy_df, session_date)
        for stk in snapshot_stocks:
            rating = ratings.get(stk["symbol"])
            stk["rsRsi"] = rating
            stk["metrics"]["rsRating"] = rating

        breadth_record = {
            "sessionDate": session_str,
            "advances": advances,
            "declines": declines,
            "unchanged": max(0, len(snapshot_stocks) - (advances + declines)),
            "above20dma": int(above_20dma),
            "above50dma": int(above_50dma),
            "above200dma": int(above_200dma),
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
        payload = json.dumps(raw_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        write_atomically(out_file, gzip.compress(payload, mtime=0))

        file_size_kb = out_file.stat().st_size / 1024
        print(f"Generated {out_file.name} ({len(snapshot_stocks)} stocks, {file_size_kb:.1f} KB, rev {session_hash[:12]}) in {time.time()-t_session:.2f}s")
        generated_sessions.append((session_date, session_hash))

    print(f"\nSuccessfully generated {len(generated_sessions)} historical daily snapshots in {output_dir}")

    # Update us/sessions.json manifest
    if args.update_sessions_manifest and generated_sessions:
        manifest_file = args.update_sessions_manifest.resolve()
        existing = read_sessions_manifest(manifest_file) if manifest_file.exists() else {}

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
        write_atomically(manifest_file, (json.dumps(manifest_payload, indent=2) + "\n").encode("utf-8"))
        print(f"Updated US sessions manifest at {manifest_file} ({len(sorted_sessions)} total sessions)")


if __name__ == "__main__":
    main()
