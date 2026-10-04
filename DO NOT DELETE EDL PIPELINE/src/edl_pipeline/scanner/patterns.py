"""Range and chart-pattern conditions over normalized daily OHLCV history.

The published condition contract defines the supported screener controls. The
calculations are intentionally deterministic and include diagnostics so a
consumer can explain *which* session, gap, leg, or resistance line matched.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pandas as pd


PATTERN_CONDITION_REGISTRY = {
    "new_high": {
        "inputs": {"lookback_days": "integer", "fired_within": "integer"},
        "definition": "A session in the recent window printed the highest high of its lookback window.",
    },
    "new_low": {
        "inputs": {"lookback_days": "integer", "fired_within": "integer"},
        "definition": "A session in the recent window printed the lowest low of its lookback window.",
    },
    "percent_from_52w_high": {
        "inputs": {"comparison": "comparison", "value": "number"},
        "definition": "Latest close's percentage distance below the highest high in the latest 252 sessions, or all available post-listing sessions.",
    },
    "percent_from_52w_low": {
        "inputs": {"comparison": "comparison", "value": "number"},
        "definition": "Latest close's percentage distance above the lowest low in the latest 252 sessions, or all available post-listing sessions.",
    },
    "consolidation_range": {
        "inputs": {"lookback_days": "integer", "max_range_percent": "number", "exclude_latest": "integer"},
        "definition": "High-to-low range of a completed base as a percentage of its final close.",
    },
    "atr_percent": {
        "inputs": {"period": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Wilder ATR as a percentage of the latest close.",
    },
    "range_contraction": {
        "inputs": {"recent_days": "integer", "prior_days": "integer", "max_ratio": "number", "prior_mode": "nested|prior"},
        "definition": "Recent range divided by an enclosing or immediately preceding base range.",
    },
    "inside_bar": {
        "inputs": {"timeframe": "daily|weekly", "consecutive": "integer", "weekly_mode": "completed|current"},
        "definition": "The requested number of latest bars each fit inside the preceding bar's range. Weekly mode defaults to completed weeks; current-week results are provisional.",
    },
    "unfilled_gap": {
        "inputs": {"direction": "up|down", "minimum_gap_percent": "number", "within_days": "integer", "state": "unfilled|filled"},
        "definition": "A qualifying historical gap whose prior-close level has or has not subsequently traded through.",
    },
    "vcp_contraction_legs": {
        "inputs": {"minimum_legs": "integer", "lookback_days": "integer", "max_final_leg_percent": "number", "max_leg_ratio": "number", "minimum_swing_percent": "number"},
        "definition": "Successive zig-zag swing legs contract in percentage size.",
    },
    "horizontal_resistance_line": {
        "inputs": {"lookback_days": "integer", "minimum_swing_percent": "number", "cluster_tolerance_percent": "number", "minimum_base_length_days": "integer", "maximum_base_length_days": "integer", "minimum_base_depth_percent": "number", "maximum_base_depth_percent": "number", "maximum_percent_below_line": "number", "maximum_percent_below_20ema": "number"},
        "definition": "An unbroken swing-high ceiling, clustered with nearby older touches and constrained to an active base.",
    },
}


def _pick(spec: dict[str, Any], snake: str, camel: str | None = None, default=None):
    """Accept the pipeline's snake_case contract and legacy field names."""
    if snake in spec:
        return spec[snake]
    if camel and camel in spec:
        return spec[camel]
    return default


def _atr(frame: pd.DataFrame, period: int) -> pd.Series:
    period = int(period)
    if period <= 0:
        raise ValueError("ATR period must be positive.")
    previous_close = frame["Close"].shift(1)
    true_range = pd.concat((
        frame["High"] - frame["Low"],
        (frame["High"] - previous_close).abs(),
        (frame["Low"] - previous_close).abs(),
    ), axis=1).max(axis=1)
    return true_range.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def _range_percent(frame: pd.DataFrame) -> float | None:
    if frame.empty or frame["Close"].iloc[-1] <= 0:
        return None
    return float((frame["High"].max() - frame["Low"].min()) / frame["Close"].iloc[-1] * 100)


def _range_width(frame: pd.DataFrame) -> float | None:
    if frame.empty:
        return None
    return float(frame["High"].max() - frame["Low"].min())


def _weekly(frame: pd.DataFrame) -> pd.DataFrame:
    """Fold daily NSE sessions by ISO week, matching the referenced screener."""
    iso = frame["Date"].dt.isocalendar()
    grouped = frame.assign(_year=iso.year, _week=iso.week).groupby(["_year", "_week"], sort=True)
    weekly = grouped.agg(Date=("Date", "max"), Open=("Open", "first"), High=("High", "max"), Low=("Low", "min"), Close=("Close", "last"), Volume=("Volume", "sum")).reset_index(drop=True)
    return weekly


def _inside_run(frame: pd.DataFrame, consecutive: int) -> bool | None:
    if consecutive <= 0:
        raise ValueError("consecutive must be positive.")
    if len(frame) < consecutive + 1:
        return None
    latest = frame.tail(consecutive + 1)
    return bool(((latest["High"].iloc[1:].to_numpy() <= latest["High"].iloc[:-1].to_numpy()) & (latest["Low"].iloc[1:].to_numpy() >= latest["Low"].iloc[:-1].to_numpy())).all())


def _zigzag_pivots(frame: pd.DataFrame, minimum_swing_percent: float) -> list[tuple[int, float, str]]:
    """Return alternating close-based pivots after the requested percentage reversal.

    The reversal threshold removes trivial noise; high/low values are still used
    to price the completed high/low pivot, which makes the legs chart-native.
    """
    threshold = float(minimum_swing_percent) / 100
    if threshold <= 0:
        raise ValueError("minimum_swing_percent must be positive.")
    if len(frame) < 3:
        return []
    closes = frame["Close"].to_numpy(dtype=float)
    pivots: list[tuple[int, float, str]] = []
    direction = 0
    extreme_index = 0
    extreme_close = closes[0]
    for index in range(1, len(closes)):
        close = closes[index]
        if direction >= 0:
            if close >= extreme_close:
                extreme_index, extreme_close = index, close
            elif extreme_close > 0 and (extreme_close - close) / extreme_close >= threshold:
                pivots.append((extreme_index, float(frame["High"].iloc[extreme_index]), "high"))
                direction, extreme_index, extreme_close = -1, index, close
                continue
        if direction <= 0:
            if close <= extreme_close:
                extreme_index, extreme_close = index, close
            elif extreme_close > 0 and (close - extreme_close) / extreme_close >= threshold:
                pivots.append((extreme_index, float(frame["Low"].iloc[extreme_index]), "low"))
                direction, extreme_index, extreme_close = 1, index, close
    if direction > 0:
        pivots.append((extreme_index, float(frame["High"].iloc[extreme_index]), "high"))
    elif direction < 0:
        pivots.append((extreme_index, float(frame["Low"].iloc[extreme_index]), "low"))
    return pivots


def _evaluate_patterns(
    frame: pd.DataFrame,
    spec: dict[str, Any],
    result: Callable[..., Any],
    unavailable: Callable[..., Any],
    comparison: Callable[[float, str, float], bool],
    ma: Callable[[pd.DataFrame, str, int], pd.Series],
):
    condition = spec.get("condition") or spec.get("id")

    if condition in {"new_high", "new_low"}:
        lookback = int(_pick(spec, "lookback_days", "lookbackDays"))
        fired_within = int(_pick(spec, "fired_within", "withinDays", 1))
        if lookback <= 0 or fired_within <= 0 or len(frame) < lookback:
            return unavailable(condition, "insufficient_history")
        source = frame["High"] if condition == "new_high" else frame["Low"]
        extrema = source.rolling(lookback, min_periods=lookback).max() if condition == "new_high" else source.rolling(lookback, min_periods=lookback).min()
        candidate = source.eq(extrema).tail(fired_within)
        locations = np.flatnonzero(candidate.to_numpy())
        matched = len(locations) > 0
        offset = int(locations[-1]) if matched else None
        signal_index = len(frame) - fired_within + offset if offset is not None else None
        value = float(source.iloc[signal_index]) if signal_index is not None else None
        return result(condition, matched, round(value, 6) if value is not None else None, lookback_days=lookback, fired_within=fired_within, days_since_signal=(fired_within - 1 - offset) if offset is not None else None, signal_date=frame["Date"].iloc[signal_index].strftime("%Y-%m-%d") if signal_index is not None else None)

    if condition in {"percent_from_52w_high", "percent_from_52w_low"}:
        if frame.empty:
            return unavailable(condition, "insufficient_history")
        # A newly listed stock has no pre-listing sessions.  Treat its
        # available listed history as its 52-week window instead of making the
        # condition permanently unavailable until session 252.  Established
        # stocks remain capped at the latest 252 trading sessions.
        sessions = min(252, len(frame))
        extreme = float(frame["High"].tail(sessions).max()) if condition.endswith("high") else float(frame["Low"].tail(sessions).min())
        if extreme <= 0:
            return unavailable(condition, "invalid_extreme")
        close = float(frame["Close"].iloc[-1])
        distance = (extreme - close) / extreme * 100 if condition.endswith("high") else (close - extreme) / extreme * 100
        target = float(_pick(spec, "value", "pct"))
        return result(condition, comparison(distance, spec["comparison"], target), round(distance, 6), comparison=spec["comparison"], target=target, extreme=round(extreme, 6), sessions=sessions)

    if condition == "consolidation_range":
        lookback = int(_pick(spec, "lookback_days", "lookbackDays"))
        exclude_latest = int(_pick(spec, "exclude_latest", "excludeLatest", 0))
        threshold = float(_pick(spec, "max_range_percent", "maxRangePct"))
        if lookback <= 0 or exclude_latest < 0 or len(frame) < lookback + exclude_latest:
            return unavailable(condition, "insufficient_history")
        end = len(frame) - exclude_latest if exclude_latest else len(frame)
        base = frame.iloc[end - lookback:end]
        range_percent = _range_percent(base)
        if range_percent is None:
            return unavailable(condition, "invalid_base_close")
        return result(condition, range_percent <= threshold, round(range_percent, 6), lookback_days=lookback, exclude_latest=exclude_latest, max_range_percent=threshold, base_end_date=base["Date"].iloc[-1].strftime("%Y-%m-%d"))

    if condition == "atr_percent":
        period = int(spec["period"])
        value = _atr(frame, period).iloc[-1]
        if pd.isna(value) or frame["Close"].iloc[-1] <= 0:
            return unavailable(condition, "insufficient_history")
        percentage = float(value / frame["Close"].iloc[-1] * 100)
        target = float(_pick(spec, "value", "pct"))
        return result(condition, comparison(percentage, spec["comparison"], target), round(percentage, 6), period=period, comparison=spec["comparison"], target=target)

    if condition == "range_contraction":
        recent_days = int(_pick(spec, "recent_days", "recentDays"))
        prior_days = int(_pick(spec, "prior_days", "priorDays"))
        max_ratio = float(_pick(spec, "max_ratio", "maxRatio"))
        mode = str(_pick(spec, "prior_mode", "priorMode", "nested")).lower()
        if recent_days <= 0 or prior_days <= 0 or mode not in {"nested", "prior"}:
            raise ValueError("range_contraction needs positive windows and prior_mode nested|prior.")
        required = max(prior_days, recent_days) if mode == "nested" else recent_days + prior_days
        if len(frame) < required:
            return unavailable(condition, "insufficient_history")
        recent = frame.tail(recent_days)
        prior = frame.tail(prior_days) if mode == "nested" else frame.iloc[-recent_days - prior_days:-recent_days]
        # Compare literal high-to-low widths. This ensures a nested recent
        # window can never exceed its enclosing base, as the screener's own
        # condition definition promises.
        recent_range, prior_range = _range_width(recent), _range_width(prior)
        if recent_range is None or prior_range is None or prior_range <= 0:
            return unavailable(condition, "invalid_range")
        ratio = recent_range / prior_range
        return result(condition, ratio <= max_ratio, round(ratio, 6), recent_days=recent_days, prior_days=prior_days, prior_mode=mode, max_ratio=max_ratio, recent_range_width=round(recent_range, 6), prior_range_width=round(prior_range, 6))

    if condition == "inside_bar":
        timeframe = str(_pick(spec, "timeframe", None, "daily")).lower()
        consecutive = int(spec.get("consecutive", 1))
        if timeframe not in {"daily", "weekly"}:
            raise ValueError("inside_bar timeframe must be daily or weekly.")
        weekly_mode = str(_pick(spec, "weekly_mode", "weeklyMode", "completed")).lower()
        if weekly_mode not in {"completed", "current"}:
            raise ValueError("inside_bar weekly_mode must be completed or current.")
        bars = _weekly(frame) if timeframe == "weekly" else frame
        if timeframe == "weekly" and weekly_mode == "completed":
            # With daily bars alone we cannot prove that the final ISO week is
            # exchange-complete (holiday weeks included), so the safe mode
            # excludes the developing/latest bucket.  Current mode includes it
            # and explicitly reports the result as provisional.
            bars = bars.iloc[:-1]
        matched = _inside_run(bars, consecutive)
        if matched is None:
            return unavailable(condition, "insufficient_history")
        return result(condition, matched, matched, timeframe=timeframe, consecutive=consecutive,
                      weekly_mode=weekly_mode if timeframe == "weekly" else None,
                      provisional=timeframe == "weekly" and weekly_mode == "current",
                      signal_date=bars["Date"].iloc[-1].strftime("%Y-%m-%d"))

    if condition == "unfilled_gap":
        direction = str(spec.get("direction", "up")).lower()
        state = str(spec.get("state", "unfilled")).lower()
        threshold = float(_pick(spec, "minimum_gap_percent", "minGapPct"))
        within = int(_pick(spec, "within_days", "withinDays", 60))
        if direction not in {"up", "down"} or state not in {"unfilled", "filled"}:
            raise ValueError("unfilled_gap direction must be up|down and state must be unfilled|filled.")
        if within <= 0 or len(frame) < 2:
            return unavailable(condition, "insufficient_history")
        start = max(1, len(frame) - within)
        events = []
        for index in range(start, len(frame)):
            prior_close = float(frame["Close"].iloc[index - 1])
            gap_percent = (float(frame["Open"].iloc[index]) / prior_close - 1) * 100 if prior_close else np.nan
            qualifying = gap_percent >= threshold if direction == "up" else gap_percent <= -threshold
            if not qualifying:
                continue
            later = frame.iloc[index + 1:]
            filled = bool((later["Low"] <= prior_close).any()) if direction == "up" else bool((later["High"] >= prior_close).any())
            if (state == "filled") == filled:
                events.append((index, gap_percent, prior_close, filled))
        if not events:
            return result(condition, False, None, direction=direction, state=state, minimum_gap_percent=threshold, within_days=within)
        index, gap_percent, level, filled = events[-1]
        return result(condition, True, round(float(gap_percent), 6), direction=direction, state=state, minimum_gap_percent=threshold, within_days=within, gap_date=frame["Date"].iloc[index].strftime("%Y-%m-%d"), gap_fill_level=round(level, 6), days_since_signal=len(frame) - 1 - index, filled=filled)

    if condition == "vcp_contraction_legs":
        lookback = int(_pick(spec, "lookback_days", "lookbackDays"))
        minimum_legs = int(_pick(spec, "minimum_legs", "minLegs"))
        max_final = float(_pick(spec, "max_final_leg_percent", "maxFinalLegPct"))
        max_ratio = float(_pick(spec, "max_leg_ratio", "maxLegRatio"))
        min_swing = float(_pick(spec, "minimum_swing_percent", "minSwingPct"))
        if lookback <= 0 or minimum_legs < 2:
            raise ValueError("vcp_contraction_legs needs a positive lookback and at least two legs.")
        window = frame.tail(lookback)
        pivots = _zigzag_pivots(window, min_swing)
        legs = [abs(right[1] - left[1]) / left[1] * 100 for left, right in zip(pivots, pivots[1:]) if left[1] > 0]
        if len(legs) < minimum_legs:
            return unavailable(condition, "insufficient_qualified_swings")
        latest = legs[-minimum_legs:]
        ratios = [right / left for left, right in zip(latest, latest[1:]) if left > 0]
        matched = latest[-1] <= max_final and len(ratios) == minimum_legs - 1 and all(ratio <= max_ratio for ratio in ratios)
        relevant_pivots = pivots[-(minimum_legs + 1):]
        return result(condition, matched, round(latest[-1], 6), minimum_legs=minimum_legs, lookback_days=lookback, max_final_leg_percent=max_final, max_leg_ratio=max_ratio, minimum_swing_percent=min_swing, leg_percents=[round(value, 6) for value in latest], leg_ratios=[round(value, 6) for value in ratios], pivot_dates=[window["Date"].iloc[pivot[0]].strftime("%Y-%m-%d") for pivot in relevant_pivots])

    if condition == "horizontal_resistance_line":
        lookback = int(_pick(spec, "lookback_days", "lookbackDays"))
        min_swing = float(_pick(spec, "minimum_swing_percent", "minSwingPct"))
        tolerance = float(_pick(spec, "cluster_tolerance_percent", "clusterTolerancePct"))
        min_length = int(_pick(spec, "minimum_base_length_days", "minBaseLengthDays"))
        # These optional bounds are omitted by the public Horizontal
        # Resistance preset, so apply its published control defaults here.
        max_length = int(_pick(spec, "maximum_base_length_days", "maxBaseLengthDays", 400))
        min_depth = float(_pick(spec, "minimum_base_depth_percent", "minBaseDepthPct", 0))
        max_depth = float(_pick(spec, "maximum_base_depth_percent", "maxBaseDepthPct", 60))
        max_below_line = float(_pick(spec, "maximum_percent_below_line", "maxPctBelowLine"))
        max_below_ema = float(_pick(spec, "maximum_percent_below_20ema", "maxPctBelow20Ema"))
        if len(frame) < 21 or lookback <= 0:
            return unavailable(condition, "insufficient_history")
        window = frame.tail(lookback).reset_index(drop=True)
        pivots = [pivot for pivot in _zigzag_pivots(window, min_swing) if pivot[2] == "high"]
        if not pivots:
            return unavailable(condition, "no_swing_high_pivot")
        candidate = None
        for pivot in reversed(pivots):
            index, price, _ = pivot
            # A malformed source candle can carry a zero high despite a
            # positive close. It cannot define a percentage-based ceiling.
            if price > 0 and not (window["Close"].iloc[index + 1:] > price).any():
                candidate = pivot
                break
        if candidate is None:
            return result(condition, False, None, reason="all_pivots_broken_by_close")
        index, line, _ = candidate
        tolerance_fraction = tolerance / 100
        clustered = [pivot for pivot in pivots if pivot[0] <= index and abs(pivot[1] - line) / line <= tolerance_fraction and not (window["Close"].iloc[pivot[0] + 1:] > line).any()]
        oldest = min(clustered, key=lambda pivot: pivot[0]) if clustered else candidate
        base_start = oldest[0]
        base_length = len(window) - 1 - base_start
        base = window.iloc[base_start:]
        base_depth = (line - float(base["Low"].min())) / line * 100 if line > 0 else np.nan
        close = float(window["Close"].iloc[-1])
        below_line = (line - close) / line * 100
        ema20 = ma(frame, "ema", 20).iloc[-1]
        below_ema = (float(ema20) - close) / float(ema20) * 100 if not pd.isna(ema20) and ema20 > 0 else np.nan
        matched = (min_length <= base_length <= max_length and min_depth <= base_depth <= max_depth and below_line <= max_below_line and not pd.isna(below_ema) and below_ema <= max_below_ema)
        return result(condition, matched, round(line, 6), lookback_days=lookback, line=round(line, 6), latest_pivot_date=window["Date"].iloc[index].strftime("%Y-%m-%d"), base_start_date=window["Date"].iloc[base_start].strftime("%Y-%m-%d"), base_length_days=base_length, base_depth_percent=round(base_depth, 6), percent_below_line=round(below_line, 6), percent_below_20ema=round(float(below_ema), 6) if not pd.isna(below_ema) else None, clustered_touches=len(clustered))

    return None


def evaluate_pattern(frame, spec, result, unavailable, comparison, ma):
    """Evaluate a pattern spec, or return ``None`` for a non-pattern spec."""
    condition = spec.get("condition") or spec.get("id")
    if condition not in PATTERN_CONDITION_REGISTRY:
        return None
    return _evaluate_patterns(frame, spec, result, unavailable, comparison, ma)
