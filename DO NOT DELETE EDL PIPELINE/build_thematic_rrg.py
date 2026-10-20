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
from datetime import datetime
import gzip
import json
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

from pipeline_utils import BASE_DIR, save_json, compress_file
from ohlcv_utils import read_ohlcv_csv, valid_ohlcv_values


def determine_quadrant(x: float, y: float) -> str:
    if x >= 0.0:
        return "Leading" if y >= 0.0 else "Weakening"
    else:
        return "Improving" if y >= 0.0 else "Lagging"


def load_theme_classification(frontend_dir: Path) -> dict[str, dict]:
    """Load canonical Theme -> Block -> Macro mapping from theme-classification."""
    # Check revs or fallback
    tax_paths = [
        frontend_dir / "public/data/universe-classification.json",
        frontend_dir / "theme_tracker_source.json",
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

    # Fallback: construct from theme_tracker_source.json
    source_p = frontend_dir / "theme_tracker_source.json"
    if source_p.exists():
        with open(source_p, "r", encoding="utf-8") as f:
            src = json.load(f)
        blocks_map = {t["name"]: b["title"] for b in src["blocks"] for t in b["themes"]}
        macros_map = {b: m["title"] for m in src["macros"] for b in m["blocks"]}
        fields = src.get("fields", [])
        records = {}
        for row in src.get("rows", []):
            item = dict(zip(fields, row))
            sym = item.get("symbol")
            thm = item.get("theme")
            blk = blocks_map.get(thm) or item.get("sector")
            mac = macros_map.get(blk)
            if sym:
                records[sym] = {
                    "theme": thm,
                    "block": blk,
                    "macro": mac,
                    "memberships": {thm: item.get("provenance") or "source"} if thm else {},
                }
        return records

    return {}


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
    for sym in tax_records.keys():
        sym_u = sym.upper()
        p = ohlcv_dir / f"{sym_u}.csv"
        if p.exists():
            rows = read_ohlcv_csv(p)
            if len(rows) >= 65:
                d_list, c_list = [], []
                for r in rows:
                    v = valid_ohlcv_values(r)
                    if v:
                        d_str = str(r.get("Date", "")).split()[0]
                        if d_str <= as_of_date:
                            d_list.append(d_str)
                            c_list.append(v[3])
                if len(c_list) >= 65:
                    histories[sym_u] = (d_list, np.array(c_list, dtype=float))

    print(f"Loaded {len(histories)} stock histories for RRG calculation.")

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

    # 7. Precompute weekly benchmark excess returns & RS scores across the universe
    n_bench = len(bench_c)
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
        valid_syms = [s for s in symbols if s in histories]
        if not valid_syms:
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

                if w == 0:
                    # Current week: use published 21d RS change from rs_data
                    rs_entry = rs_data.get(s, {})
                    chg21 = rs_entry.get("rs_change_21d")
                    if chg21 is not None and math.isfinite(chg21):
                        rs_chg_list.append(float(chg21))
                else:
                    # Historical week: compute 21d momentum of multi-horizon composite
                    if abs(idx - 21 - 63) <= n_c:
                        c_t = c_arr[idx]
                        c_21 = c_arr[idx - 21]
                        c_63 = c_arr[idx - 63]
                        c_84 = c_arr[idx - 84] if abs(idx - 84) <= n_c else c_63
                        r_t = (c_t / c_63 - 1.0) if c_63 > 0 else 0.0
                        r_prev = (c_21 / c_84 - 1.0) if c_84 > 0 else 0.0
                        # Scaled to RS rating point change
                        rs_chg_list.append(float(np.clip((r_t - r_prev) * 50.0, -30.0, 30.0)))

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
            mcap_cr = float(stock_meta.get("marketCapCrore") or stock_meta.get("market_cap_crore") or 0.0)

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
            rs_val = rs_entry.get("composite_rs") or rs_entry.get("front_weighted") or stock_meta.get("rsRating")
            rs_chg = rs_entry.get("rs_change_21d")
            if rs_val is not None: rs_ratings_list.append(rs_val)
            if rs_chg is not None and rs_chg > 0:
                improving_rs_count += 1

            # Turnover
            t20 = float(stock_meta.get("tradedValueMean20dCr") or stock_meta.get("traded_value_mean_20d_cr") or 0.0)
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
        "totalEquities": len(tax_records),
        "blocks": blocks_result,
        "niches": niches_result,
    }

    return payload


def main():
    parser = argparse.ArgumentParser(description="Build Thematic RRG artifacts.")
    parser.add_argument("--root", type=str, default=str(BASE_DIR), help="Pipeline root directory.")
    parser.add_argument("--frontend", type=str, default=str(Path(__file__).resolve().parent.parent / "frontend"), help="Frontend directory.")
    parser.add_argument("--trail-weeks", type=int, default=12, help="Number of weekly rotation trail steps.")
    args = parser.parse_args()

    root = Path(args.root)
    frontend = Path(args.frontend)

    payload = build_thematic_rrg_payload(root, frontend, trail_weeks=args.trail_weeks)

    # Save to frontend public data directory
    public_data = frontend / "public" / "data"
    public_data.mkdir(parents=True, exist_ok=True)
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

    # Also save to current revision directory if it exists
    cur_p = public_data / "current.json"
    if cur_p.exists():
        with open(cur_p, "r", encoding="utf-8") as f:
            cur_meta = json.load(f)
        rev = cur_meta.get("revision")
        if rev:
            rev_dir = public_data / "revisions" / rev
            if rev_dir.exists():
                rev_json = rev_dir / "thematic_rrg.json"
                rev_gz = rev_dir / "thematic_rrg.json.gz"
                save_json(rev_json, payload, ensure_ascii=False)
                compress_file(rev_json, rev_gz)
                print(f"Also saved RRG to revision directory {rev_dir.name}.")


if __name__ == "__main__":
    main()
