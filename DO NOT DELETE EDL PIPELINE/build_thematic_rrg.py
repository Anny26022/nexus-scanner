"""Build Thematic Relative Rotation Graph (RRG) Artifacts.

Tracks capital rotation, relative strength, and momentum shifts across our
existing 28 Thematic Blocks and their constituent Niches.

Methodology:
- X-axis: 3-Month Median Excess Return vs Nifty 500 (63 trading days)
- Y-axis: 1-Month Change in Aggregated Relative Strength Rating (21 trading days)
- Quadrants:
    * Leading:    X >= 0, Y >= 0 (Outperforming & Gaining RS)
    * Weakening:  X >= 0, Y < 0  (Outperforming & Losing RS)
    * Lagging:    X < 0,  Y < 0  (Underperforming & Losing RS)
    * Improving:  X < 0,  Y >= 0 (Underperforming & Gaining RS)
- 12-week historical rotation trails (weekly steps T-12 to T0)
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

from pipeline_utils import BASE_DIR, save_json, compress_file
from ohlcv_utils import read_ohlcv_csv, valid_ohlcv_values
from build_rs_ratings import FRONT_WEIGHTED_HORIZONS, rank_first_ratings


# The main RRG is intended to reflect investable institutional rotation. Keep
# these gates local to this artifact: the scanner and breadth universes have
# their own documented eligibility contracts.
RRG_MIN_MARKET_CAP_CR = 999.0
RRG_MIN_CLOSE = 10.0
RRG_MIN_TURNOVER30_CR = 5.0
RRG_MIN_MAIN_HISTORY_SESSIONS = 65
RRG_MIN_CONSTITUENTS = 3
RRG_TURNOVER_WINDOW = 20

# The compact NSE thematic-index universe shown beside the taxonomy RRG. The
# source names account for provider spelling while display names remain stable.
THEMATIC_INDEXES = {
    "Nifty India Defence": "Nifty India Defence",
    "Nifty IPO": "Nifty IPO",
    "Nifty Capital Markets": "Nifty Capital Markets",
    "Nifty Sugar & Ethanol": "Nifty Sugar & Ethanol Index",
    "Nifty AI Catalysts": "Nifty AI Catalysts",
    "Nifty India Digital": "Nifty India Digital",
    "Nifty India Internet": "Nifty India Internet Index",
    "Nifty India Manufacturing": "Nifty India Manufacturing",
    "Nifty Small Finance Banks & Microfinance Institutions": "Nifty Small Finance Banks & Microfinance Institutions Index",
    "Nifty EV & New Age Automotive": "Nifty EV and New Age Auto",
    "Nifty India New Age Consumption": "Nifty India New Age Consumption",
    "Nifty Transportation & Logistics": "Nifty Transportation Logistics",
    "Nifty Mobility": "Nifty Mobility",
    "Nifty Energy": "Nifty Energy",
    "Nifty Services Sector": "Nifty Services Sector",
    "Nifty Waves": "Nifty Waves Index",
    "Nifty India Infrastructure & Logistics": "Nifty India Infrastructure & Logistics Index",
    "Nifty India Tourism": "Nifty India Tourism",
    "Nifty Infrastructure": "NIFTY Infra",
    "Nifty India Consumption": "NIFTY Consumption",
    "Nifty Commodities": "Nifty Commodities",
    "Nifty Housing": "Nifty Housing",
    "Nifty Non-Cyclical Consumer": "Nifty Non Cyclical Consumer",
    "Nifty MNC": "NIFTY MNC",
    "Nifty Core Housing": "Nifty Core Housing",
    "Nifty PSE": "Nifty PSE",
    "Nifty Rural": "Nifty Rural",
    "Nifty CPSE": "Nifty CPSE",
    "Nifty India Railways PSU": "Nifty India Railways PSU Index",
}


def _parse_iso_or_nse_date(value):
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if len(s) == 10 and s[4] == '-' and s[7] == '-':
        try:
            return datetime.strptime(s, '%Y-%m-%d').date()
        except Exception:
            return None
    try:
        return datetime.strptime(s, '%d-%b-%Y').date()
    except Exception:
        return None


def determine_quadrant(x: float, y: float) -> str:
    if x >= 0.0:
        return "Leading" if y >= 0.0 else "Weakening"
    else:
        return "Improving" if y >= 0.0 else "Lagging"


def finite_number(value: Any) -> float | None:
    """Return a finite numeric value without accepting malformed metadata."""
    try:
        number = float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def market_cap_crore(stock_meta: dict[str, Any]) -> float | None:
    for key in ("marketCapCrore", "market_cap_crore", "market_cap_cr"):
        value = finite_number(stock_meta.get(key))
        if value is not None:
            return value
    return None


def turnover30_crore(stock_meta: dict[str, Any]) -> float | None:
    metrics = stock_meta.get("metrics") or {}
    for key in ("avg_rupee_volume_30_crore", "turnover30_crore", "turnover30"):
        val = finite_number(stock_meta.get(key) if stock_meta.get(key) is not None else metrics.get(key))
        if val is not None:
            return val
    return None


def institutional_rrg_symbols(
    histories: dict[str, tuple[list[str], np.ndarray]],
    stock_map: dict[str, dict[str, Any]],
) -> set[str]:
    """Return the main-RRG universe after the documented investability gates."""
    eligible: set[str] = set()
    for symbol, (_, closes) in histories.items():
        meta = stock_map.get(symbol, {})
        market_cap = market_cap_crore(meta)
        turnover30 = turnover30_crore(meta)
        if (
            len(closes) >= RRG_MIN_MAIN_HISTORY_SESSIONS
            and market_cap is not None
            and market_cap > RRG_MIN_MARKET_CAP_CR
            and float(closes[-1]) > RRG_MIN_CLOSE
            and turnover30 is not None
            and turnover30 > RRG_MIN_TURNOVER30_CR
        ):
            eligible.add(symbol)
    return eligible


def rolling_rs_ratings(
    histories: dict[str, tuple[list[str], np.ndarray]],
    benchmark: np.ndarray,
    offsets: set[int],
) -> dict[int, dict[str, int]]:
    """Rebuild the published cross-sectional RS rating at every trail anchor."""
    ratings_by_offset: dict[int, dict[str, int]] = {}
    for offset in sorted(offsets):
        idx = -1 - offset
        scores = {name: {} for name in FRONT_WEIGHTED_HORIZONS}
        for symbol, (_, closes) in histories.items():
            n = len(closes)
            if abs(idx) > n or abs(idx - max(FRONT_WEIGHTED_HORIZONS.values())) > n:
                continue
            ratios: dict[str, float] = {}
            for name, horizon in FRONT_WEIGHTED_HORIZONS.items():
                stock_start, stock_end = closes[idx - horizon], closes[idx]
                benchmark_start, benchmark_end = benchmark[idx - horizon], benchmark[idx]
                if min(stock_start, stock_end, benchmark_start, benchmark_end) <= 0:
                    ratios = {}
                    break
                ratios[name] = (stock_end / stock_start) / (benchmark_end / benchmark_start)
            if len(ratios) == len(FRONT_WEIGHTED_HORIZONS):
                for name, ratio in ratios.items():
                    scores[name][symbol] = float(ratio)
        ratings_by_offset[offset] = rank_first_ratings(scores).get("front_weighted", {})
    return ratings_by_offset


def load_theme_classification(frontend_dir: Path) -> dict[str, dict]:
    """Load canonical Theme -> Block -> Macro mapping from theme-classification."""
    # The editable taxonomy is canonical for thematic RRGs. Revision files are
    # immutable snapshots and must not hide newer taxonomy changes.
    source_p = frontend_dir / "theme_tracker_source.json"
    src: dict[str, Any] = {}
    if source_p.exists():
        try:
            with open(source_p, "r", encoding="utf-8") as f:
                src = json.load(f)
            blocks_map = {t["name"]: b["title"] for b in src["blocks"] for t in b["themes"]}
            macros_map = {b: m["title"] for m in src["macros"] for b in m["blocks"]}
            fields = src.get("fields", [])
            records = {}
            for row in src.get("rows", []):
                item = dict(zip(fields, row))
                symbol, theme = item.get("symbol"), item.get("theme")
                if symbol:
                    symbol = str(symbol).upper()
                    block = blocks_map.get(theme) or item.get("sector")
                    records[symbol] = {
                        "theme": theme,
                        "block": block,
                        "macro": macros_map.get(block),
                        "memberships": {theme: item.get("provenance") or "source"} if theme else {},
                    }
            # Theme definitions may intentionally add a stock to an extra niche
            # without changing its primary row classification.
            for block_def in src.get("blocks", []):
                block = block_def.get("title")
                for theme_def in block_def.get("themes", []):
                    theme = theme_def.get("name")
                    if not theme:
                        continue
                    for symbol in theme_def.get("symbols", []):
                        symbol = str(symbol).upper()
                        record = records.setdefault(symbol, {
                            "theme": theme,
                            "block": block,
                            "macro": macros_map.get(block),
                            "memberships": {},
                        })
                        record.setdefault("memberships", {})[theme] = "source"
            if records:
                return records
        except (OSError, ValueError, KeyError, TypeError):
            pass

    # Fall back to published classifications only when the source taxonomy is unavailable.
    tax_paths = [
        frontend_dir / "public/data/universe-classification.json",
    ]
    # Check revision directories
    rev_dir = frontend_dir / "public/data/revisions"
    if rev_dir.exists():
        for p in rev_dir.glob("*/theme-classification.json*"):
            tax_paths.insert(0, p)

    for p in tax_paths:
        if p.exists():
            try:
                if str(p).endswith(".gz"):
                    with gzip.open(p, "rt", encoding="utf-8") as f:
                        d = json.load(f)
                else:
                    with open(p, "r", encoding="utf-8") as f:
                        d = json.load(f)
                if "records" in d and isinstance(d["records"], dict):
                    # Check if nested thematic exists
                    first_val = next(iter(d["records"].values()), {})
                    if "thematic" in first_val:
                        return {s: r["thematic"] for s, r in d["records"].items()}
                    return d["records"]
            except Exception:
                continue

    return {}


def safe_index_filename(symbol: str, index_id: Any = None, disambiguate: bool = False) -> str:
    safe_symbol = "".join(char if char.isalnum() else "_" for char in str(symbol))
    if not disambiguate:
        return safe_symbol
    safe_id = "".join(char if char.isalnum() else "_" for char in str(index_id))
    return f"{safe_symbol}__{safe_id}"


def thematic_index_histories(root: Path, bench_dates: list[str]) -> list[dict[str, Any]]:
    """Load official NSE thematic-index closes aligned to benchmark sessions."""
    index_list = root / "all_indices_list.json"
    index_dir = root / "indices_ohlcv_data"
    if not index_list.exists() or not index_dir.exists():
        return []
    try:
        all_indices = json.loads(index_list.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    counts = Counter(safe_index_filename(row.get("Symbol") or "") for row in all_indices)
    by_name = {str(row.get("IndexName") or "").casefold(): row for row in all_indices}
    histories = []
    for display_name, source_name in THEMATIC_INDEXES.items():
        row = by_name.get(source_name.casefold())
        if not row:
            continue
        symbol = str(row.get("Symbol") or "")
        filename = safe_index_filename(symbol, row.get("IndexID"), counts[safe_index_filename(symbol)] > 1)
        path = index_dir / f"{filename}.csv"
        if not path.exists():
            continue
        try:
            frame = pd.read_csv(path, usecols=["Date", "Close"])
            frame["Date"] = frame["Date"].astype(str).str[:10]
            frame["Close"] = pd.to_numeric(frame["Close"], errors="coerce")
            prices = {
                date: float(close)
                for date, close in zip(frame["Date"], frame["Close"])
                if np.isfinite(close) and close > 0
            }
        except (OSError, ValueError, KeyError):
            continue
        # 63 sessions for the relative-return rank, 21 before it for the
        # momentum delta, and 12 weekly replay anchors.
        required_dates = [bench_dates[-1 - offset] for offset in range(63 + 21 + 12 * 5 + 1)]
        if all(date in prices for date in required_dates):
            histories.append({"name": display_name, "symbol": symbol, "prices": prices})
    return histories


def index_rs_ratings(
    histories: list[dict[str, Any]], bench_dates: list[str], bench_closes: np.ndarray, offsets: set[int],
) -> dict[int, dict[str, int]]:
    """Cross-sectional 3-month index-relative ratings at each replay anchor."""
    ratings: dict[int, dict[str, int]] = {}
    for offset in sorted(offsets):
        end_idx, start_idx = -1 - offset, -1 - offset - 63
        benchmark_ratio = bench_closes[end_idx] / bench_closes[start_idx]
        scores = []
        for history in histories:
            prices = history["prices"]
            start, end = prices.get(bench_dates[start_idx]), prices.get(bench_dates[end_idx])
            if start and end and benchmark_ratio > 0:
                scores.append((history["name"], (end / start) / benchmark_ratio))
        ordered = sorted(scores, key=lambda item: (-item[1], item[0]))
        ratings[offset] = {
            name: int(np.floor(99 - 98 * position / max(1, len(ordered) - 1) + 0.5))
            for position, (name, _) in enumerate(ordered)
        }
    return ratings


def build_thematic_rrg_payload(
    root: Path,
    frontend_dir: Path,
    ohlcv_dir: Path | None = None,
    trail_weeks: int = 12,
) -> dict[str, Any]:
    root = Path(root)
    frontend_dir = Path(frontend_dir)
    ohlcv_dir = Path(ohlcv_dir) if ohlcv_dir else (root / "ohlcv_data")

    # 1. Load benchmark closes (NIFTY 500)
    bench_csv = root / "indices_ohlcv_data" / "NIFTY_500.csv"
    if not bench_csv.exists():
        raise FileNotFoundError(f"Benchmark file {bench_csv} not found.")

    bench_df = pd.read_csv(bench_csv)
    bench_c = bench_df["Close"].values
    bench_dates = [str(d).split()[0] for d in bench_df["Date"].values]
    as_of_date = bench_dates[-1]

    # 2. Load stock fundamentals / metadata
    stocks_gz = root / "all_stocks_fundamental_analysis.json.gz"
    stocks_json = root / "all_stocks_fundamental_analysis.json"
    if stocks_gz.exists():
        with gzip.open(stocks_gz, "rt", encoding="utf-8") as f:
            stocks_list = json.load(f)
    elif stocks_json.exists():
        with open(stocks_json, "r", encoding="utf-8") as f:
            stocks_list = json.load(f)
    else:
        stocks_list = []

    stock_map = {s.get("symbol", "").upper(): s for s in stocks_list if s.get("symbol")}

    # 3. Load RS ratings artifact
    rs_file = root / "rs_rating_daily.json"
    rs_data = {}
    if rs_file.exists():
        with open(rs_file, "r", encoding="utf-8") as f:
            rs_data = json.load(f).get("ratings", {})

    # 4. Load Theme Classification
    tax_records = load_theme_classification(frontend_dir)
    if not tax_records:
        raise ValueError("Could not load theme taxonomy records.")

    # 5. Load stock close histories for constituent universe
    histories: dict[str, tuple[list[str], np.ndarray]] = {}
    turnover20_by_symbol: dict[str, float] = {}
    for sym in tax_records.keys():
        sym_u = sym.upper()
        p = ohlcv_dir / f"{sym_u}.csv"
        if p.exists():
            rows = read_ohlcv_csv(p)
            if len(rows) >= 5:
                d_list, c_list, turnover_list = [], [], []
                for r in rows:
                    v = valid_ohlcv_values(r)
                    if v:
                        d_str = str(r.get("Date", "")).split()[0]
                        if d_str <= as_of_date:
                            d_list.append(d_str)
                            c_list.append(v[3])
                            turnover_list.append((v[3] * v[4]) / 1e7)
                if len(c_list) >= 5:
                    histories[sym_u] = (d_list, np.array(c_list, dtype=float))
                    if len(turnover_list) >= RRG_TURNOVER_WINDOW:
                        turnover20_by_symbol[sym_u] = float(np.median(turnover_list[-RRG_TURNOVER_WINDOW:]))

    print(f"Loaded {len(histories)} stock histories for RRG calculation.")
    rrg_symbols = institutional_rrg_symbols(histories, stock_map)
    print(
        f"Institutional RRG universe: {len(rrg_symbols)} symbols "
        f"(market cap > ₹{RRG_MIN_MARKET_CAP_CR:g}cr, close > ₹{RRG_MIN_CLOSE:g}, 30d turnover > ₹{RRG_MIN_TURNOVER30_CR:g}cr)."
    )

    # 6. Group stocks by Block and by Niche
    source_p = frontend_dir / "theme_tracker_source.json"
    source_blocks_map: dict[str, str] = {}
    source_macros_map: dict[str, str] = {}
    if source_p.exists():
        with open(source_p, "r", encoding="utf-8") as f:
            src = json.load(f)
        source_blocks_map = {t["name"]: b["title"] for b in src.get("blocks", []) for t in b.get("themes", [])}
        source_macros_map = {b: m["title"] for m in src.get("macros", []) for b in m.get("blocks", [])}

    block_stocks: dict[str, set[str]] = {}
    block_macros: dict[str, str] = {}
    niche_stocks: dict[str, set[str]] = {}
    niche_blocks: dict[str, str] = {}
    niche_macros: dict[str, str] = {}

    for sym, rec in tax_records.items():
        sym_u = sym.upper()
        blk = rec.get("block")
        thm = rec.get("theme")
        mac = rec.get("macro")
        memberships = rec.get("memberships") or {}

        # Add to primary block and niche
        if blk:
            block_stocks.setdefault(blk, set()).add(sym_u)
            if mac and blk not in block_macros:
                block_macros[blk] = mac
        if thm:
            niche_stocks.setdefault(thm, set()).add(sym_u)
            if blk:
                niche_blocks[thm] = blk
            elif thm in source_blocks_map:
                niche_blocks[thm] = source_blocks_map[thm]
                block_stocks.setdefault(source_blocks_map[thm], set()).add(sym_u)

            if mac:
                niche_macros[thm] = mac
            elif thm in niche_blocks:
                niche_macros[thm] = source_macros_map.get(niche_blocks[thm], "EMERGING & CROSS-CUTTING")

        # Multi-membership themes (e.g. Precision Engineering, Pharma CDMO)
        for mem_name in memberships.keys():
            if mem_name and mem_name != thm:
                niche_stocks.setdefault(mem_name, set()).add(sym_u)
                if mem_name not in niche_blocks:
                    mem_blk = source_blocks_map.get(mem_name)
                    if mem_blk:
                        niche_blocks[mem_name] = mem_blk
                        block_stocks.setdefault(mem_blk, set()).add(sym_u)
                        if mem_blk not in block_macros:
                            block_macros[mem_blk] = source_macros_map.get(mem_blk, "EMERGING & CROSS-CUTTING")
                if mem_name not in niche_macros and mem_name in niche_blocks:
                    niche_macros[mem_name] = source_macros_map.get(niche_blocks[mem_name], "EMERGING & CROSS-CUTTING")

    # Dynamic themes with recentNseListingDays (e.g. IPO / Young Bases)
    as_of_date_obj = _parse_iso_or_nse_date(as_of_date)
    for b in src.get("blocks", []):
        for t in b.get("themes", []):
            max_days = t.get("recentNseListingDays")
            t_name = t.get("name")
            if max_days and t_name:
                p_blk = b.get("title")
                for sym_u, s_info in stock_map.items():
                    ld_str = s_info.get("listing_date") or s_info.get("listingDate")
                    ld = _parse_iso_or_nse_date(ld_str)
                    if ld and as_of_date_obj:
                        diff = (as_of_date_obj - ld).days
                        if 0 <= diff <= max_days:
                            niche_stocks.setdefault(t_name, set()).add(sym_u)
                            niche_blocks[t_name] = p_blk
                            block_stocks.setdefault(p_blk, set()).add(sym_u)
                            if p_blk not in block_macros:
                                block_macros[p_blk] = source_macros_map.get(p_blk, "EMERGING & CROSS-CUTTING")
                            niche_macros[t_name] = block_macros[p_blk]

    # Final pass to ensure all niches have parent block and macro
    for n_name in niche_stocks.keys():
        if n_name not in niche_blocks and n_name in source_blocks_map:
            niche_blocks[n_name] = source_blocks_map[n_name]
        p_blk = niche_blocks.get(n_name)
        if p_blk:
            block_stocks.setdefault(p_blk, set()).update(niche_stocks[n_name])
            if p_blk not in block_macros:
                block_macros[p_blk] = source_macros_map.get(p_blk, "EMERGING & CROSS-CUTTING")
            if n_name not in niche_macros:
                niche_macros[n_name] = block_macros[p_blk]

    # 7. Precompute weekly benchmark excess returns and cross-sectional RS
    # ratings. Include the 21-session predecessor for each trail anchor so a
    # point's y-value is always rating(t) - rating(t-21), including today.
    n_bench = len(bench_c)
    rating_offsets = {
        offset
        for week in range(trail_weeks + 1)
        for offset in (week * 5, week * 5 + 21)
    }
    rating_histories = {symbol: history for symbol, history in histories.items() if symbol in rrg_symbols}
    ratings_by_offset = rolling_rs_ratings(rating_histories, bench_c, rating_offsets)
    weekly_bench_excess: list[dict] = []
    for w in range(trail_weeks + 1):
        idx = -1 - w * 5
        date_w = bench_dates[idx] if abs(idx) <= n_bench else bench_dates[0]
        # Benchmark 63d return
        b_now = bench_c[idx]
        b_63 = bench_c[idx - 63] if (abs(idx - 63) <= n_bench and bench_c[idx - 63] > 0) else bench_c[0]
        b_ret63 = ((b_now - b_63) / b_63) * 100.0 if b_63 > 0 else 0.0

        # Benchmark 21d return
        b_21 = bench_c[idx - 21] if (abs(idx - 21) <= n_bench and bench_c[idx - 21] > 0) else b_now
        b_ret21 = ((b_now - b_21) / b_21) * 100.0 if b_21 > 0 else 0.0

        weekly_bench_excess.append({
            "week": w,
            "date": date_w,
            "bench_close": round(float(b_now), 2),
            "bench_return_63d": round(float(b_ret63), 2),
            "bench_return_21d": round(float(b_ret21), 2),
        })

    # Helper function to compute block/niche RRG metrics & rotation trail
    def compute_cluster_rrg(symbols: set[str], name: str, parent_block: str | None, macro: str | None) -> dict[str, Any] | None:
        valid_syms = [s for s in symbols if s in rrg_symbols]
        if len(valid_syms) < RRG_MIN_CONSTITUENTS:
            return None

        # Calculate historical 12-week trails
        trail = []
        for w in range(trail_weeks, -1, -1):
            idx = -1 - w * 5
            bench_info = weekly_bench_excess[w]
            b_ret63 = bench_info["bench_return_63d"]
            date_w = bench_info["date"]

            excess_63_list = []
            rs_chg_list = []

            for s in valid_syms:
                d_arr, c_arr = histories[s]
                n_c = len(c_arr)
                if abs(idx - 63) <= n_c:
                    cur_c = c_arr[idx]
                    p63_c = c_arr[idx - 63]
                    if p63_c > 0:
                        st_ret63 = ((cur_c - p63_c) / p63_c) * 100.0
                        excess_63_list.append(st_ret63 - b_ret63)

                rating_now = ratings_by_offset.get(w * 5, {}).get(s)
                rating_21d_ago = ratings_by_offset.get(w * 5 + 21, {}).get(s)
                if rating_now is not None and rating_21d_ago is not None:
                    rs_chg_list.append(float(rating_now - rating_21d_ago))

            med_excess_63 = float(np.median(excess_63_list)) if excess_63_list else 0.0
            med_rs_chg = float(np.median(rs_chg_list)) if rs_chg_list else 0.0
            pt_quadrant = determine_quadrant(med_excess_63, med_rs_chg)

            trail.append({
                "week": w,
                "date": date_w,
                "x": round(med_excess_63, 2),
                "y": round(med_rs_chg, 2),
                "quadrant": pt_quadrant,
            })

        latest_pt = trail[-1]
        cur_x = latest_pt["x"]
        cur_y = latest_pt["y"]
        cur_quadrant = latest_pt["quadrant"]

        # Current constituent-level analytics
        constituents_data = []
        ret_1m_list = []
        ret_3m_list = []
        ret_6m_list = []
        rs_ratings_list = []
        turnover_20_list = []
        beating_count = 0
        improving_rs_count = 0
        setup_count = 0

        for s in valid_syms:
            stock_meta = stock_map.get(s, {})
            d_arr, c_arr = histories[s]
            cur_price = float(c_arr[-1])
            chg_1d = float(stock_meta.get("changePct") or stock_meta.get("change_pct") or 0.0)
            mcap_cr = market_cap_crore(stock_meta) or 0.0

            # Returns
            r1m = round(((cur_price / c_arr[-22]) - 1.0) * 100.0, 2) if len(c_arr) >= 22 else None
            r3m = round(((cur_price / c_arr[-64]) - 1.0) * 100.0, 2) if len(c_arr) >= 64 else None
            r6m = round(((cur_price / c_arr[-127]) - 1.0) * 100.0, 2) if len(c_arr) >= 127 else None

            # Excess return 3M vs Nifty 500
            b_ret63_now = weekly_bench_excess[0]["bench_return_63d"]
            excess3m = round(r3m - b_ret63_now, 2) if r3m is not None else None

            if r1m is not None: ret_1m_list.append(r1m)
            if r3m is not None: ret_3m_list.append(r3m)
            if r6m is not None: ret_6m_list.append(r6m)

            if excess3m is not None and excess3m > 0:
                beating_count += 1

            # RS Rating
            rs_entry = rs_data.get(s, {})
            rs_val = ratings_by_offset.get(0, {}).get(s)
            rs_chg = None
            rs_21d_ago = ratings_by_offset.get(21, {}).get(s)
            if rs_val is not None and rs_21d_ago is not None:
                rs_chg = rs_val - rs_21d_ago
            if rs_val is None:
                rs_val = rs_entry.get("composite_rs") or rs_entry.get("front_weighted") or stock_meta.get("rsRating")
            if rs_chg is None:
                rs_chg = rs_entry.get("rs_change_21d")
            if rs_val is not None: rs_ratings_list.append(rs_val)
            if rs_chg is not None and rs_chg > 0:
                improving_rs_count += 1

            # Turnover
            t20 = turnover20_by_symbol[s]
            turnover_20_list.append(t20)

            # Setups
            geom = stock_meta.get("setupGeometry") or stock_meta.get("setup_geometry") or {}
            stage = stock_meta.get("stageStatus") or stock_meta.get("stage_status") or {}
            trend = stock_meta.get("trendTemplate") or stock_meta.get("trend_template") or {}

            has_vcp = bool(geom.get("vcp"))
            has_darvas = bool(geom.get("darvasBox") or geom.get("darvas_box"))
            has_flag = bool(geom.get("bullFlag") or geom.get("flag"))
            has_cup = bool(geom.get("cupWithHandle") or geom.get("cup_with_handle"))
            has_pocket = bool(geom.get("pocketPivot") or geom.get("pocket_pivot"))
            has_coiled = bool(geom.get("coiled"))
            has_tight = bool(geom.get("tightWeeks") or geom.get("tight_weeks"))
            is_stage2 = bool(stage.get("stage") == 2)
            has_any_setup = has_vcp or has_darvas or has_flag or has_cup or has_pocket or has_coiled or has_tight or is_stage2

            if has_any_setup:
                setup_count += 1

            status = "strengthening" if ((rs_chg or 0) >= 0 and (r3m or 0) >= 0) else "weakening"

            constituents_data.append({
                "symbol": s,
                "name": stock_meta.get("name") or s,
                "close": cur_price,
                "changePct": chg_1d,
                "marketCapCr": round(mcap_cr, 2),
                "rsRating": rs_val,
                "rsChange21d": rs_chg,
                "return1m": r1m,
                "return3m": r3m,
                "return6m": r6m,
                "excessReturn3m": excess3m,
                "turnover20Cr": round(t20, 2),
                "setups": {
                    "stage2": is_stage2,
                    "vcp": has_vcp,
                    "darvas": has_darvas,
                    "bullFlag": has_flag,
                    "cupHandle": has_cup,
                    "pocketPivot": has_pocket,
                    "coiled": has_coiled,
                    "tightWeeks": has_tight,
                },
                "trendScore": trend.get("score", 0),
                "status": status,
            })

        # Sort constituents by 3M excess return desc
        constituents_data.sort(key=lambda x: (x.get("excessReturn3m") if x.get("excessReturn3m") is not None else -999), reverse=True)

        n_const = len(valid_syms)
        total_t20 = float(sum(turnover_20_list))
        top_turnover_share = float(sum(sorted(turnover_20_list, reverse=True)[:3]) / total_t20 * 100.0) if total_t20 > 0 else 0.0

        return {
            "name": name,
            "parentBlock": parent_block,
            "macro": macro,
            "quadrant": cur_quadrant,
            "x": cur_x,
            "y": cur_y,
            "trail": trail,
            "metrics": {
                "excessReturn1m": round(float(np.median(ret_1m_list) - weekly_bench_excess[0]["bench_return_21d"]), 2) if ret_1m_list else 0.0,
                "excessReturn3m": cur_x,
                "excessReturn6m": round(float(np.median(ret_6m_list) - (weekly_bench_excess[0]["bench_return_63d"] * 1.5)), 2) if ret_6m_list else 0.0,
                "medianRs": int(round(float(np.median(rs_ratings_list)))) if rs_ratings_list else 50,
                "rsMomentum21d": cur_y,
                "beatingBenchmarkPct": round((beating_count / n_const) * 100.0, 1) if n_const else 0.0,
                "improvingRsPct": round((improving_rs_count / n_const) * 100.0, 1) if n_const else 0.0,
                "setupCoveragePct": round((setup_count / n_const) * 100.0, 1) if n_const else 0.0,
                "totalTurnover20Cr": round(total_t20, 2),
                "concentrationTop3Pct": round(top_turnover_share, 1),
                "constituentCount": n_const,
                "topContributors": [c["symbol"] for c in constituents_data[:3]],
            },
            "constituents": constituents_data,
        }

    print("Computing Thematic Block RRGs...")
    blocks_result = []
    for b_name in sorted(block_stocks.keys()):
        syms = block_stocks[b_name]
        mac = block_macros.get(b_name)
        c_res = compute_cluster_rrg(syms, b_name, parent_block=None, macro=mac)
        if c_res:
            # Add niche list
            b_niches = sorted(list({tax_records[s].get("theme") for s in syms if tax_records.get(s, {}).get("theme")}))
            c_res["niches"] = b_niches
            c_res["nicheCount"] = len(b_niches)
            blocks_result.append(c_res)

    print(f"Computed {len(blocks_result)} Thematic Blocks.")

    print("Computing Niche RRGs...")
    niches_result = []
    for n_name in sorted(niche_stocks.keys()):
        syms = niche_stocks[n_name]
        p_blk = niche_blocks.get(n_name)
        mac = niche_macros.get(n_name)
        c_res = compute_cluster_rrg(syms, n_name, parent_block=p_blk, macro=mac)
        if c_res:
            niches_result.append(c_res)

    print(f"Computed {len(niches_result)} Niches.")

    # Sort by 3M excess return descending
    blocks_result.sort(key=lambda b: b["x"], reverse=True)
    niches_result.sort(key=lambda n: n["x"], reverse=True)

    print("Computing NSE thematic-index RRGs...")
    index_histories = thematic_index_histories(root, bench_dates)
    index_offsets = {
        offset
        for week in range(trail_weeks + 1)
        for offset in (week * 5, week * 5 + 21)
    }
    index_ratings = index_rs_ratings(index_histories, bench_dates, bench_c, index_offsets)
    thematic_indices_result = []
    for history in index_histories:
        name, prices = history["name"], history["prices"]
        trail = []
        for week in range(trail_weeks, -1, -1):
            offset = week * 5
            end_idx, start_idx = -1 - offset, -1 - offset - 63
            index_return = (prices[bench_dates[end_idx]] / prices[bench_dates[start_idx]] - 1.0) * 100.0
            bench_return = (bench_c[end_idx] / bench_c[start_idx] - 1.0) * 100.0
            rating = index_ratings.get(offset, {}).get(name)
            prior_rating = index_ratings.get(offset + 21, {}).get(name)
            if rating is None or prior_rating is None:
                trail = []
                break
            x, y = round(float(index_return - bench_return), 2), round(float(rating - prior_rating), 1)
            trail.append({
                "week": week,
                "date": bench_dates[end_idx],
                "x": x,
                "y": y,
                "quadrant": determine_quadrant(x, y),
            })
        if not trail:
            continue
        cur = trail[-1]
        def excess_return(horizon: int) -> float:
            index_return = (prices[bench_dates[-1]] / prices[bench_dates[-1 - horizon]] - 1.0) * 100.0
            bench_return = (bench_c[-1] / bench_c[-1 - horizon] - 1.0) * 100.0
            return round(float(index_return - bench_return), 2)
        thematic_indices_result.append({
            "name": name,
            "indexSymbol": history["symbol"],
            "parentBlock": "NSE thematic index",
            "macro": "Official NSE index",
            "quadrant": cur["quadrant"],
            "x": cur["x"],
            "y": cur["y"],
            "trail": trail,
            "metrics": {
                "excessReturn1m": excess_return(21),
                "excessReturn3m": cur["x"],
                "excessReturn6m": excess_return(126),
                "medianRs": index_ratings[0][name],
                "rsMomentum21d": cur["y"],
                "beatingBenchmarkPct": 0.0,
                "improvingRsPct": 0.0,
                "setupCoveragePct": 0.0,
                "totalTurnover20Cr": 0.0,
                "concentrationTop3Pct": 0.0,
                "constituentCount": 0,
                "topContributors": [],
            },
            "constituents": [],
        })
    thematic_indices_result.sort(key=lambda item: item["x"], reverse=True)
    print(f"Computed {len(thematic_indices_result)} NSE thematic-index RRGs.")

    print("Computing Tactical IPO RRGs...")
    ipo_tactical_result = []
    as_of_date_obj = _parse_iso_or_nse_date(as_of_date)
    for sym_u, s_info in stock_map.items():
        ld_str = s_info.get("listing_date") or s_info.get("listingDate")
        ld = _parse_iso_or_nse_date(ld_str)
        if ld and as_of_date_obj:
            diff_days = (as_of_date_obj - ld).days
            if 0 <= diff_days <= 300 and sym_u in histories:
                d_arr, c_arr = histories[sym_u]
                n_bars = len(c_arr)
                # Pre-graduation debutants: only young IPOs that have not yet completed the 65 sessions for main RRG
                if 5 <= n_bars < 65:
                    lookback = min(10, n_bars - 1)
                    s_now = c_arr[-1]
                    s_past = c_arr[-1 - lookback]
                    s_ret = ((s_now - s_past) / s_past) * 100.0 if s_past > 0 else 0.0

                    b_now = bench_c[-1]
                    b_past = bench_c[-1 - lookback]
                    b_ret = ((b_now - b_past) / b_past) * 100.0 if b_past > 0 else 0.0
                    x_val = round(float(s_ret - b_ret), 2)

                    # Get volume history if csv exists
                    csv_p = ohlcv_dir / f"{sym_u}.csv"
                    rel_vol = 1.0
                    turnover_cr = 0.0
                    if csv_p.exists():
                        try:
                            df_v = pd.read_csv(csv_p, usecols=["Volume", "Close"])
                            v_arr = df_v["Volume"].values
                            c_arr_df = df_v["Close"].values
                            if len(v_arr) >= 5:
                                avg_5 = np.mean(v_arr[-5:])
                                avg_all = np.mean(v_arr)
                                rel_vol = (avg_5 / avg_all) if avg_all > 0 else 1.0
                                turnover_cr = (v_arr[-1] * c_arr_df[-1]) / 1e7
                        except Exception:
                            pass

                    y_val = round(float(min(300.0, max(-100.0, (rel_vol - 1.0) * 100.0))), 1)
                    quad = determine_quadrant(x_val, y_val)

                    ipo_trail = []
                    for step in range(5, -1, -1):
                        bar_idx = -1 - step
                        if abs(bar_idx) <= n_bars and abs(bar_idx) <= len(bench_c):
                            step_lb = min(10, n_bars - 1 - step)
                            if step_lb > 0 and (abs(bar_idx - step_lb) <= n_bars):
                                s_c_now = c_arr[bar_idx]
                                s_c_past = c_arr[bar_idx - step_lb]
                                s_st_ret = ((s_c_now - s_c_past) / s_c_past) * 100.0 if s_c_past > 0 else 0.0

                                b_c_now = bench_c[bar_idx]
                                b_c_past = bench_c[bar_idx - step_lb]
                                b_st_ret = ((b_c_now - b_c_past) / b_c_past) * 100.0 if b_c_past > 0 else 0.0
                                st_x = round(float(s_st_ret - b_st_ret), 2)
                                st_y = round(float(y_val * (1.0 - (step * 0.12))), 1)
                                ipo_trail.append({
                                    "week": step,
                                    "date": d_arr[bar_idx],
                                    "x": st_x,
                                    "y": st_y,
                                    "quadrant": determine_quadrant(st_x, st_y),
                                })

                    rec = tax_records.get(sym_u, {})
                    thm_name = rec.get("theme") or source_blocks_map.get(sym_u)
                    blk_name = rec.get("block") or (source_blocks_map.get(thm_name) if thm_name else None)

                    listing_close = c_arr[0]
                    gain_since_listing = round(float(((s_now - listing_close) / listing_close) * 100.0), 1) if listing_close > 0 else 0.0
                    c_prev = c_arr[-2] if n_bars >= 2 else s_now
                    chg_1d = round(float(((s_now - c_prev) / c_prev) * 100.0), 2) if c_prev > 0 else 0.0

                    ipo_tactical_result.append({
                        "symbol": sym_u,
                        "name": s_info.get("company_name") or sym_u,
                        "listingDate": str(ld),
                        "listingAgeDays": diff_days,
                        "sessions": n_bars,
                        "marketCapCr": round(float(s_info.get("market_cap_cr") or 0.0), 1),
                        "close": round(float(s_now), 2),
                        "changePct": chg_1d,
                        "excessReturn10d": x_val,
                        "turnoverIntensity": y_val,
                        "turnoverCr": round(float(turnover_cr), 1),
                        "deliveryPct": round(float(s_info.get("delivery_percent") or 0.0), 1) if s_info.get("delivery_percent") else None,
                        "gainSinceListingPct": gain_since_listing,
                        "quadrant": quad,
                        "x": x_val,
                        "y": y_val,
                        "trail": ipo_trail if len(ipo_trail) >= 2 else [{
                            "week": 0, "date": as_of_date, "x": x_val, "y": y_val, "quadrant": quad
                        }],
                        "theme": thm_name,
                        "block": blk_name,
                    })

    ipo_tactical_result.sort(key=lambda item: item["x"], reverse=True)
    print(f"Computed {len(ipo_tactical_result)} Tactical IPO RRGs.")

    # Build final payload
    payload = {
        "schemaVersion": 1,
        "asOfDate": as_of_date,
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "benchmark": "NIFTY 500",
        "benchmark3mReturn": weekly_bench_excess[0]["bench_return_63d"],
        "trailWeeks": trail_weeks,
        "totalBlocks": len(blocks_result),
        "totalNiches": len(niches_result),
        "totalThematicIndices": len(thematic_indices_result),
        "totalEquities": len(tax_records),
        "constituentEligibility": {
            "marketCapCrStrictlyGreaterThan": RRG_MIN_MARKET_CAP_CR,
            "closeStrictlyGreaterThan": RRG_MIN_CLOSE,
            "eligibleSymbols": len(rrg_symbols),
        },
        "blocks": blocks_result,
        "niches": niches_result,
        "thematicIndices": thematic_indices_result,
        "ipoTactical": ipo_tactical_result,
    }

    return payload


def main():
    parser = argparse.ArgumentParser(description="Build Thematic RRG artifacts.")
    parser.add_argument("--root", type=str, default=str(BASE_DIR), help="Pipeline root directory.")
    parser.add_argument("--frontend", type=str, default=str(Path(__file__).resolve().parent.parent / "frontend"), help="Frontend directory.")
    parser.add_argument("--trail-weeks", type=int, default=12, help="Number of weekly rotation trail steps.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    frontend = Path(args.frontend).resolve()

    payload = build_thematic_rrg_payload(root, frontend, trail_weeks=args.trail_weeks)

    # Publish a content-addressed RRG sidecar. Scanner revisions are immutable;
    # an RRG refresh advances only the current-manifest pointer.
    public_data = frontend / "public" / "data"
    public_data.mkdir(parents=True, exist_ok=True)
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_hash = hashlib.sha256(payload_bytes).hexdigest()
    sidecar_json = public_data / "thematic-rrg" / f"{payload_hash}.json"
    if not sidecar_json.exists():
        save_json(sidecar_json, payload, ensure_ascii=False)

    cur_p = public_data / "current.json"
    if cur_p.exists():
        with open(cur_p, "r", encoding="utf-8") as f:
            cur_meta = json.load(f)
        cur_meta["thematicRrgUrl"] = f"/data/thematic-rrg/{payload_hash}.json"
        cur_meta["thematicRrgVersion"] = payload_hash
        save_json(cur_p, cur_meta, ensure_ascii=False)

    # Retain the non-versioned file only as a compatibility fallback.
    out_json = public_data / "thematic_rrg.json"
    out_gz = public_data / "thematic_rrg.json.gz"

    save_json(out_json, payload, ensure_ascii=False)
    compress_file(out_json, out_gz)
    print(f"Successfully generated {out_json} and {out_gz} ({len(payload['blocks'])} blocks, {len(payload['niches'])} niches).")

    # Also save to frontend/dist/data if dist exists
    dist_data = frontend / "dist" / "data"
    if dist_data.exists():
        dist_json = dist_data / "thematic_rrg.json"
        dist_gz = dist_data / "thematic_rrg.json.gz"
        save_json(dist_json, payload, ensure_ascii=False)
        compress_file(dist_json, dist_gz)

    print(f"Published Thematic RRG sidecar {payload_hash[:12]} and updated current.json.")


if __name__ == "__main__":
    main()
