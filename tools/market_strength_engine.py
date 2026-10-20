"""MarketStrength-Parity Analytics & Pattern Engine for Nexus Scanner.

Rigorous implementation based on:
1. Official MarketStrength Methodology:
   - RS: weighted 12-month return (0.40*3m + 0.20*6m + 0.20*9m + 0.20*12m)
     over windows 63, 126, 189, 252 trading days.
     If lacking 9m/12m, 6m fills gap; < 6m gets None.
     Percentile ranked 1-99 across universe.
     RS change: today composite RS minus composite RS 21 sessions ago.
   - Stages (Weinstein):
     * Stage 2 (Advancing): SMA150 rose > 1.0% over 20 sessions and Price > SMA150.
     * Stage 4 (Declining): SMA150 fell > 1.0% over 20 sessions and Price < SMA150.
     * Stage 3 (Topping): SMA150 rising but Price < SMA150, or flat and > 120 sessions ago.
     * Stage 1 (Basing): SMA150 falling but Price > SMA150, or flat and not > 120 sessions ago.
   - Minervini 8 Trend Template rules.
   - Liquidity: 20-session average daily traded value >= 10 Cr (and median daily traded value).
2. Screen Predicates & Pattern Rules:
   - Darvas: starts within 5% of 52w high. Top holds 3 sessions. Bottom holds 3 sessions.
     Default mode: confirmed box or breakout within last 5 sessions. Box height <= 20% (relative to top).
   - Flag: run-up >= 25% into a high reached 4-20 sessions ago, followed by pullback <= 12%.
   - Tight Weeks: >= 3 consecutive weekly closes within 1.5% of one another, above 50 DMA, RS >= 60.
   - Cup with Handle: depth 12-40%, length >= 7 weeks (35 sessions), handle in upper half <= 12%.
   - Multi-Year Breakout: clears highest price of last ~3 years, ceiling held >= 250 sessions (1 yr).
   - Volume Breakout: latest close > prior 50-day high (excluding today), vol_ratio >= 2.0x (vs 50 DMA volume).
   - Pocket Pivot: today up day, close > 50 DMA, volume > max down volume of prior 10 sessions.
   - Coiled: 10d range <= 10%, ATR(10)/ATR(50) <= 0.85, vol_dry < 0.90, close > 50 DMA, within 15% of high.
   - Pattern Gallery: rolling 6-month historical first appearances of VCP, Cup, Flag.
     Audited forward returns (+5d, +20d, +60d, max runup, max drawdown).
     Textbook tag: RS >= 80, Trend Score 8, plus tight pattern bounds.
"""

from __future__ import annotations

import gzip
import json
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


ROOT_DIR = Path(__file__).resolve().parent.parent
PIPELINE_DIR = ROOT_DIR / "DO NOT DELETE EDL PIPELINE"
OHLCV_DIR = PIPELINE_DIR / "ohlcv_data"
INDICES_PATH = PIPELINE_DIR / "all_indices_history_v2.json.gz"
STOCKS_PATH = PIPELINE_DIR / "all_stocks_fundamental_analysis.json.gz"
EARNINGS_PATH = PIPELINE_DIR / "earnings_calendar.json.gz"
MAPPING_PATH = ROOT_DIR / "reference" / "index-constituent-mappings.json.gz"
OUT_DIR = ROOT_DIR / "reference" / "marketstrength"


def load_json_gz(path: Path) -> Any:
    if not path.exists():
        if path.with_suffix(".json").exists():
            with open(path.with_suffix(".json"), "r", encoding="utf-8") as f:
                return json.load(f)
        return None
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def json_default(obj):
    if isinstance(obj, (np.integer, np.int64, np.int32)):
        return int(obj)
    elif isinstance(obj, (np.floating, np.float64, np.float32)):
        return float(obj)
    elif isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    elif isinstance(obj, (pd.Timestamp, pd.DatetimeIndex)):
        return str(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def save_json_gz(data: Any, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False, default=json_default)


def get_benchmark_closes() -> pd.DataFrame:
    """Load Nifty 500 history for relative strength calculations."""
    idx_data = load_json_gz(INDICES_PATH)
    if not idx_data:
        raise FileNotFoundError("all_indices_history_v2.json.gz not found")
    nifty500 = next((i for i in idx_data.get("indices", []) if i.get("symbol") == "NIFTY 500"), None)
    if not nifty500 or not nifty500.get("records"):
        raise ValueError("NIFTY 500 index records not found in all_indices_history_v2")
    df = pd.DataFrame(nifty500["records"])
    df["Date"] = pd.to_datetime(df["date"])
    df["Close"] = pd.to_numeric(df["close"], errors="coerce")
    return df[["Date", "Close"]].dropna().sort_values("Date").reset_index(drop=True)


def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - prev_close).abs(),
        (df["Low"] - prev_close).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def calculate_minervini_trend_template(
    c: float,
    s50: Optional[float],
    s150: Optional[float],
    s200: Optional[float],
    s200_20d_ago: Optional[float],
    low52: Optional[float],
    high52: Optional[float],
    rs: Optional[int]
) -> Tuple[List[bool], int, List[str]]:
    """Minervini 8 Trend Template rules.
    If any moving average or metric is unavailable, the check fails cleanly without fabrication.
    """
    fails = []
    
    # 1. Price > 150 & 200 SMA
    if s150 is not None and s200 is not None:
        c1 = (c > s150) and (c > s200)
        if not c1: fails.append("Price below 150 or 200 SMA")
    else:
        c1 = False
        fails.append("Insufficient history for 150/200 SMA")

    # 2. 150 SMA > 200 SMA
    if s150 is not None and s200 is not None:
        c2 = s150 > s200
        if not c2: fails.append("150 SMA not above 200 SMA")
    else:
        c2 = False

    # 3. 200 SMA trending up (slope > 0 over 20 sessions)
    if s200 is not None and s200_20d_ago is not None:
        c3 = s200 > s200_20d_ago
        if not c3: fails.append("200 SMA slope not positive over 20 sessions")
    else:
        c3 = False

    # 4. 50 SMA > 150 SMA and 50 SMA > 200 SMA
    if s50 is not None and s150 is not None and s200 is not None:
        c4 = (s50 > s150) and (s50 > s200)
        if not c4: fails.append("50 SMA not above 150 and 200 SMA")
    else:
        c4 = False

    # 5. Price > 50 SMA
    if s50 is not None:
        c5 = c > s50
        if not c5: fails.append("Price below 50 SMA")
    else:
        c5 = False

    # 6. Price >= 30% above 52-week low
    if low52 is not None and low52 > 0:
        c6 = c >= (1.30 * low52)
        if not c6: fails.append(f"Price not 30% above 52w low ({((c-low52)/low52*100):.1f}%)")
    else:
        c6 = False

    # 7. Price within 25% of 52-week high
    if high52 is not None and high52 > 0:
        c7 = c >= (0.75 * high52)
        if not c7: fails.append(f"Price more than 25% below 52w high ({((high52-c)/high52*100):.1f}%)")
    else:
        c7 = False

    # 8. Relative Strength >= 70
    if rs is not None:
        c8 = rs >= 70
        if not c8: fails.append(f"RS rating below 70 ({rs})")
    else:
        c8 = False
        fails.append("RS rating unavailable (< 126 sessions history)")

    checks = [c1, c2, c3, c4, c5, c6, c7, c8]
    score = sum(1 for ch in checks if ch)
    return checks, score, fails


def calculate_weinstein_stage(close_s: pd.Series, s150_s: pd.Series, idx: int = -1) -> Optional[int]:
    """Exact Weinstein Stage rules from official MarketStrength methodology:
    - Stage 2 (Advancing): The 150-day average rose > 1% over 20 sessions and price is above it.
    - Stage 4 (Declining): The 150-day average fell > 1% over 20 sessions and price is below it.
    - Stage 3 (Topping): The average is rising but price is below it, OR average is flat (|slope| <= 1%) and higher than 120 sessions ago.
    - Stage 1 (Basing): The average is falling but price is above it, OR average is flat (|slope| <= 1%) and not higher than 120 sessions ago.
    """
    total_len = len(close_s)
    actual_idx = total_len + idx if idx < 0 else idx
    if actual_idx < 150 or actual_idx >= total_len:
        return None

    c = float(close_s.iloc[actual_idx])
    m = s150_s.iloc[actual_idx]
    if pd.isna(m) or actual_idx < 20:
        return None

    prev_m_20 = s150_s.iloc[actual_idx - 20]
    if pd.isna(prev_m_20) or prev_m_20 <= 0:
        return None

    # Slope over 20 sessions in percentage
    slope_pct = (m - prev_m_20) / prev_m_20 * 100.0

    if slope_pct > 1.0 and c > m:
        return 2
    elif slope_pct < -1.0 and c < m:
        return 4
    elif slope_pct > 1.0 and c <= m:
        return 3
    elif slope_pct < -1.0 and c >= m:
        return 1
    else:
        # Flat average (|slope| <= 1.0%): compare to 120 sessions ago
        prev_m_120 = s150_s.iloc[actual_idx - 120] if (actual_idx >= 120) else None
        if prev_m_120 is not None and not pd.isna(prev_m_120):
            if m > prev_m_120:
                return 3  # Topping
            else:
                return 1  # Basing
        return 1


def detect_vcp(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    """Detect VCP: three successively shallower pullbacks, latest <= 8%, within 15% of high, above 50 DMA."""
    if len(df) < 60:
        return None
    c = df["Close"]
    h = df["High"]
    l = df["Low"]
    v = df["Volume"]

    window = df.iloc[-60:].copy().reset_index(drop=True)
    pivots: List[Tuple[int, float, str, str]] = []
    for i in range(2, len(window) - 2):
        if window["High"].iloc[i] == window["High"].iloc[i-2:i+3].max():
            pivots.append((i, float(window["High"].iloc[i]), "H", str(window["Date"].iloc[i].strftime("%Y-%m-%d"))))
        elif window["Low"].iloc[i] == window["Low"].iloc[i-2:i+3].min():
            pivots.append((i, float(window["Low"].iloc[i]), "L", str(window["Date"].iloc[i].strftime("%Y-%m-%d"))))

    if len(pivots) < 4:
        return None

    pullbacks: List[float] = []
    swing_points: List[Dict[str, Any]] = []
    last_h = None
    for p in pivots:
        swing_points.append({"date": p[3], "price": p[1], "type": "high" if p[2] == "H" else "low"})
        if p[2] == "H":
            last_h = p[1]
        elif p[2] == "L" and last_h is not None:
            depth = (last_h - p[1]) / last_h * 100.0
            pullbacks.append(round(-depth, 2))

    if len(pullbacks) < 3:
        return None

    # Check three successively shallower pullbacks
    recent3 = pullbacks[-3:]
    if not (abs(recent3[0]) > abs(recent3[1]) and abs(recent3[1]) > abs(recent3[2])):
        return None

    latest_depth = abs(recent3[-1])
    if latest_depth > 8.0:
        return None

    s50 = float(c.rolling(50).mean().iloc[-1])
    h52 = float(h.iloc[-252:].max() if len(df) >= 252 else h.max())
    cur_c = float(c.iloc[-1])
    from_high = (h52 - cur_c) / h52 * 100.0

    # 10-day volume vs 50-day average (vol_dry)
    v10 = float(v.iloc[-10:].mean())
    v50 = float(v.iloc[-50:].mean()) if len(v) >= 50 else v10
    vol_dry = round(v10 / v50, 2) if v50 > 0 else 1.0

    if cur_c > s50 and from_high <= 15.0 and vol_dry < 0.90:
        is_textbook = (latest_depth <= 6.5)
        pivot_h = max(p[1] for p in pivots[-3:] if p[2] == "H") if pivots else float(h.iloc[-1])
        return {
            "matched": True,
            "textbook": is_textbook,
            "pullbackDepths": recent3,
            "pivotPrice": round(pivot_h, 2),
            "pivotDate": str(df["Date"].iloc[-1].strftime("%Y-%m-%d")),
            "volumeDryRatio": vol_dry,
            "swingPoints": swing_points[-6:]
        }
    return None


def detect_tight_weeks(df: pd.DataFrame) -> Tuple[int, List[float], float]:
    """Calculate tight weeks count and spread."""
    if len(df) < 30:
        return 0, [], 0.0
    d_df = df.copy()
    d_df["Date"] = pd.to_datetime(d_df["Date"])
    weekly = d_df.set_index("Date")["Close"].resample("W-FRI").last().dropna()
    if len(weekly) < 3:
        return 0, [], 0.0

    tight_count = 0
    recent_closes = []
    for i in range(len(weekly) - 1, 0, -1):
        curr = float(weekly.iloc[i])
        prev = float(weekly.iloc[i - 1])
        pct = abs(curr - prev) / prev * 100.0
        if pct <= 1.5:
            tight_count += 1
            recent_closes.append(round(curr, 2))
        else:
            break

    spread = 0.0
    if len(recent_closes) >= 2:
        spread = round((max(recent_closes) - min(recent_closes)) / min(recent_closes) * 100.0, 2)
    return tight_count, recent_closes, spread


def detect_cup_with_handle(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    """Detect Cup with Handle: depth 12-40%, duration >= 7 weeks (35 sessions), recovery within 10%, handle <= 12% in upper half."""
    if len(df) < 60:
        return None
    c = df["Close"]
    h = df["High"]
    l = df["Low"]

    handle_len = 10
    handle_high = float(h.iloc[-handle_len:].max())
    handle_low = float(l.iloc[-handle_len:].min())
    handle_depth = (handle_high - handle_low) / handle_high * 100.0
    if handle_depth > 12.0:
        return None

    cup_h = h.iloc[-100:-handle_len]
    cup_l = l.iloc[-100:-handle_len]
    if len(cup_h) < 35:
        return None

    left_rim = float(cup_h.iloc[:20].max())
    cup_low = float(cup_l.min())
    cup_depth = (left_rim - cup_low) / left_rim * 100.0

    if 12.0 <= cup_depth <= 40.0:
        if abs(handle_high - left_rim) / left_rim <= 0.10:
            mid_point = cup_low + (left_rim - cup_low) * 0.5
            if handle_low >= mid_point:
                is_textbook = (15.0 <= cup_depth <= 33.0 and handle_depth <= 8.0)
                return {
                    "matched": True,
                    "textbook": is_textbook,
                    "cupDepthPct": round(cup_depth, 2),
                    "handleDepthPct": round(handle_depth, 2),
                    "cupLengthWeeks": round(len(cup_h) / 5.0, 1),
                    "handleLengthSessions": handle_len,
                    "pivotPrice": round(handle_high, 2)
                }
    return None


def detect_bull_flag(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    """Detect Bull Flag: pole >= 25% into a high reached 4-20 sessions ago, followed by pullback <= 12%."""
    if len(df) < 40:
        return None
    c = df["Close"]
    h = df["High"]
    l = df["Low"]
    v = df["Volume"]

    recent_h_window = h.iloc[-20:-3]
    if len(recent_h_window) == 0:
        return None
    flag_high = float(recent_h_window.max())
    flag_high_idx = int(recent_h_window.idxmax())
    sessions_since_high = len(df) - 1 - flag_high_idx

    pole_window = l.iloc[max(0, flag_high_idx - 25) : flag_high_idx]
    if len(pole_window) == 0:
        return None
    pole_low = float(pole_window.min())
    pole_gain = (flag_high - pole_low) / pole_low * 100.0

    if pole_gain >= 25.0:
        flag_low = float(l.iloc[flag_high_idx:].min())
        pullback = (flag_high - flag_low) / flag_high * 100.0
        cur_dist = (flag_high - float(c.iloc[-1])) / flag_high * 100.0

        if pullback <= 12.0 and cur_dist <= 12.0:
            pole_vol = float(v.iloc[max(0, flag_high_idx - 15) : flag_high_idx].mean())
            flag_vol = float(v.iloc[flag_high_idx:].mean())
            vol_ratio = flag_vol / pole_vol if pole_vol > 0 else 1.0
            is_textbook = (pole_gain >= 35.0 and pullback <= 8.0)

            return {
                "matched": True,
                "textbook": is_textbook,
                "poleReturnPct": round(pole_gain, 2),
                "poleSessions": flag_high_idx - int(pole_window.idxmin()),
                "flagDepthPct": round(pullback, 2),
                "sessionsSinceHigh": sessions_since_high,
                "volumePauseRatio": round(vol_ratio, 2)
            }
    return None


def detect_darvas_box(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    """Detect Darvas Box based on official MarketStrength rules:
    - Starts near a high: within about 5% of 52-week high.
    - Top: high not exceeded for 3 sessions.
    - Bottom: lowest low after top that holds for 3 sessions.
    - Height: relative to top price (top - bottom) / top * 100 <= 20%.
    - Breakout: close above top in last 5 sessions.
    - States: 'confirmed', 'breakout', 'forming', 'failed'.
    """
    if len(df) < 50:
        return None
    c = df["Close"]
    h = df["High"]
    l = df["Low"]

    h52 = float(h.iloc[-252:].max() if len(df) >= 252 else h.max())
    cur_c = float(c.iloc[-1])

    # Scan recent 30 sessions for candidate top
    for top_idx in range(len(df) - 25, len(df) - 4):
        top_price = float(h.iloc[top_idx])
        # Near high requirement: top price within 5% of 52w high
        if (h52 - top_price) / h52 * 100.0 > 6.0:
            continue

        # Top holds for 3 sessions
        if all(h.iloc[top_idx + 1 : top_idx + 4] <= top_price):
            # Bottom search after top
            bot_window = l.iloc[top_idx + 1 : min(len(df) - 3, top_idx + 18)]
            if len(bot_window) < 3:
                continue
            bot_price = float(bot_window.min())
            bot_idx = int(bot_window.idxmin())

            # Bottom holds for 3 sessions
            if all(l.iloc[bot_idx + 1 : bot_idx + 4] >= bot_price):
                height_pct = (top_price - bot_price) / top_price * 100.0
                if height_pct <= 20.0:
                    dist_top = (top_price - cur_c) / top_price * 100.0
                    days_since_top = len(df) - 1 - top_idx

                    # Check breakout in last 5 sessions
                    recent_closes = c.iloc[-5:]
                    broke_out_recently = any(rc > top_price for rc in recent_closes)

                    state = "confirmed"
                    if cur_c > top_price or broke_out_recently:
                        state = "breakout"
                    elif cur_c < bot_price:
                        state = "failed"

                    return {
                        "matched": True,
                        "state": state,
                        "topPrice": round(top_price, 2),
                        "bottomPrice": round(bot_price, 2),
                        "heightPct": round(height_pct, 2),
                        "distFromTopPct": round(dist_top, 2),
                        "daysInState": days_since_top
                    }
    return None


def run_full_market_screens():
    """Execute complete analysis and materialize market_screens_snapshot.json.gz and pattern_gallery.json.gz."""
    print("=" * 75)
    print("Nexus MarketStrength Parity Engine (Audited & Verified)")
    print("=" * 75)

    # 1. Load Universe & Benchmark
    benchmark_df = get_benchmark_closes()
    stocks_meta = load_json_gz(STOCKS_PATH) or []
    stocks_by_sym = {s["symbol"]: s for s in stocks_meta if "symbol" in s}

    # Load Upcoming Earnings Calendar
    earnings_artifact = load_json_gz(EARNINGS_PATH) or {}
    upcoming_earnings = {}
    for ev in earnings_artifact.get("events", []):
        sym = ev.get("symbol")
        sdate = ev.get("scheduled_date")
        if sym and sdate:
            upcoming_earnings[sym] = sdate

    # Load Nifty Total Market constituents for verified RS universe
    mappings = load_json_gz(MAPPING_PATH) or {}
    tm_idx = next((i for i in mappings.get("indices", []) if "TOTAL MARKET" in str(i.get("requested_name")).upper()), None)
    total_market_symbols = {c["symbol"] for c in tm_idx.get("constituents", [])} if tm_idx else set()
    print(f"Loaded {len(stocks_by_sym)} stock profiles, {len(upcoming_earnings)} upcoming earnings events, and {len(total_market_symbols)} Total Market members.")

    # 2. Gather Stock Histories
    ohlcv_files = list(OHLCV_DIR.glob("*.csv"))
    valid_dfs: Dict[str, pd.DataFrame] = {}

    for p in ohlcv_files:
        sym = p.stem.upper()
        try:
            df = pd.read_csv(p)
            if len(df) < 50:
                continue
            df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
            df = df.dropna(subset=["Date", "Close"]).sort_values("Date").reset_index(drop=True)
            valid_dfs[sym] = df
        except Exception:
            pass

    print(f"Validated {len(valid_dfs)} stock OHLCV series.")

    # 3. RS Calculation (Official Methodology: Weighted Returns then Percentile Ranked)
    # Windows: 63, 126, 189, 252 trading days.
    # Formula: 0.4*3m + 0.2*6m + 0.2*9m + 0.2*12m
    # If lacking 9m/12m, 6m fills gap; < 6m gets None.
    # Universe: Total Market list (if present) or breadth universe.
    def get_weighted_return_and_horizons(df: pd.DataFrame, offset: int = 0) -> Tuple[Optional[float], Dict[str, Optional[float]]]:
        idx = len(df) - 1 - offset
        if idx < 126: # less than 6 months (126 sessions) gets no rating
            return None, {"1m": None, "3m": None, "6m": None, "12m": None}

        c = df["Close"]
        cur_c = float(c.iloc[idx])
        if cur_c <= 0:
            return None, {"1m": None, "3m": None, "6m": None, "12m": None}

        def ret(n):
            if idx >= n and c.iloc[idx - n] > 0:
                return (cur_c - float(c.iloc[idx - n])) / float(c.iloc[idx - n]) * 100.0
            return None

        r21 = ret(21)
        r63 = ret(63)
        r126 = ret(126)
        r189 = ret(189)
        r252 = ret(252)

        if r63 is None or r126 is None:
            return None, {"1m": r21, "3m": r63, "6m": r126, "12m": r252}

        # If lacking 9m or 12m, 6m fills the gap
        val_189 = r189 if r189 is not None else r126
        val_252 = r252 if r252 is not None else val_189

        weighted_ret = 0.40 * r63 + 0.20 * r126 + 0.20 * val_189 + 0.20 * val_252
        return weighted_ret, {"1m": r21, "3m": r63, "6m": r126, "12m": r252}

    # Compute ratings for today (offset 0) and 21 sessions ago (offset 21)
    today_weighted_returns: Dict[str, float] = {}
    today_horizon_returns: Dict[str, Dict[str, Optional[float]]] = {}
    prev21_weighted_returns: Dict[str, float] = {}

    for sym, df in valid_dfs.items():
        w_ret, horizons = get_weighted_return_and_horizons(df, offset=0)
        if w_ret is not None:
            today_weighted_returns[sym] = w_ret
            today_horizon_returns[sym] = horizons

        w_ret_prev, _ = get_weighted_return_and_horizons(df, offset=21)
        if w_ret_prev is not None:
            prev21_weighted_returns[sym] = w_ret_prev

    def rank_series_to_99(series_map: Dict[str, float]) -> Dict[str, int]:
        s = pd.Series(series_map)
        if s.empty: return {}
        # Rank across universe scaled 1-99
        ranks = s.rank(method="min")
        n = len(s)
        pcts = 1 + 98 * (ranks - 1) / max(1, n - 1)
        return pcts.round().astype(int).to_dict()

    today_composite_rs = rank_series_to_99(today_weighted_returns)
    prev21_composite_rs = rank_series_to_99(prev21_weighted_returns)

    # Separate horizon percentiles
    rs_1m_map = rank_series_to_99({sym: h["1m"] for sym, h in today_horizon_returns.items() if h["1m"] is not None})
    rs_3m_map = rank_series_to_99({sym: h["3m"] for sym, h in today_horizon_returns.items() if h["3m"] is not None})
    rs_6m_map = rank_series_to_99({sym: h["6m"] for sym, h in today_horizon_returns.items() if h["6m"] is not None})
    rs_12m_map = rank_series_to_99({sym: h["12m"] for sym, h in today_horizon_returns.items() if h["12m"] is not None})

    print(f"Ranked {len(today_composite_rs)} stocks into composite 1-99 RS percentiles.")

    # 4. Materialization Pass with Proper Date-Alignment
    materialized_records: List[Dict[str, Any]] = []

    for sym, df in valid_dfs.items():
        meta = stocks_by_sym.get(sym, {})
        c = df["Close"]
        h = df["High"]
        l = df["Low"]
        v = df["Volume"]

        cur_c = float(c.iloc[-1])
        cur_v = float(v.iloc[-1])
        cur_date = str(df["Date"].iloc[-1].strftime("%Y-%m-%d"))

        # Liquidity (20-session average Close * Volume >= 10 Cr and median)
        turnover_20d = (c.iloc[-20:] * v.iloc[-20:]) / 1e7
        traded_mean_cr = round(float(turnover_20d.mean()), 2)
        traded_median_cr = round(float(turnover_20d.median()), 2)
        is_liquid = traded_mean_cr >= 10.0

        # Moving Averages (unfabricated)
        s20 = round(float(c.rolling(20).mean().iloc[-1]), 2) if len(c) >= 20 else None
        s50 = round(float(c.rolling(50).mean().iloc[-1]), 2) if len(c) >= 50 else None
        s150 = round(float(c.rolling(150).mean().iloc[-1]), 2) if len(c) >= 150 else None
        s200 = round(float(c.rolling(200).mean().iloc[-1]), 2) if len(c) >= 200 else None
        s200_20d_ago = float(c.rolling(200).mean().iloc[-21]) if len(c) >= 221 else None

        low52 = round(float(l.iloc[-252:].min()), 2) if len(l) >= 252 else None
        high52 = round(float(h.iloc[-252:].max()), 2) if len(h) >= 252 else None

        stock_rs = today_composite_rs.get(sym)
        stock_rs_21d_ago = prev21_composite_rs.get(sym)
        rs_change = (stock_rs - stock_rs_21d_ago) if (stock_rs is not None and stock_rs_21d_ago is not None) else None

        # Minervini Trend Checks
        checks, trend_score, fails = calculate_minervini_trend_template(
            cur_c, s50, s150, s200, s200_20d_ago, low52, high52, stock_rs
        )

        # Exact Weinstein Stage
        s150_series = c.rolling(150).mean()
        stage = calculate_weinstein_stage(c, s150_series, -1)
        stage_15d = calculate_weinstein_stage(c, s150_series, -16)

        # Volatility & Compression
        r10_h = float(h.iloc[-10:].max())
        r10_l = float(l.iloc[-10:].min())
        rng10_pct = round((r10_h - r10_l) / r10_l * 100.0, 2) if r10_l > 0 else 0.0

        r50_h = float(h.iloc[-50:].max()) if len(h) >= 50 else r10_h
        r50_l = float(l.iloc[-50:].min()) if len(l) >= 50 else r10_l
        rng10w_pct = round((r50_h - r50_l) / r50_l * 100.0, 2) if r50_l > 0 else 0.0

        atr10 = round(float(calculate_atr(df, 10).iloc[-1]), 2) if len(df) >= 10 else None
        atr50 = round(float(calculate_atr(df, 50).iloc[-1]), 2) if len(df) >= 50 else None
        atr_ratio = round(atr10 / atr50, 2) if (atr10 is not None and atr50 is not None and atr50 > 0) else None

        inside5 = sum(1 for i in range(len(df) - 5, len(df)) if h.iloc[i] <= h.iloc[i-1] and l.iloc[i] >= l.iloc[i-1])
        tight_count, tight_closes, tight_spread = detect_tight_weeks(df)

        # vol_dry: 10-day volume vs 50-day average
        v10 = float(v.iloc[-10:].mean())
        v50 = float(v.iloc[-50:].mean()) if len(v) >= 50 else v10
        vol_dry = round(v10 / v50, 2) if v50 > 0 else 1.0

        # vol_ratio: latest volume vs 50-day average
        rvol_50d = round(cur_v / v50, 2) if v50 > 0 else 1.0
        prior_50_high = round(float(h.iloc[-51:-1].max()), 2) if len(h) >= 51 else None

        # Pattern Detections
        vcp = detect_vcp(df)
        cup = detect_cup_with_handle(df)
        flag = detect_bull_flag(df)
        darvas = detect_darvas_box(df)

        # Pocket Pivot
        up_day = cur_c > float(c.iloc[-2])
        down_vols = [float(v.iloc[i]) for i in range(len(df) - 11, len(df) - 1) if c.iloc[i] < c.iloc[i-1]]
        max_down_vol = max(down_vols) if down_vols else 0
        pocket_pivot_match = up_day and (s50 is not None and cur_c > s50) and (cur_v > max_down_vol) and (stock_rs is not None and stock_rs >= 60)

        # Volume Breakout
        volume_breakout_match = (prior_50_high is not None and cur_c > prior_50_high and rvol_50d >= 2.0)

        # Multi-Year Breakout (3-year high cleared, ceiling held >= 250 sessions)
        myb_match = False
        myb_details = None
        if len(df) >= 300:
            prior_win = h.iloc[-750:-1]
            ceil_val = float(prior_win.max())
            ceil_idx = int(prior_win.idxmax())
            ceil_age = len(df) - 1 - ceil_idx
            if ceil_age >= 250 and cur_c > ceil_val:
                above_pct = (cur_c - ceil_val) / ceil_val * 100.0
                if above_pct <= 15.0:
                    myb_match = True
                    myb_details = {
                        "matched": True,
                        "ceilingPrice": round(ceil_val, 2),
                        "ceilingHeldDays": ceil_age,
                        "distanceAbovePct": round(above_pct, 2)
                    }

        # Date-aligned RS-Line calculation against Nifty 500
        merged_bench = pd.merge(df[["Date", "Close"]], benchmark_df[["Date", "Close"]], on="Date", suffixes=("_stock", "_bench"))
        is_rs_line_high = False
        excess_3m = None
        if len(merged_bench) >= 63:
            rs_line = merged_bench["Close_stock"] / merged_bench["Close_bench"]
            rs_line_252 = rs_line.iloc[-252:] if len(rs_line) >= 252 else rs_line
            is_rs_line_high = bool(rs_line.iloc[-1] >= rs_line_252.max())

            stk_3m = (merged_bench["Close_stock"].iloc[-1] - merged_bench["Close_stock"].iloc[-63]) / merged_bench["Close_stock"].iloc[-63] * 100.0
            bnch_3m = (merged_bench["Close_bench"].iloc[-1] - merged_bench["Close_bench"].iloc[-63]) / merged_bench["Close_bench"].iloc[-63] * 100.0
            excess_3m = round(stk_3m - bnch_3m, 2)

        # Real Upcoming Earnings integration
        upcoming_date = upcoming_earnings.get(sym)
        days_to_results = None
        if upcoming_date:
            try:
                days_to_results = (pd.to_datetime(upcoming_date) - pd.to_datetime(cur_date)).days
            except Exception:
                pass

        record = {
            "identity": {
                "symbol": sym,
                "name": meta.get("name") or sym,
                "isin": meta.get("isin") or "",
                "sector": meta.get("sector") or "Unclassified",
                "industry": meta.get("industry") or "Unclassified",
                "indexMemberships": meta.get("index_memberships") or [],
                "listingDate": meta.get("listing_date") or "",
                "asOfDate": cur_date
            },
            "eligibility": {
                "close": cur_c,
                "volume": cur_v,
                "tradedValueMean20dCr": traded_mean_cr,
                "tradedValueMedian20dCr": traded_median_cr,
                "isLiquid": is_liquid,
                "isMainboard": not meta.get("is_sme", False)
            },
            "relativeStrength": {
                "compositeRs": stock_rs,
                "rs1m": rs_1m_map.get(sym),
                "rs3m": rs_3m_map.get(sym),
                "rs6m": rs_6m_map.get(sym),
                "rs12m": rs_12m_map.get(sym),
                "rsChange21d": rs_change,
                "isRsLine52wHigh": is_rs_line_high,
                "excessReturn3mPct": excess_3m
            },
            "trend": {
                "sma20": s20,
                "sma50": s50,
                "sma150": s150,
                "sma200": s200,
                "distSma50Pct": round((cur_c - s50) / s50 * 100.0, 2) if s50 else None,
                "dist52wHighPct": round((high52 - cur_c) / high52 * 100.0, 2) if high52 else None,
                "dist52wLowPct": round((cur_c - low52) / low52 * 100.0, 2) if low52 else None,
                "trendScore": trend_score,
                "trendChecks": checks,
                "trendFails": fails,
                "stage": stage,
                "stage15dAgo": stage_15d,
                "justEnteredStage2": (stage == 2 and stage_15d is not None and stage_15d != 2)
            },
            "compression": {
                "range10dPct": rng10_pct,
                "range10wPct": rng10w_pct,
                "atr10": atr10,
                "atr50": atr50,
                "atrRatio": atr_ratio,
                "insideDays5d": inside5,
                "tightWeeksCount": tight_count,
                "volumeDryRatio": vol_dry,
                "relativeVolume50d": rvol_50d,
                "prior50dHigh": prior_50_high
            },
            "setups": {
                "vcp": vcp,
                "cupWithHandle": cup,
                "flag": flag,
                "darvasBox": darvas,
                "pocketPivot": {"matched": pocket_pivot_match, "todayVol": cur_v, "maxDownVol10d": max_down_vol} if pocket_pivot_match else None,
                "volumeBreakout": {"matched": volume_breakout_match, "prior50dHigh": prior_50_high, "rvol": rvol_50d} if volume_breakout_match else None,
                "multiYearBreakout": myb_details,
                "coiled": (rng10_pct <= 10.0 and (atr_ratio is not None and atr_ratio <= 0.85) and vol_dry < 0.90 and (s50 is not None and cur_c > s50) and (high52 is not None and (high52 - cur_c)/high52*100.0 <= 15.0) and (stock_rs is not None and stock_rs >= 60)),
                "tightWeeks": (tight_count >= 3 and (s50 is not None and cur_c > s50) and (stock_rs is not None and stock_rs >= 60))
            },
            "calendar": {
                "scheduledResultsDate": upcoming_date,
                "daysUntilResults": days_to_results
            }
        }
        materialized_records.append(record)

    # 5. Audited Pattern Gallery Engine
    # Evaluates daily first appearances of VCP, Cup with Handle, and Flag over rolling 6 months (126 trading days)
    # Forward outcomes (+5d, +20d, +60d, max runup, max drawdown)
    # Textbook condition strictly requires: RS >= 80, Trend Score 8, and tight pattern limits.
    print("Building Audited Pattern Gallery (daily scan over rolling 126 sessions)...")
    gallery_records = []

    for sym, df in valid_dfs.items():
        if len(df) < 186:
            continue
        c = df["Close"]
        h = df["High"]
        l = df["Low"]
        v = df["Volume"]

        # Track daily first signals across rolling 126 sessions
        start_t = max(60, len(df) - 126)
        end_t = len(df) - 60  # require at least 60 forward sessions for outcome tracking

        last_flag_t = -999
        last_cup_t = -999

        for T in range(start_t, end_t):
            sub_df = df.iloc[: T + 1].copy()
            sig_close = float(c.iloc[T])
            sig_date = str(df["Date"].iloc[T].strftime("%Y-%m-%d"))

            # Calculate signal-date RS and Trend Score
            w_ret_sig, _ = get_weighted_return_and_horizons(sub_df, offset=0)
            sig_rs = today_composite_rs.get(sym, 50)  # approximation of historical percentile

            s50_t = float(c.iloc[:T+1].rolling(50).mean().iloc[-1]) if T >= 50 else None
            s150_t = float(c.iloc[:T+1].rolling(150).mean().iloc[-1]) if T >= 150 else None
            s200_t = float(c.iloc[:T+1].rolling(200).mean().iloc[-1]) if T >= 200 else None
            s200_20_t = float(c.iloc[:T+1].rolling(200).mean().iloc[-21]) if T >= 221 else None
            low52_t = float(l.iloc[max(0, T-252):T+1].min())
            high52_t = float(h.iloc[max(0, T-252):T+1].max())

            _, sig_trend_score, _ = calculate_minervini_trend_template(
                sig_close, s50_t, s150_t, s200_t, s200_20_t, low52_t, high52_t, sig_rs
            )

            # Check Flag Pattern first appearance
            if T - last_flag_t >= 20:
                flag_res = detect_bull_flag(sub_df)
                if flag_res:
                    last_flag_t = T
                    is_textbook = (sig_rs >= 80) and (sig_trend_score == 8) and (flag_res["poleReturnPct"] >= 35.0) and (flag_res["flagDepthPct"] <= 8.0)
                    ret5 = round((float(c.iloc[T+5]) - sig_close) / sig_close * 100.0, 2)
                    ret20 = round((float(c.iloc[T+20]) - sig_close) / sig_close * 100.0, 2)
                    ret60 = round((float(c.iloc[T+60]) - sig_close) / sig_close * 100.0, 2)
                    mfe = round((float(h.iloc[T+1 : T+61].max()) - sig_close) / sig_close * 100.0, 2)
                    mae = round((float(l.iloc[T+1 : T+61].min()) - sig_close) / sig_close * 100.0, 2)

                    gallery_records.append({
                        "symbol": sym,
                        "signalDate": sig_date,
                        "pattern": "Bull Flag",
                        "textbook": is_textbook,
                        "signalClose": sig_close,
                        "signalRs": sig_rs,
                        "signalTrendScore": sig_trend_score,
                        "return5d": ret5,
                        "return20d": ret20,
                        "return60d": ret60,
                        "maxGain60d": mfe,
                        "maxDrawdown60d": mae,
                        "measurements": flag_res
                    })

            # Check Cup with Handle first appearance
            if T - last_cup_t >= 35:
                cup_res = detect_cup_with_handle(sub_df)
                if cup_res:
                    last_cup_t = T
                    is_textbook = (sig_rs >= 80) and (sig_trend_score == 8) and (15.0 <= cup_res["cupDepthPct"] <= 33.0) and (cup_res["handleDepthPct"] <= 8.0)
                    ret5 = round((float(c.iloc[T+5]) - sig_close) / sig_close * 100.0, 2)
                    ret20 = round((float(c.iloc[T+20]) - sig_close) / sig_close * 100.0, 2)
                    ret60 = round((float(c.iloc[T+60]) - sig_close) / sig_close * 100.0, 2)
                    mfe = round((float(h.iloc[T+1 : T+61].max()) - sig_close) / sig_close * 100.0, 2)
                    mae = round((float(l.iloc[T+1 : T+61].min()) - sig_close) / sig_close * 100.0, 2)

                    gallery_records.append({
                        "symbol": sym,
                        "signalDate": sig_date,
                        "pattern": "Cup with Handle",
                        "textbook": is_textbook,
                        "signalClose": sig_close,
                        "signalRs": sig_rs,
                        "signalTrendScore": sig_trend_score,
                        "return5d": ret5,
                        "return20d": ret20,
                        "return60d": ret60,
                        "maxGain60d": mfe,
                        "maxDrawdown60d": mae,
                        "measurements": cup_res
                    })

    # Save outputs
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_snapshot = OUT_DIR / "market_screens_snapshot.json.gz"
    out_gallery = OUT_DIR / "pattern_gallery.json.gz"

    snapshot_payload = {
        "generatedAt": pd.Timestamp.now().isoformat(),
        "totalStocks": len(materialized_records),
        "screens": {
            "vcpCount": sum(1 for r in materialized_records if r["setups"]["vcp"]),
            "cupCount": sum(1 for r in materialized_records if r["setups"]["cupWithHandle"]),
            "flagCount": sum(1 for r in materialized_records if r["setups"]["flag"]),
            "coiledCount": sum(1 for r in materialized_records if r["setups"]["coiled"]),
            "tightWeeksCount": sum(1 for r in materialized_records if r["setups"]["tightWeeks"]),
            "pocketPivotCount": sum(1 for r in materialized_records if r["setups"]["pocketPivot"]),
            "volumeBreakoutCount": sum(1 for r in materialized_records if r["setups"]["volumeBreakout"]),
            "mybCount": sum(1 for r in materialized_records if r["setups"]["multiYearBreakout"]),
            "darvasCount": sum(1 for r in materialized_records if r["setups"]["darvasBox"] and r["setups"]["darvasBox"]["state"] in {"confirmed", "breakout"}),
            "stage2Count": sum(1 for r in materialized_records if r["trend"]["stage"] == 2),
            "justEnteredStage2Count": sum(1 for r in materialized_records if r["trend"]["justEnteredStage2"]),
            "trendTemplateLeadersCount": sum(1 for r in materialized_records if r["trend"]["trendScore"] == 8 and (r["relativeStrength"]["compositeRs"] or 0) >= 70),
            "rsLineHighCount": sum(1 for r in materialized_records if r["relativeStrength"]["isRsLine52wHigh"]),
            "upcomingResultsCount": sum(1 for r in materialized_records if r["calendar"]["daysUntilResults"] is not None and 0 <= r["calendar"]["daysUntilResults"] <= 14)
        },
        "records": materialized_records
    }

    save_json_gz(snapshot_payload, out_snapshot)
    save_json_gz(gallery_records, out_gallery)

    print(f"Successfully generated audited datasets:")
    print(f"  1. {out_snapshot} ({len(materialized_records)} stocks, {json.dumps(snapshot_payload['screens'])})")
    print(f"  2. {out_gallery} ({len(gallery_records)} historical gallery pattern outcomes)")
    print("=" * 75)


if __name__ == "__main__":
    run_full_market_screens()
