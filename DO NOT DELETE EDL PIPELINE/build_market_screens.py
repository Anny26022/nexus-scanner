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
from build_rs_ratings import close_history, compute_stock_returns, calculate_composite_score, percentile_rank, liquid_universe


def load_json_or_gz(path: Path) -> Any:
    """Safely load JSON from either uncompressed or .gz file path, prioritizing newest file if both exist."""
    p = Path(path)
    gz_candidate = p if p.name.endswith(".gz") else p.with_name(p.name + ".gz")
    plain_candidate = p.with_name(p.name[:-3]) if p.name.endswith(".gz") else p

    # If both plain and .gz exist, choose the newer file based on modification time
    if gz_candidate.exists() and plain_candidate.exists():
        if plain_candidate.stat().st_mtime >= gz_candidate.stat().st_mtime:
            with open(plain_candidate, "r", encoding="utf-8") as f:
                return json.load(f)
        else:
            with gzip.open(gz_candidate, "rt", encoding="utf-8") as f:
                return json.load(f)

    if gz_candidate.exists():
        with gzip.open(gz_candidate, "rt", encoding="utf-8") as f:
            return json.load(f)

    if plain_candidate.exists():
        with open(plain_candidate, "r", encoding="utf-8") as f:
            return json.load(f)

    return None


def calculate_atr_series(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Calculate Average True Range (ATR) array."""
    n = len(closes)
    if n < 2:
        return np.zeros(n)
    tr = np.zeros(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        tr[i] = max(hl, hc, lc)

    atr = np.zeros(n)
    if n >= period:
        atr[period - 1] = np.mean(tr[:period])
        for i in range(period, n):
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
    return atr


def load_earnings_calendar(root: Path) -> dict[str, dict]:
    """Map forward-looking scheduled earnings from earnings_calendar.json.gz."""
    cal_data = load_json_or_gz(root / "earnings_calendar.json.gz") or {}
    events = cal_data.get("events", [])
    upcoming = {}
    for ev in events:
        sym = str(ev.get("symbol", "")).upper()
        # Support scheduled_date, result_date, and meeting_date
        dt_str = ev.get("scheduled_date") or ev.get("result_date") or ev.get("meeting_date")
        if sym and dt_str:
            upcoming[sym] = {
                "scheduled_date": dt_str,
                "scheduledDate": dt_str,
                "purpose": ev.get("purpose", "Financial Results"),
            }
    return upcoming


def detect_vcp(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, volumes: np.ndarray, dates: list[str]) -> dict | None:
    """Detect Volatility Contraction Pattern (VCP).

    Audited criteria:
    - 3 successively shallower pullbacks: abs(depth1) > abs(depth2) > abs(depth3)
    - Latest depth <= 8.0% (Textbook <= 6.5%)
    - Close > SMA50
    - Within 15% of 52W high
    - Volume dry ratio (10d vol / 50d avg vol) < 0.90
    """
    if len(closes) < 60:
        return None

    w = 60
    sub_highs = highs[-w:]
    sub_lows = lows[-w:]
    sub_vols = volumes[-w:]
    sub_dates = dates[-w:]

    pivots = []
    for i in range(2, w - 2):
        if sub_highs[i] == max(sub_highs[i - 2 : i + 3]):
            pivots.append((i, float(sub_highs[i]), "H", sub_dates[i]))
        elif sub_lows[i] == min(sub_lows[i - 2 : i + 3]):
            pivots.append((i, float(sub_lows[i]), "L", sub_dates[i]))

    if len(pivots) < 4:
        return None

    pullbacks = []
    swing_points = []
    last_h = None
    for p in pivots:
        swing_points.append({"date": p[3], "price": p[1], "type": "high" if p[2] == "H" else "low"})
        if p[2] == "H":
            last_h = p[1]
        elif p[2] == "L" and last_h is not None and last_h > 0:
            depth = ((last_h - p[1]) / last_h) * 100.0
            pullbacks.append(round(-depth, 2))
            last_h = None  # Ensure distinct H -> L contraction leg per cycle

    if len(pullbacks) < 3:
        return None

    # Three successively shallower pullbacks
    r1, r2, r3 = abs(pullbacks[-3]), abs(pullbacks[-2]), abs(pullbacks[-1])
    if not (r1 > r2 and r2 > r3):
        return None

    latest_depth = r3
    if latest_depth > 8.0:
        return None

    cur_c = float(closes[-1])
    s50 = float(np.mean(closes[-50:])) if len(closes) >= 50 else None
    if s50 is None or cur_c <= s50:
        return None

    h52 = float(np.max(highs[-min(len(highs), 252):]))
    if h52 <= 0 or ((h52 - cur_c) / h52) * 100.0 > 15.0:
        return None

    v10 = float(np.mean(volumes[-10:])) if len(volumes) >= 10 else float(volumes[-1])
    v50 = float(np.mean(volumes[-50:])) if len(volumes) >= 50 else v10
    vol_dry = round(v10 / max(1.0, v50), 2)
    if vol_dry >= 0.90:
        return None

    h_pivots = [p[1] for p in pivots if p[2] == "H"]
    pivot_h = max(h_pivots[-3:]) if h_pivots else float(highs[-1])
    recent_pullbacks = pullbacks[-3:]
    return {
        "matched": True,
        "textbook": bool(latest_depth <= 6.5),
        "pullbackDepths": recent_pullbacks,
        "pullback_depths": recent_pullbacks,
        "pivotPrice": round(pivot_h, 2),
        "pivot_price": round(pivot_h, 2),
        "pivotDate": dates[-1],
        "pivot_date": dates[-1],
        "volumeDryRatio": vol_dry,
        "volume_dry_ratio": vol_dry,
        "swingPoints": swing_points[-6:],
        "swing_points": swing_points[-6:],
    }


def detect_darvas(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray) -> dict | None:
    """Return a confirmed box or its breakout in the latest five sessions.

    Confirm top and floor with three following sessions. A completed box ends
    permanently on its first closing breakout or floor breach. Continue looking
    for subsequent boxes after that event rather than resurrecting the old one.
    """
    if len(closes) < 60:
        return None

    recent_h, recent_l, recent_c = highs[-30:], lows[-30:], closes[-30:]
    n = len(recent_c)
    h52 = float(np.max(highs[-min(len(highs), 252):]))
    current_close = float(recent_c[-1])
    next_candidate = 5

    for top_idx in range(5, n - 3):
        if top_idx < next_candidate:
            continue
        top = float(recent_h[top_idx])
        if not (all(recent_h[top_idx - k] <= top for k in range(1, 4))
                and all(recent_h[top_idx + k] <= top for k in range(1, 4))):
            continue
        if top <= 0 or (h52 > 0 and (h52 - top) / h52 > 0.05):
            continue

        bottom_idx = next((j for j in range(top_idx + 1, n - 3)
                           if all(recent_l[j - k] >= recent_l[j] for k in range(1, 4))
                           and all(recent_l[j + k] >= recent_l[j] for k in range(1, 4))), None)
        if bottom_idx is None:
            continue
        bottom = float(recent_l[bottom_idx])
        confirmed_idx = max(top_idx + 3, bottom_idx + 3)
        # A higher high before floor confirmation supersedes this forming top.
        if any(recent_h[k] > top for k in range(top_idx + 1, confirmed_idx + 1)):
            continue
        height_pct = (top - bottom) / top * 100.0
        if bottom >= top or height_pct > 20.0:
            continue

        event_idx = next((k for k in range(confirmed_idx, n)
                          if recent_c[k] < bottom or recent_c[k] > top), None)
        state = "confirmed"
        days_in_state = n - 1 - confirmed_idx
        if event_idx is not None:
            next_candidate = event_idx
            if recent_c[event_idx] < bottom:
                continue
            # A breakout ends the box even when price subsequently re-enters it.
            days_in_state = n - 1 - event_idx
            if (days_in_state >= 5 or current_close > top * 1.08
                    or any(recent_c[k] < bottom for k in range(event_idx, n))):
                continue
            state = "breakout"

        distance = (top - current_close) / top * 100.0
        return {
            "matched": True, "state": state,
            "topPrice": top, "top_price": top,
            "bottomPrice": bottom, "bottom_price": bottom,
            "heightPct": round(height_pct, 2), "height_pct": round(height_pct, 2),
            "distFromTopPct": round(distance, 2), "dist_from_top_pct": round(distance, 2),
            "daysInState": days_in_state, "days_in_state": days_in_state,
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
            if pole_return >= 25.0:
                flag_low = float(np.min(lows[-(sessions_since_high + 1):]))
                flag_depth = ((peak_high - flag_low) / peak_high) * 100.0

                if flag_depth <= 12.0 and closes[-1] >= flag_low:
                    vol_pause = (float(np.mean(volumes[-sessions_since_high:])) / max(1e-9, float(np.mean(volumes[-50:])))) if len(volumes) >= 50 else 1.0
                    return {
                        "matched": True,
                        "textbook": bool(pole_return >= 35.0 and flag_depth <= 8.0),
                        "poleReturnPct": round(pole_return, 2),
                        "pole_return_pct": round(pole_return, 2),
                        "poleSessions": int(high_idx_relative),
                        "pole_sessions": int(high_idx_relative),
                        "flagDepthPct": round(flag_depth, 2),
                        "flag_depth_pct": round(flag_depth, 2),
                        "sessionsSinceHigh": int(sessions_since_high),
                        "sessions_since_high": int(sessions_since_high),
                        "volumePauseRatio": round(vol_pause, 2),
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
                        "cupDepthPct": round(cup_depth, 2),
                        "cup_depth_pct": round(cup_depth, 2),
                        "handleDepthPct": round(handle_depth, 2),
                        "handle_depth_pct": round(handle_depth, 2),
                        "durationWeeks": round(w / 5.0, 1),
                        "duration_weeks": round(w / 5.0, 1),
                    }
    return None


def detect_tight_weeks(closes: np.ndarray, dates: list[str], s50: float | None, rs_val: float | None) -> dict | None:
    """Detect Tight Weeks setup.

    Audited criteria:
    - >= 3 consecutive weekly closes within 1.5% of one another
    - Weekly closes aggregated by exchange week (resample W-FRI)
    - Close > SMA50
    - RS >= 60
    """
    if len(closes) < 30 or len(dates) < 30:
        return None

    cur_c = float(closes[-1])
    if s50 is None or cur_c <= s50 or (rs_val is None or rs_val < 60):
        return None

    try:
        ts_dates = pd.to_datetime(dates)
        s = pd.Series(closes, index=ts_dates)
        weekly = s.resample("W-FRI").last().dropna()

        # Exclude unfinished current exchange week if last date is mid-week (Monday-Thursday)
        if len(dates) > 0:
            last_dt = pd.to_datetime(dates[-1])
            if last_dt.weekday() < 4 and len(weekly) >= 4:
                weekly = weekly.iloc[:-1]

        if len(weekly) < 3:
            return None

        # Check last 3 consecutive completed weeks for strict <= 1.5% total range
        recent_3 = [float(weekly.iloc[-i]) for i in (1, 2, 3)]
        min_c, max_c = min(recent_3), max(recent_3)
        if min_c > 0 and ((max_c - min_c) / min_c) <= 0.015:
            spread = round(((max_c - min_c) / min_c) * 100.0, 2)
            return {
                "matched": True,
                "tightWeeksCount": 3,
                "tight_weeks_count": 3,
                "spreadPct": spread,
                "spread_pct": spread,
                "weeklyCloses": [round(c, 2) for c in recent_3],
                "weekly_closes": [round(c, 2) for c in recent_3],
            }
    except Exception:
        pass
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
    is_leader = (score == 8)
    return {
        "score": score,
        "isLeader": is_leader,
        "is_leader": is_leader,
        "checks": checks,
        "fails": fails,
    }


def evaluate_weinstein_stage(closes: np.ndarray) -> dict:
    """Evaluate Weinstein Stage (1 Basing, 2 Advancing, 3 Topping, 4 Declining).

    Rigorous methodology:
    - Stage 2: SMA150 rose > 1.0% over 20 sessions and Price > SMA150
    - Stage 4: SMA150 fell > 1.0% over 20 sessions and Price < SMA150
    - Stage 3: SMA150 rising but Price < SMA150, OR flat slope and SMA150 > SMA150 120d ago
    - Stage 1: SMA150 falling but Price > SMA150, OR flat slope and SMA150 <= SMA150 120d ago
    """
    n = len(closes)
    if n < 170:
        return {"stage": 1, "slope_20d": 0.0, "slope20d": 0.0, "justEnteredStage2": False, "just_entered_stage_2": False}

    c = float(closes[-1])
    s150_now = float(np.mean(closes[-150:]))
    s150_20d = float(np.mean(closes[-170:-20]))
    slope_20d = ((s150_now - s150_20d) / s150_20d) * 100.0

    if slope_20d > 1.0:
        stage = 2 if c > s150_now else 3
    elif slope_20d < -1.0:
        stage = 4 if c < s150_now else 1
    else:
        # Flat slope checks 120 sessions ago
        if n >= 270:
            s150_120d = float(np.mean(closes[-270:-120]))
            stage = 3 if s150_now > s150_120d else 1
        else:
            stage = 1

    # Check if just entered Stage 2 (was not stage 2 15 sessions ago)
    just_entered = False
    if stage == 2 and n >= 185:
        c_15d = float(closes[-16])
        s150_15d = float(np.mean(closes[-165:-15]))
        s150_35d = float(np.mean(closes[-185:-35]))
        slope_15d = ((s150_15d - s150_35d) / s150_35d) * 100.0
        was_stage_2 = bool(slope_15d > 1.0 and c_15d > s150_15d)
        just_entered = not was_stage_2

    return {
        "stage": stage,
        "slope_20d": round(slope_20d, 2),
        "slope20d": round(slope_20d, 2),
        "justEnteredStage2": just_entered,
        "just_entered_stage_2": just_entered,
    }


def precompute_gallery_rs(
    stocks: list[dict],
    ohlcv_dir: Path,
    today_date: str,
    scan_len: int = 126,
    eligible_by_date: dict[str, set[str]] | None = None,
) -> dict[str, dict[str, int]]:
    """Rank historical returns only when the eligible universe is known for that session.

    Current membership cannot establish historical percentiles. Missing dated
    membership therefore leaves the rating unavailable rather than estimating it.
    """
    eligible_by_date = eligible_by_date or {}
    target_dates = sorted(d for d in eligible_by_date if d <= today_date)[-scan_len:]
    if not ohlcv_dir.exists() or not target_dates:
        return {}

    scores_by_date: dict[str, dict[str, float]] = {d: {} for d in target_dates}
    eligible_symbols = set().union(*(eligible_by_date[d] for d in target_dates))
    for sym in sorted(eligible_symbols):
        csv_file = ohlcv_dir / f"{sym}.csv"
        if not csv_file.exists():
            continue
        # Use the same dated-close validation as the canonical RS builder.
        history = close_history(csv_file)
        closes = history["Close"].tolist()
        indices = {d.strftime("%Y-%m-%d"): i for i, d in enumerate(history["Date"])}
        for d in target_dates:
            if sym not in eligible_by_date[d]:
                continue
            idx = indices.get(d)
            if idx is None:
                continue
            returns = compute_stock_returns(closes, offset=len(closes) - idx - 1)
            score = calculate_composite_score(returns) if returns is not None else None
            if score is not None:
                scores_by_date[d][sym] = score

    return {d: percentile_rank(scores) for d, scores in scores_by_date.items() if scores}


def enrich_snapshot_directory(
    root: Path,
    ohlcv_dir: Path | None = None,
    earnings_root: Path | None = None,
    generate_gallery: bool = True,
    gallery_eligible_by_date: dict[str, set[str]] | None = None,
) -> bool:
    """Enrich a snapshot directory with explainable setups, trend template, and pattern gallery."""
    root = Path(root)
    ohlcv_dir = Path(ohlcv_dir) if ohlcv_dir else (root / "ohlcv_data")
    earnings_root = Path(earnings_root) if earnings_root else root

    stocks_gz = root / "all_stocks_fundamental_analysis.json.gz"
    stocks_json = root / "all_stocks_fundamental_analysis.json"

    stocks = load_json_or_gz(stocks_gz if stocks_gz.exists() else stocks_json)
    if not stocks:
        print(f"Error: all_stocks_fundamental_analysis missing in {root}")
        return False

    rs_data = load_json_or_gz(root / "rs_rating_daily.json") or {}
    ratings = rs_data.get("ratings", {})
    calendar = load_earnings_calendar(earnings_root)

    screen_records = []
    gallery_items = []

    # Prioritize stock snapshot date for canonical date alignment
    today_date = None
    if stocks and isinstance(stocks, list) and len(stocks) > 0:
        today_date = stocks[0].get("as_of_date") or stocks[0].get("date") or stocks[0].get("session_date")
    if not today_date:
        today_date = rs_data.get("as_of_date")
    if not today_date:
        today_date = date.today().isoformat()

    rs_as_of = rs_data.get("as_of_date")
    if rs_as_of and today_date and rs_as_of != today_date:
        raise ValueError(
            f"Stale inputs rejected: RS artifact date ({rs_as_of}) does not match stock snapshot date ({today_date}). "
            "Pipeline inputs must be date-aligned before generating market screens."
        )

    today_dt = pd.to_datetime(today_date).date()
    print(f"Enriching snapshot directory {root.name} as of {today_date} across {len(stocks)} stocks...")

    gallery_rs_map = {}
    if generate_gallery:
        dated_eligibility = dict(gallery_eligible_by_date or {})
        if today_date not in dated_eligibility:
            try:
                eligible, _ = liquid_universe(root)
            except (FileNotFoundError, ValueError):
                pass  # No dated universe: historical RS stays unavailable.
            else:
                dated_eligibility[today_date] = eligible
        gallery_rs_map = precompute_gallery_rs(
            stocks, ohlcv_dir, today_date, eligible_by_date=dated_eligibility,
        )

    for stock in stocks:
        # Clear prior enrichment even when this run has missing/short/stale history.
        for field in (
            "setup_geometry", "setupGeometry", "trend_template", "trendTemplate",
            "stage_status", "stageStatus", "upcoming_earnings", "upcomingEarnings",
            "isRsLine52wHigh", "is_rs_line_52w_high", "traded_value_mean_20d_cr",
            "tradedValueMean20dCr", "traded_value_median_20d_cr",
            "tradedValueMedian20dCr", "is_liquid_screen", "isLiquidScreen",
        ):
            stock[field] = None
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

        if dates[-1] != today_date:
            continue

        h_arr = np.array(highs, dtype=float)
        l_arr = np.array(lows, dtype=float)
        c_arr = np.array(closes, dtype=float)
        v_arr = np.array(volumes, dtype=float)

        c = float(c_arr[-1])
        vol = float(v_arr[-1])
        rs_entry = ratings.get(sym_upper, {})
        comp_rs = rs_entry.get("composite_rs") or rs_entry.get("front_weighted")

        s50 = float(np.mean(c_arr[-50:])) if len(c_arr) >= 50 else None
        h52 = float(np.max(h_arr[-min(len(h_arr), 252):]))

        # 1. Evaluate Setups
        vcp = detect_vcp(h_arr, l_arr, c_arr, v_arr, dates)
        darvas = detect_darvas(h_arr, l_arr, c_arr)
        flag = detect_flags(h_arr, l_arr, c_arr, v_arr)
        cup = detect_cup_with_handle(h_arr, l_arr, c_arr)
        tight_wks = detect_tight_weeks(c_arr, dates, s50, comp_rs)

        # Volume Breakout: Close > 50d high (excluding today) + 50d RVOL >= 2.0x
        prior_50_high = float(np.max(h_arr[-51:-1])) if len(h_arr) >= 51 else float(np.max(h_arr[:-1]))
        rvol_50d = (vol / max(1.0, float(np.mean(v_arr[-50:])))) if len(v_arr) >= 50 else 1.0
        vol_breakout = bool(c > prior_50_high and rvol_50d >= 2.0)

        # Pocket Pivot: up day, close > 50 DMA, volume > max down-day volume of prior 10 sessions, RS >= 60
        pocket_pivot = False
        if len(c_arr) >= 11 and c > c_arr[-2] and s50 and c > s50 and (comp_rs or 0) >= 60:
            down_day_vols = [v_arr[-i] for i in range(2, 12) if c_arr[-i] < c_arr[-i-1]]
            max_down_vol = max(down_day_vols) if down_day_vols else 0.0
            pocket_pivot = bool(vol > max_down_vol)

        # Multi-Year Breakout: ceiling established >= 250 sessions ago, current close clears ceiling within 15%
        myb = False
        myb_details = None
        lookback_myb = min(len(c_arr), 750)
        if lookback_myb >= 300:
            prior_win = h_arr[-lookback_myb:-1]
            ceil_val = float(np.max(prior_win))
            ceil_idx = int(np.argmax(prior_win))
            ceil_age = len(prior_win) - ceil_idx
            if ceil_age >= 250 and c > ceil_val:
                above_pct = ((c - ceil_val) / ceil_val) * 100.0
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

        # Coiled: 10d range <= 10%, ATR(10)/ATR(50) <= 0.85, volumeDryRatio < 0.90, close > 50 DMA, within 15% of 52W high, RS >= 60
        rng10 = ((float(np.max(h_arr[-10:])) - float(np.min(l_arr[-10:]))) / float(np.max(h_arr[-10:]))) * 100.0 if len(h_arr) >= 10 else 100.0
        atr10_series = calculate_atr_series(h_arr, l_arr, c_arr, 10)
        atr50_series = calculate_atr_series(h_arr, l_arr, c_arr, 50)
        atr_ratio = (atr10_series[-1] / atr50_series[-1]) if (len(c_arr) >= 50 and atr50_series[-1] > 0) else 1.0
        v10 = float(np.mean(v_arr[-10:])) if len(v_arr) >= 10 else float(v_arr[-1])
        v50 = float(np.mean(v_arr[-50:])) if len(v_arr) >= 50 else v10
        vol_dry_10 = (v10 / max(1.0, v50)) if v50 > 0 else 1.0
        from_52h = ((h52 - c) / h52 * 100.0) if h52 > 0 else 100.0

        coiled = bool(rng10 <= 10.0 and atr_ratio <= 0.85 and vol_dry_10 < 0.90 and s50 and c > s50 and from_52h <= 15.0 and (comp_rs or 0) >= 60)

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

        # Setup Geometry dictionary supporting BOTH camelCase and snake_case for full UI/backend parity
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

        # Enrich stock record in-place preserving every existing column
        stock["setup_geometry"] = setup_geometry
        stock["setupGeometry"] = setup_geometry
        stock["trend_template"] = trend_res
        stock["trendTemplate"] = trend_res
        stock["stage_status"] = stage_res
        stock["stageStatus"] = stage_res
        stock["upcoming_earnings"] = {
            "scheduledDate": cal_ev.get("scheduled_date"),
            "scheduled_date": cal_ev.get("scheduled_date"),
            "daysUntilResults": days_until_results,
            "days_until_results": days_until_results,
            "purpose": cal_ev.get("purpose"),
        }
        stock["upcomingEarnings"] = stock["upcoming_earnings"]
        stock["isRsLine52wHigh"] = rs_entry.get("is_rs_line_52w_high", False)
        stock["is_rs_line_52w_high"] = stock["isRsLine52wHigh"]

        # Liquidity metrics
        traded_val_20d = c_arr[-20:] * v_arr[-20:]
        mean_val_cr = float(np.mean(traded_val_20d)) / 1e7
        median_val_cr = float(np.median(traded_val_20d)) / 1e7
        stock["traded_value_mean_20d_cr"] = round(mean_val_cr, 2)
        stock["tradedValueMean20dCr"] = round(mean_val_cr, 2)
        stock["traded_value_median_20d_cr"] = round(median_val_cr, 2)
        stock["tradedValueMedian20dCr"] = round(median_val_cr, 2)
        stock["is_liquid_screen"] = bool(mean_val_cr >= 10.0)
        stock["isLiquidScreen"] = stock["is_liquid_screen"]

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
            "is_rs_line_52w_high": stock["isRsLine52wHigh"],
            "is_liquid": stock["is_liquid_screen"],
            "traded_value_mean_20d_cr": round(mean_val_cr, 2),
            "traded_value_median_20d_cr": round(median_val_cr, 2),
            "trend_score": trend_res["score"],
            "stage": stage_res["stage"],
            "just_entered_stage_2": stage_res["just_entered_stage_2"],
            "setups": setup_geometry,
            "upcoming_earnings": stock["upcoming_earnings"],
        })

        # 4. Pattern Gallery occurrences (Strict Anti-Lookahead & Stateful Episode Tracking)
        if generate_gallery:
            scan_len = min(len(c_arr), 126)
            if scan_len >= 40:
                t_start = len(c_arr) - scan_len
                active_episodes: dict[str, bool] = {"VCP": False, "Bull Flag": False, "Cup with Handle": False}
                if t_start > 0:
                    pre_c = c_arr[:t_start]
                    pre_h = h_arr[:t_start]
                    pre_l = l_arr[:t_start]
                    pre_v = v_arr[:t_start]
                    pre_dates = dates[:t_start]
                    vcp_pre = detect_vcp(pre_h, pre_l, pre_c, pre_v, pre_dates)
                    flag_pre = detect_flags(pre_h, pre_l, pre_c, pre_v)
                    cup_pre = detect_cup_with_handle(pre_h, pre_l, pre_c)
                    active_episodes["VCP"] = bool(vcp_pre and vcp_pre.get("matched"))
                    active_episodes["Bull Flag"] = bool(flag_pre and flag_pre.get("matched"))
                    active_episodes["Cup with Handle"] = bool(cup_pre and cup_pre.get("matched"))

                for t_idx in range(t_start, len(c_arr)):
                    sig_date = dates[t_idx]
                    sub_c = c_arr[:t_idx + 1]
                    sub_h = h_arr[:t_idx + 1]
                    sub_l = l_arr[:t_idx + 1]
                    sub_v = v_arr[:t_idx + 1]

                    # Point-in-time setup detection
                    pat_vcp = detect_vcp(sub_h, sub_l, sub_c, sub_v, dates[:t_idx + 1])
                    pat_flag = detect_flags(sub_h, sub_l, sub_c, sub_v)
                    pat_cup = detect_cup_with_handle(sub_h, sub_l, sub_c)

                    # Point-in-time composite RS at t_idx: cross-sectional percentile rank (1-99)
                    pit_rs = gallery_rs_map.get(sig_date, {}).get(sym_upper)
                    # Point-in-time trend score evaluated strictly at sig_date with point-in-time strength
                    sig_trend = evaluate_minervini_trend(sub_c, sub_h, sub_l, pit_rs)

                    for p_type, p_match in (("VCP", pat_vcp), ("Bull Flag", pat_flag), ("Cup with Handle", pat_cup)):
                        is_match = bool(p_match and p_match.get("matched"))
                        if is_match:
                            if active_episodes.get(p_type, False):
                                # Ongoing setup within same active episode: do not emit duplicate occurrences
                                continue
                            active_episodes[p_type] = True
                        else:
                            # Setup episode ended
                            active_episodes[p_type] = False
                            continue

                        fwd_closes = c_arr[t_idx + 1 :]
                        sig_close = float(sub_c[-1])

                        # Matured horizon return gates: None if horizon has not elapsed!
                        ret5 = round(((fwd_closes[4] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 5 else None
                        ret20 = round(((fwd_closes[19] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 20 else None
                        ret60 = round(((fwd_closes[59] - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 60 else None

                        fwd_60 = fwd_closes[:60]
                        max_gain = round(((float(np.max(fwd_60)) - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 60 else None
                        max_dd = round(((float(np.min(fwd_60)) - sig_close) / sig_close) * 100.0, 2) if len(fwd_closes) >= 60 else None

                        gallery_items.append({
                            "symbol": sym_upper,
                            "signal_date": sig_date,
                            "pattern": p_type,
                            "textbook": bool(p_match.get("textbook") and pit_rs is not None and pit_rs >= 80 and sig_trend["score"] == 8),
                            "signal_close": sig_close,
                            "signal_rs": pit_rs,
                            "signal_trend_score": sig_trend["score"],
                                "return_5d": ret5,
                                "return_20d": ret20,
                                "return_60d": ret60,
                                "max_gain_60d": max_gain,
                                "max_drawdown_60d": max_dd,
                                "measurements": p_match,
                            })

    # Save enriched canonical stock snapshot
    save_json(stocks_json, stocks, ensure_ascii=False)
    compress_file(stocks_json, stocks_gz)
    print(f"Enriched {len(stocks)} stocks in {stocks_gz.name} and {stocks_json.name} (preserved all fields)")

    # Save Market Screens Snapshot
    screens_output = root / "market_screens_snapshot.json"
    screens_gz = screens_output.with_suffix(".json.gz")
    save_json(screens_output, {
        "as_of_date": today_date,
        "total_stocks": len(screen_records),
        "records": screen_records,
    }, ensure_ascii=False)
    compress_file(screens_output, screens_gz)
    print(f"Saved market_screens_snapshot.json and .gz with {len(screen_records)} records.")

    # Save Pattern Gallery if requested
    if generate_gallery:
        gallery_output = root / "pattern_gallery.json"
        gallery_gz = gallery_output.with_suffix(".json.gz")
        save_json(gallery_output, {
            "as_of_date": today_date,
            "total_items": len(gallery_items),
            "items": gallery_items,
        }, ensure_ascii=False)
        compress_file(gallery_output, gallery_gz)
        print(f"Saved pattern_gallery.json and .gz with {len(gallery_items)} historical outcomes.")

    return True


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Build market screens, setup geometry, and pattern gallery.")
    parser.add_argument("--root", type=str, default=str(BASE_DIR), help="Root directory containing pipeline outputs.")
    parser.add_argument("--ohlcv-dir", type=str, default=None, help="Directory containing OHLCV CSVs.")
    parser.add_argument("--no-gallery", action="store_true", help="Skip pattern gallery generation.")
    args = parser.parse_args()

    root = Path(args.root)
    ohlcv = Path(args.ohlcv_dir) if args.ohlcv_dir else None
    return enrich_snapshot_directory(root, ohlcv_dir=ohlcv, generate_gallery=not args.no_gallery)


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
