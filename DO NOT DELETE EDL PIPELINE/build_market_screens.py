"""Build MarketStrength Screens and Pattern Gallery datasets, enriching the canonical stock snapshot."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta
import gzip
import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from pipeline_utils import BASE_DIR, load_json, save_json, compress_file
from ohlcv_utils import read_ohlcv_csv, valid_ohlcv_values


def load_earnings_calendar(root: Path) -> dict[str, dict]:
    """Map forward-looking scheduled earnings from earnings_calendar.json.gz."""
    cal_path = root / "earnings_calendar.json.gz"
    if not cal_path.exists():
        cal_path = root / "earnings_calendar.json"
    if not cal_path.exists():
        return {}

    opener = gzip.open if cal_path.suffix == ".gz" else open
    try:
        with opener(cal_path, "rt", encoding="utf-8") as f:
            data = json.load(f)
        events = data.get("events", [])
        upcoming = {}
        for ev in events:
            sym = str(ev.get("symbol", "")).upper()
            dt_str = ev.get("result_date") or ev.get("meeting_date")
            if sym and dt_str:
                upcoming[sym] = {
                    "scheduled_date": dt_str,
                    "purpose": ev.get("purpose", "Financial Results"),
                }
        return upcoming
    except Exception:
        return {}


def detect_vcp(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, volumes: np.ndarray, dates: list[str]) -> dict | None:
    """Detect Volatility Contraction Pattern (VCP) with swing points."""
    if len(closes) < 60:
        return None

    w = 60
    sub_highs = highs[-w:]
    sub_lows = lows[-w:]
    sub_vols = volumes[-w:]
    sub_dates = dates[-w:]

    pivots = []
    for i in range(2, w - 2):
        if sub_highs[i] >= max(sub_highs[i-2:i]) and sub_highs[i] >= max(sub_highs[i+1:i+3]):
            pivots.append((i, "high", sub_highs[i], sub_dates[i]))
        elif sub_lows[i] <= min(sub_lows[i-2:i]) and sub_lows[i] <= min(sub_lows[i+1:i+3]):
            pivots.append((i, "low", sub_lows[i], sub_dates[i]))

    if len(pivots) < 4:
        return None

    contractions = []
    last_high = None
    for p in pivots:
        if p[1] == "high":
            last_high = p[2]
        elif p[1] == "low" and last_high is not None and last_high > 0:
            depth = ((p[2] - last_high) / last_high) * 100.0
            contractions.append(round(depth, 2))

    if len(contractions) < 2:
        return None

    last_2_or_3 = contractions[-3:] if len(contractions) >= 3 else contractions[-2:]
    # Must be successively shallower pullbacks (e.g. -15% -> -8% -> -4%)
    is_contracting = all(abs(last_2_or_3[i]) < abs(last_2_or_3[i-1]) for i in range(1, len(last_2_or_3)))
    latest_depth = abs(last_2_or_3[-1])

    if is_contracting and latest_depth <= 8.5:
        vol_dry = (float(np.mean(sub_vols[-10:])) / max(1e-9, float(np.mean(sub_vols[-50:])))) if len(sub_vols) >= 50 else 1.0
        return {
            "matched": True,
            "textbook": bool(latest_depth <= 6.5 and vol_dry < 0.75),
            "pullback_depths": last_2_or_3,
            "pivot_price": float(closes[-1]),
            "pivot_date": dates[-1],
            "volume_dry_ratio": round(vol_dry, 2),
            "swing_points": [
                {"date": p[3], "price": float(p[2]), "type": p[1]}
                for p in pivots[-6:]
            ],
        }
    return None


def detect_darvas(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray) -> dict | None:
    """Detect Darvas Box state and boundaries."""
    if len(closes) < 60:
        return None

    recent_h = highs[-30:]
    recent_l = lows[-30:]
    recent_c = closes[-30:]
    n = len(recent_c)

    box_top = None
    box_top_idx = None
    box_bot = None
    box_bot_idx = None

    for i in range(5, n - 3):
        h_candidate = recent_h[i]
        if all(recent_h[i - k] <= h_candidate for k in range(1, 4)) and all(recent_h[i + k] <= h_candidate for k in range(1, 4)):
            box_top = h_candidate
            box_top_idx = i
            break

    if box_top is None or box_top_idx is None:
        return None

    for j in range(box_top_idx + 1, n - 3):
        l_candidate = recent_l[j]
        if all(recent_l[j - k] >= l_candidate for k in range(1, 4)) and all(recent_l[j + k] >= l_candidate for k in range(1, 4)):
            box_bot = l_candidate
            box_bot_idx = j
            break

    if box_bot is None or box_top <= box_bot:
        return None

    height_pct = ((box_top - box_bot) / box_top) * 100.0
    if height_pct > 22.0:
        return None

    current_close = recent_c[-1]
    is_confirmed = (current_close <= box_top * 1.01) and (current_close >= box_bot * 0.99)
    is_breakout = (current_close > box_top) and (current_close <= box_top * 1.08)

    if is_confirmed or is_breakout:
        dist_top = ((box_top - current_close) / box_top) * 100.0
        return {
            "matched": True,
            "state": "confirmed" if is_confirmed else "breakout",
            "top_price": float(box_top),
            "bottom_price": float(box_bot),
            "height_pct": round(height_pct, 2),
            "dist_from_top_pct": round(dist_top, 2),
            "days_in_state": int(n - (box_bot_idx or box_top_idx)),
        }
    return None


def detect_flags(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, volumes: np.ndarray) -> dict | None:
    """Detect Bull Flag setup."""
    if len(closes) < 30:
        return None

    recent_highs = highs[-25:]
    high_idx_relative = int(np.argmax(recent_highs))
    sessions_since_high = len(recent_highs) - 1 - high_idx_relative

    if 3 <= sessions_since_high <= 20:
        pole_start_idx = max(0, len(closes) - 25 + high_idx_relative - 20)
        pole_low = float(np.min(lows[pole_start_idx : len(closes) - 25 + high_idx_relative]))
        peak_high = float(recent_highs[high_idx_relative])

        if pole_low > 0:
            pole_return = ((peak_high - pole_low) / pole_low) * 100.0
            if pole_return >= 22.0:
                flag_low = float(np.min(lows[-(sessions_since_high + 1):]))
                flag_depth = ((peak_high - flag_low) / peak_high) * 100.0

                if flag_depth <= 12.0 and closes[-1] >= flag_low:
                    vol_pause = (float(np.mean(volumes[-sessions_since_high:])) / max(1e-9, float(np.mean(volumes[-50:])))) if len(volumes) >= 50 else 1.0
                    return {
                        "matched": True,
                        "textbook": bool(pole_return >= 35.0 and flag_depth <= 8.0),
                        "pole_return_pct": round(pole_return, 2),
                        "pole_sessions": int(high_idx_relative),
                        "flag_depth_pct": round(flag_depth, 2),
                        "sessions_since_high": int(sessions_since_high),
                        "volume_pause_ratio": round(vol_pause, 2),
                    }
    return None


def detect_cup_with_handle(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray) -> dict | None:
    """Detect Cup with Handle setup."""
    if len(closes) < 50:
        return None

    w = min(120, len(closes))
    sub_h = highs[-w:]
    sub_l = lows[-w:]
    sub_c = closes[-w:]

    left_rim_idx = int(np.argmax(sub_h[:w//2]))
    left_rim = float(sub_h[left_rim_idx])
    bottom_idx = left_rim_idx + int(np.argmin(sub_l[left_rim_idx : w - 10]))
    bottom = float(sub_l[bottom_idx])

    if left_rim <= bottom or left_rim <= 0:
        return None

    cup_depth = ((left_rim - bottom) / left_rim) * 100.0
    if 12.0 <= cup_depth <= 40.0:
        right_rim_sub = sub_h[bottom_idx : w - 3]
        if len(right_rim_sub) > 0:
            right_rim = float(np.max(right_rim_sub))
            if abs(right_rim - left_rim) / left_rim <= 0.12:
                handle_low = float(np.min(sub_l[-10:]))
                handle_depth = ((right_rim - handle_low) / right_rim) * 100.0
                if handle_depth <= 12.0 and sub_c[-1] >= handle_low:
                    return {
                        "matched": True,
                        "textbook": bool(15.0 <= cup_depth <= 33.0 and handle_depth <= 8.0),
                        "cup_depth_pct": round(cup_depth, 2),
                        "handle_depth_pct": round(handle_depth, 2),
                        "duration_weeks": round(w / 5.0, 1),
                    }
    return None


def evaluate_minervini_trend(closes: np.ndarray, highs: np.ndarray, lows: np.ndarray, rs_val: float | None) -> dict:
    """Evaluate Minervini Trend Template 8-check checklist."""
    n = len(closes)
    c = closes[-1]
    s50 = float(np.mean(closes[-50:])) if n >= 50 else None
    s150 = float(np.mean(closes[-150:])) if n >= 150 else None
    s200 = float(np.mean(closes[-200:])) if n >= 200 else None

    lookback_52w = min(n, 252)
    h52 = float(np.max(highs[-lookback_52w:]))
    l52 = float(np.min(lows[-lookback_52w:]))

    checks: dict[str, bool] = {}
    fails: list[str] = []

    # 1. Price > SMA150 and SMA200
    if s150 and s200 and c > s150 and c > s200:
        checks["price_above_150_200"] = True
    else:
        checks["price_above_150_200"] = False
        fails.append("Price below SMA150 or SMA200")

    # 2. SMA150 > SMA200
    if s150 and s200 and s150 > s200:
        checks["sma150_above_200"] = True
    else:
        checks["sma150_above_200"] = False
        fails.append("SMA150 below SMA200")

    # 3. SMA200 rising over 20 sessions
    if n >= 220:
        s200_20d_ago = float(np.mean(closes[-220:-20]))
        if s200 and s200 > s200_20d_ago:
            checks["sma200_rising"] = True
        else:
            checks["sma200_rising"] = False
            fails.append("SMA200 not trending upwards")
    else:
        checks["sma200_rising"] = False
        fails.append("Insufficient history for SMA200 slope")

    # 4. SMA50 > SMA150 and SMA200
    if s50 and s150 and s200 and s50 > s150 and s50 > s200:
        checks["sma50_above_150_200"] = True
    else:
        checks["sma50_above_150_200"] = False
        fails.append("SMA50 below SMA150 or SMA200")

    # 5. Price > SMA50
    if s50 and c > s50:
        checks["price_above_sma50"] = True
    else:
        checks["price_above_sma50"] = False
        fails.append("Price below SMA50")

    # 6. Price at least +30% above 52W low
    if l52 > 0 and ((c - l52) / l52) >= 0.30:
        checks["plus_30pct_off_low"] = True
    else:
        checks["plus_30pct_off_low"] = False
        fails.append("Price less than 30% above 52W low")

    # 7. Price within 25% of 52W high
    if h52 > 0 and ((h52 - c) / h52) <= 0.25:
        checks["within_25pct_of_high"] = True
    else:
        checks["within_25pct_of_high"] = False
        fails.append("Price more than 25% below 52W high")

    # 8. RS >= 70
    if rs_val is not None and rs_val >= 70:
        checks["rs_ge_70"] = True
    else:
        checks["rs_ge_70"] = False
        fails.append("RS Rating below 70")

    score = sum(1 for v in checks.values() if v)
    return {
        "score": score,
        "is_leader": score == 8,
        "checks": checks,
        "fails": fails,
    }


def evaluate_weinstein_stage(closes: np.ndarray) -> dict:
    """Evaluate Weinstein Stage (Stage 2 Uptrend, Stage 4 Downtrend)."""
    n = len(closes)
    if n < 170:
        return {"stage": 1, "slope_20d": 0.0, "just_entered_stage_2": False}

    c = closes[-1]
    s150_now = float(np.mean(closes[-150:]))
    s150_20d = float(np.mean(closes[-170:-20]))
    slope_20d = ((s150_now - s150_20d) / s150_20d) * 100.0

    if slope_20d > 1.0 and c > s150_now:
        stage = 2
    elif slope_20d < -1.0 and c < s150_now:
        stage = 4
    else:
        # Flat slope checks 120 days ago
        if n >= 270:
            s150_120d = float(np.mean(closes[-270:-120]))
            stage = 3 if s150_now > s150_120d else 1
        else:
            stage = 1

    # Check if just entered Stage 2 (not stage 2 15 sessions ago)
    just_entered = False
    if stage == 2 and n >= 185:
        c_15d = closes[-16]
        s150_15d = float(np.mean(closes[-165:-15]))
        s150_35d = float(np.mean(closes[-185:-35]))
        slope_15d = ((s150_15d - s150_35d) / s150_35d) * 100.0
        was_stage_2 = bool(slope_15d > 1.0 and c_15d > s150_15d)
        just_entered = not was_stage_2

    return {
        "stage": stage,
        "slope_20d": round(slope_20d, 2),
        "just_entered_stage_2": just_entered,
    }


def main():
    root = Path(BASE_DIR)
    ohlcv_dir = root / "ohlcv_data"
    stocks_path = root / "all_stocks_fundamental_analysis.json"
    if not stocks_path.exists():
        print("Error: all_stocks_fundamental_analysis.json missing.")
        return False

    stocks = load_json(stocks_path)
    rs_data = load_json(root / "rs_rating_daily.json") or load_json(root / "rs_rating_daily.json.gz") or {}
    ratings = rs_data.get("ratings", {})
    calendar = load_earnings_calendar(root)

    screen_records = []
    gallery_items = []

    today_date = rs_data.get("as_of_date") or date.today().isoformat()
    today_dt = pd.to_datetime(today_date).date()

    print(f"Enriching stock snapshot & generating MarketStrength screens as of {today_date}...")

    for stock in stocks:
        sym = stock.get("symbol") or stock.get("Symbol")
        if not sym:
            continue

        sym_upper = sym.upper()
        csv_file = ohlcv_dir / f"{sym_upper}.csv"
        if not csv_file.exists():
            continue

        rows = read_ohlcv_csv(csv_file)
        if len(rows) < 30:
            continue

        # Extract dates and float series
        dates = []
        opens, highs, lows, closes, volumes = [], [], [], [], []
        for r in rows:
            v = valid_ohlcv_values(r)
            if v:
                d_str = str(r.get("Date", "")).split()[0]
                if d_str <= today_date:
                    dates.append(d_str)
                    opens.append(v[0])
                    highs.append(v[1])
                    lows.append(v[2])
                    closes.append(v[3])
                    volumes.append(v[4])

        if len(closes) < 30:
            continue

        h_arr = np.array(highs, dtype=float)
        l_arr = np.array(lows, dtype=float)
        c_arr = np.array(closes, dtype=float)
        v_arr = np.array(volumes, dtype=float)

        c = float(c_arr[-1])
        vol = float(v_arr[-1])
        rs_entry = ratings.get(sym_upper, {})
        comp_rs = rs_entry.get("composite_rs") or rs_entry.get("front_weighted")

        # 1. Evaluate Setups
        vcp = detect_vcp(h_arr, l_arr, c_arr, v_arr, dates)
        darvas = detect_darvas(h_arr, l_arr, c_arr)
        flag = detect_flags(h_arr, l_arr, c_arr, v_arr)
        cup = detect_cup_with_handle(h_arr, l_arr, c_arr)

        # Volume Breakout
        prior_50_high = float(np.max(h_arr[-51:-1])) if len(h_arr) >= 51 else float(np.max(h_arr[:-1]))
        rvol_50d = (vol / max(1.0, float(np.mean(v_arr[-50:])))) if len(v_arr) >= 50 else 1.0
        vol_breakout = bool(c > prior_50_high and rvol_50d >= 2.0)

        # Pocket Pivot
        pocket_pivot = False
        s50 = float(np.mean(c_arr[-50:])) if len(c_arr) >= 50 else None
        if len(c_arr) >= 11 and c > c_arr[-2] and s50 and c > s50:
            down_day_vols = [v_arr[-i] for i in range(2, 12) if c_arr[-i] < c_arr[-i-1]]
            max_down_vol = max(down_day_vols) if down_day_vols else 0.0
            pocket_pivot = bool(vol > max_down_vol)

        # Compression & Tight Weeks
        rng10 = ((float(np.max(h_arr[-10:])) - float(np.min(l_arr[-10:]))) / float(np.max(h_arr[-10:]))) * 100.0 if len(h_arr) >= 10 else 100.0
        tight_weeks = False
        if len(c_arr) >= 15:
            weekly_closes = c_arr[-15::5]
            if len(weekly_closes) >= 3:
                tight_weeks = bool(abs(weekly_closes[-1] - weekly_closes[-2]) / weekly_closes[-2] <= 0.015 and abs(weekly_closes[-2] - weekly_closes[-3]) / weekly_closes[-3] <= 0.015)

        # Multi-Year Breakout (~3 year ceiling)
        lookback_myb = min(len(c_arr), 750)
        myb = False
        if lookback_myb >= 250:
            hist_ceil = float(np.max(h_arr[-lookback_myb:-20]))
            myb = bool(c > hist_ceil and ((c - hist_ceil) / hist_ceil) <= 0.15)

        # Coiled
        coiled = bool(rng10 <= 10.0 and rvol_50d < 0.90 and s50 and c > s50 and (comp_rs or 0) >= 60)

        # 2. Evaluate Trend Template & Stage
        trend_res = evaluate_minervini_trend(c_arr, h_arr, l_arr, comp_rs)
        stage_res = evaluate_weinstein_stage(c_arr)

        # 3. Calendar
        cal_ev = calendar.get(sym_upper, {})
        days_until_results = None
        if cal_ev.get("scheduled_date"):
            try:
                res_d = pd.to_datetime(cal_ev["scheduled_date"]).date()
                days_until_results = (res_d - today_dt).days
            except Exception:
                pass

        # Enrich main stock record with explainable setup geometry & metrics
        setup_geometry = {
            "vcp": vcp,
            "darvas_box": darvas,
            "cup_with_handle": cup,
            "flag": flag,
            "pocket_pivot": pocket_pivot,
            "volume_breakout": vol_breakout,
            "multi_year_breakout": myb,
            "coiled": coiled,
            "tight_weeks": tight_weeks,
        }
        stock["setup_geometry"] = setup_geometry
        stock["trend_template"] = trend_res
        stock["stage_status"] = stage_res
        stock["upcoming_earnings"] = {
            "scheduled_date": cal_ev.get("scheduled_date"),
            "days_until_results": days_until_results,
            "purpose": cal_ev.get("purpose"),
        }

        # Liquidity metrics
        traded_val_20d = c_arr[-20:] * v_arr[-20:]
        mean_val_cr = float(np.mean(traded_val_20d)) / 1e7
        median_val_cr = float(np.median(traded_val_20d)) / 1e7
        stock["traded_value_mean_20d_cr"] = round(mean_val_cr, 2)
        stock["traded_value_median_20d_cr"] = round(median_val_cr, 2)
        stock["is_liquid_screen"] = bool(mean_val_cr >= 10.0)

        # Screen record
        screen_records.append({
            "symbol": sym_upper,
            "name": stock.get("name") or stock.get("Name"),
            "sector": stock.get("sector") or stock.get("Sector"),
            "industry": stock.get("industry") or stock.get("Basic Industry"),
            "close": c,
            "volume": vol,
            "composite_rs": comp_rs,
            "rs_change_21d": rs_entry.get("rs_change_21d"),
            "is_rs_line_52w_high": rs_entry.get("is_rs_line_52w_high", False),
            "is_liquid": bool(mean_val_cr >= 10.0),
            "traded_value_mean_20d_cr": round(mean_val_cr, 2),
            "traded_value_median_20d_cr": round(median_val_cr, 2),
            "trend_score": trend_res["score"],
            "stage": stage_res["stage"],
            "just_entered_stage_2": stage_res["just_entered_stage_2"],
            "setups": setup_geometry,
            "upcoming_earnings": stock["upcoming_earnings"],
        })

        # 4. Pattern Gallery occurrences (Rolling historical scan for VCP, Cup, Flag)
        # Scan last 126 sessions for first pattern appearances
        scan_len = min(len(c_arr), 126)
        if scan_len >= 40:
            for t_idx in range(len(c_arr) - scan_len, len(c_arr) - 5, 5):
                sig_date = dates[t_idx]
                sub_c_sig = c_arr[:t_idx + 1]
                sub_h_sig = h_arr[:t_idx + 1]
                sub_l_sig = l_arr[:t_idx + 1]
                sub_v_sig = v_arr[:t_idx + 1]

                pat_vcp = detect_vcp(sub_h_sig, sub_l_sig, sub_c_sig, sub_v_sig, dates[:t_idx + 1])
                pat_flag = detect_flags(sub_h_sig, sub_l_sig, sub_c_sig, sub_v_sig)
                pat_cup = detect_cup_with_handle(sub_h_sig, sub_l_sig, sub_c_sig)

                for p_type, p_match in (("VCP", pat_vcp), ("Bull Flag", pat_flag), ("Cup with Handle", pat_cup)):
                    if p_match and p_match.get("matched"):
                        # Forward outcomes (+5d, +20d, +60d)
                        fwd_closes = c_arr[t_idx + 1 :]
                        sig_close = float(sub_c_sig[-1])
                        ret5 = round(((fwd_closes[min(4, len(fwd_closes)-1)] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 1 else None
                        ret20 = round(((fwd_closes[min(19, len(fwd_closes)-1)] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 1 else None
                        ret60 = round(((fwd_closes[min(59, len(fwd_closes)-1)] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 1 else None

                        fwd_60 = fwd_closes[:60]
                        max_gain = round(((float(np.max(fwd_60)) - sig_close) / sig_close) * 100.0, 2) if len(fwd_60) > 0 else None
                        max_dd = round(((float(np.min(fwd_60)) - sig_close) / sig_close) * 100.0, 2) if len(fwd_60) > 0 else None

                        gallery_items.append({
                            "symbol": sym_upper,
                            "signal_date": sig_date,
                            "pattern": p_type,
                            "textbook": bool(p_match.get("textbook") and (comp_rs or 0) >= 80 and trend_res["score"] == 8),
                            "signal_close": sig_close,
                            "signal_rs": comp_rs,
                            "signal_trend_score": trend_res["score"],
                            "return_5d": ret5,
                            "return_20d": ret20,
                            "return_60d": ret60,
                            "max_gain_60d": max_gain,
                            "max_drawdown_60d": max_dd,
                            "measurements": p_match,
                        })
                        break  # capture one pattern per time index

    # Save enriched main stock snapshot
    save_json(stocks_path, stocks, ensure_ascii=False)
    compress_file(stocks_path, stocks_path.with_suffix(".json.gz"))
    print(f"Enriched {len(stocks)} stocks in all_stocks_fundamental_analysis.json(.gz)")

    # Save Market Screens Snapshot
    screens_output = root / "market_screens_snapshot.json"
    save_json(screens_output, {
        "as_of_date": today_date,
        "total_stocks": len(screen_records),
        "records": screen_records,
    }, ensure_ascii=False)
    compress_file(screens_output, screens_output.with_suffix(".json.gz"))
    print(f"Saved market_screens_snapshot.json(.gz) with {len(screen_records)} records.")

    # Save Pattern Gallery
    gallery_output = root / "pattern_gallery.json"
    save_json(gallery_output, {
        "as_of_date": today_date,
        "total_items": len(gallery_items),
        "items": gallery_items,
    }, ensure_ascii=False)
    compress_file(gallery_output, gallery_output.with_suffix(".json.gz"))
    print(f"Saved pattern_gallery.json(.gz) with {len(gallery_items)} historical outcomes.")

    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
