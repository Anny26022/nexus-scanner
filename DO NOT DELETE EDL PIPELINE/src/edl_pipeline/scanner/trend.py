"""Daily trend-condition engine over locally cached OHLCV history.

The engine deliberately returns ``unavailable`` rather than guessing when a
symbol does not have sufficient history.  Conditions in a request are ANDed;
the ``persistent_momentum`` condition itself is an explicit any-of EMA rule.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .patterns import PATTERN_CONDITION_REGISTRY, evaluate_pattern
from .context import CONTEXT_CONDITION_REGISTRY, evaluate_context_condition, normalize_condition_spec
from .indicators import OSCILLATORS, indicator_series, supertrend


REQUIRED_COLUMNS = ("Date", "Open", "High", "Low", "Close", "Volume")
COMPARISONS = {
    "greater": lambda left, right: left > right,
    "greater_or_equal": lambda left, right: left >= right,
    "less": lambda left, right: left < right,
    "less_or_equal": lambda left, right: left <= right,
    "equal": lambda left, right: left == right,
}

# This is intentionally data, rather than UI code, so a web client can render
# the exact supported controls without duplicating the calculation contract.
CONDITION_REGISTRY = {
    "indicator_compare": {
        "inputs": {"left_indicator": "indicator", "left_period": "integer", "left_offset": "integer", "op": "greater|above|equal|below|less|crosses_above|crosses_below", "right_indicator": "indicator|empty", "right_value": "number", "right_period": "integer", "right_offset": "integer", "fired_within": "integer"},
        "definition": "Compare an indicator with a number or another indicator, including crossover events and trading-session offsets.",
    },
    "ma_convergence": {
        "inputs": {"periods": "integer[]", "ma_type": "sma|ema", "comparison": "comparison", "max_spread_percent": "number", "fired_within": "integer"},
        "definition": "Compare 100 × (highest selected MA − lowest selected MA) / close with the configured spread threshold; the default is at or below the tolerance.",
    },
    "divergence": {
        "inputs": {"oscillator": "oscillator", "oscillator_period": "integer", "direction": "bullish|bearish", "variant": "regular|hidden", "max_bar_difference": "integer", "pivot_left": "integer", "pivot_right": "integer", "lookback_days": "integer", "fired_within": "integer", "invalidate_on_break": "boolean"},
        "definition": "Confirmed price and oscillator fractal pivots form regular or hidden bullish/bearish divergence without future-bar leakage.",
    },
    "supertrend": {
        "inputs": {"period": "integer", "multiplier": "number", "direction": "bullish|bearish", "fired_within": "integer", "signal": "state|turn"},
        "definition": "Wilder-ATR Supertrend direction is in the selected state or turned into it within the recent window.",
    },
    "delivery_percent": {
        "inputs": {"comparison": "comparison", "value": "number"},
        "definition": "Latest session delivery percentage from date-aligned official delivery history.",
    },
    "persistent_momentum": {
        "inputs": {"periods": "integer[]", "persist_days": "integer | {period: integer}", "persistence_mode": "strict_close|reclaim_by_extreme"},
        "definition": "Any requested EMA period has stayed below the close for its required run; the default permits one reclaimed breach.",
    },
    "price_vs_ema": {
        "inputs": {"period": "integer", "comparison": "above|below", "persist_days": "integer", "persistence_mode": "extreme_reset|strict_close|reclaim_by_extreme"},
        "definition": "EMA persistence defaults to extreme reset: a later bar must break the contrary close bar's low (above-run) or high (below-run).",
    },
    "ema_shakeout_reclaim": {
        "inputs": {"period": "integer", "dip_within": "integer", "dip_basis": "low|close"},
        "definition": "A recent dip below the EMA followed by a latest close back above it.",
    },
    "adx": {
        "inputs": {"period": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Wilder ADX, a direction-neutral trend-strength measure.",
    },
    "price_vs_sma": {
        "inputs": {"period": "integer", "comparison": "above|below", "persist_days": "integer", "persistence_mode": "strict_close|reclaim_by_extreme"},
        "definition": "Close stays on the selected side of the SMA for a run.",
    },
    "percent_days_above_ma": {
        "inputs": {"period": "integer", "ma_type": "sma|ema", "window": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Percentage of closes above the selected moving average in the window.",
    },
    "ma_stack": {
        "inputs": {"periods": "integer[]", "ma_type": "sma|ema", "price_above_fastest": "boolean"},
        "definition": "Moving averages are strictly ordered from the shortest to longest period.",
    },
    "ma_slope": {
        "inputs": {"period": "integer", "ma_type": "sma|ema", "window": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Percent change in a moving average from the start to the end of a window.",
    },
    "price_change_percent": {
        "inputs": {"window": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Close-to-close percentage change over the requested number of sessions.",
    },
    "consecutive_up_days": {
        "inputs": {"minimum_up_days": "integer", "fired_within": "integer"},
        "definition": "A run of higher closes occurred within the requested recent sessions.",
    },
    "gap_up": {
        "inputs": {"minimum_gap_percent": "number", "fired_within": "integer"},
        "definition": "Open exceeded the prior close by at least the threshold within the recent sessions.",
    },
    "gap_down": {
        "inputs": {"minimum_gap_percent": "number", "fired_within": "integer"},
        "definition": "Open was below the prior close by at least the threshold within the recent sessions.",
    },
    "relative_volume": {
        "inputs": {"average_window": "integer", "multiple": "number", "fired_within": "integer"},
        "definition": "Volume was at least a multiple of its preceding average volume within the recent sessions.",
    },
    "volume_trend": {
        "inputs": {"recent_window": "integer", "base_window": "integer", "comparison": "comparison", "value": "number"},
        "definition": "Ratio of recent average volume to the immediately preceding base-window average.",
    },
    "highest_volume": {
        "inputs": {"lookback": "integer", "fired_within": "integer", "closed_up": "boolean"},
        "definition": "A session had the highest volume in its lookback window, optionally while closing above its prior close.",
    },
    "delivery_percent_spike": {
        "inputs": {"minimum_delivery_percent": "number", "fired_within": "integer"},
        "definition": "NSE delivery percentage met the threshold on a session within the requested window.",
    },
    **PATTERN_CONDITION_REGISTRY,
    **CONTEXT_CONDITION_REGISTRY,
}


@dataclass(frozen=True)
class ConditionResult:
    condition: str
    status: str
    value: float | bool | None
    details: dict[str, Any]

    def as_dict(self):
        return {
            "condition": self.condition,
            "status": self.status,
            "value": self.value,
            "details": self.details,
        }


def _result(condition, matched, value=None, **details):
    return ConditionResult(condition, "match" if matched else "no_match", value, details)


def _unavailable(condition, reason):
    return ConditionResult(condition, "unavailable", None, {"reason": reason})


def _comparison(value, comparison, target):
    try:
        return bool(COMPARISONS[comparison](value, target))
    except KeyError as error:
        raise ValueError(f"Unsupported comparison: {comparison}") from error


def normalize_history(rows: pd.DataFrame, as_of_date: str | None = None):
    missing = [column for column in REQUIRED_COLUMNS if column not in rows.columns]
    if missing:
        raise ValueError(f"Missing OHLCV columns: {', '.join(missing)}")
    frame = rows.loc[:, [*REQUIRED_COLUMNS, *(["Turnover"] if "Turnover" in rows else [])]].copy()
    if "Turnover" in frame:
        frame["Turnover"] = pd.to_numeric(frame["Turnover"], errors="coerce").where(lambda values: values >= 0)
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    for column in REQUIRED_COLUMNS[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.replace([np.inf, -np.inf], np.nan).dropna(subset=("Date", "Open", "High", "Low", "Close"))
    frame = frame.loc[(frame["Close"] > 0) & (frame["High"] >= frame["Low"])]
    if as_of_date:
        cutoff = pd.Timestamp(as_of_date)
        frame = frame.loc[frame["Date"] <= cutoff]
    return frame.sort_values("Date").drop_duplicates("Date", keep="last").reset_index(drop=True)


def _ma(frame, ma_type, period):
    period = int(period)
    if period <= 0:
        raise ValueError("Moving-average period must be positive.")
    if ma_type == "sma":
        return frame["Close"].rolling(period, min_periods=period).mean()
    if ma_type == "ema":
        return frame["Close"].ewm(span=period, adjust=False, min_periods=period).mean()
    raise ValueError("ma_type must be 'sma' or 'ema'.")


def _adx(frame, period):
    period = int(period)
    if period <= 0:
        raise ValueError("ADX period must be positive.")
    high, low, close = frame["High"], frame["Low"], frame["Close"]
    previous_close = close.shift(1)
    true_range = pd.concat((high - low, (high - previous_close).abs(), (low - previous_close).abs()), axis=1).max(axis=1)
    upward = high.diff()
    downward = -low.diff()
    plus_dm = upward.where((upward > downward) & (upward > 0), 0.0)
    minus_dm = downward.where((downward > upward) & (downward > 0), 0.0)
    atr = true_range.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr
    denominator = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / denominator
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def _event_result(condition, flags, fired_within, values=None, **details):
    frame = details.pop("frame")
    fired_within = int(fired_within)
    if fired_within <= 0:
        raise ValueError("fired_within must be positive.")
    recent = flags.tail(fired_within)
    if len(recent) < fired_within or recent.isna().all():
        return _unavailable(condition, "insufficient_history")
    locations = np.flatnonzero(recent.to_numpy(dtype=bool, na_value=False))
    if not len(locations):
        return _result(condition, False, None, fired_within=fired_within, **details)
    offset = int(locations[-1])
    index = len(flags) - len(recent) + offset
    value = None if values is None or pd.isna(values.iloc[index]) else round(float(values.iloc[index]), 6)
    return _result(condition, True, value, fired_within=fired_within,
                   days_since_signal=len(recent) - 1 - offset,
                   signal_date=frame["Date"].iloc[index].strftime("%Y-%m-%d"), **details)


def _confirmed_pivots(values, pivot_type, left, right):
    output = []
    for index in range(left, len(values) - right):
        value = values.iloc[index]
        if pd.isna(value):
            continue
        window = values.iloc[index - left:index + right + 1]
        if window.isna().any():
            continue
        is_pivot = value <= window.min() if pivot_type == "low" else value >= window.max()
        if is_pivot and (window == value).sum() == 1:
            output.append((index, float(value), index + right))
    return output


def _divergence_events(frame, oscillator, spec):
    direction = str(spec.get("direction", "bullish")).lower()
    variant = str(spec.get("variant", "regular")).lower()
    left, right = int(spec.get("pivot_left", 5)), int(spec.get("pivot_right", 3))
    max_gap = int(spec.get("max_bar_difference", 1))
    lookback = int(spec.get("lookback_days", 120))
    if direction not in {"bullish", "bearish"} or variant not in {"regular", "hidden"}:
        raise ValueError("Divergence direction/variant is invalid.")
    if min(left, right, lookback) <= 0 or max_gap < 0:
        raise ValueError("Divergence pivot and lookback settings are invalid.")
    start = max(0, len(frame) - lookback - right - left)
    price = frame["Low"] if direction == "bullish" else frame["High"]
    pivot_type = "low" if direction == "bullish" else "high"
    price_pivots = _confirmed_pivots(price.iloc[start:].reset_index(drop=True), pivot_type, left, right)
    oscillator_pivots = _confirmed_pivots(oscillator.iloc[start:].reset_index(drop=True), pivot_type, left, right)
    aligned = []
    used_oscillator_pivots = set()
    for price_index, price_value, confirmed in price_pivots:
        options = [item for item in oscillator_pivots
                   if item[0] not in used_oscillator_pivots and abs(item[0] - price_index) <= max_gap]
        if options:
            oscillator_pivot = min(options, key=lambda item: abs(item[0] - price_index))
            used_oscillator_pivots.add(oscillator_pivot[0])
            aligned.append((price_index + start, price_value, oscillator_pivot[1],
                            max(confirmed, oscillator_pivot[2]) + start))
    events = pd.Series(False, index=frame.index, dtype=bool)
    metadata = {}
    for first, second in zip(aligned, aligned[1:]):
        if direction == "bullish":
            price_regular, oscillator_regular = second[1] < first[1], second[2] > first[2]
            price_hidden, oscillator_hidden = second[1] > first[1], second[2] < first[2]
        else:
            price_regular, oscillator_regular = second[1] > first[1], second[2] < first[2]
            price_hidden, oscillator_hidden = second[1] < first[1], second[2] > first[2]
        matched = price_regular and oscillator_regular if variant == "regular" else price_hidden and oscillator_hidden
        signal = second[3]
        if matched and signal < len(events):
            if spec.get("invalidate_on_break", True):
                after = price.iloc[second[0] + 1:signal + 1]
                broken = bool((after < second[1]).any()) if direction == "bullish" else bool((after > second[1]).any())
                if broken:
                    continue
            events.iloc[signal] = True
            metadata[signal] = {"first_pivot": first, "second_pivot": second}
    return events, metadata


def _persisted(frame, average, comparison, days, mode):
    days = int(days)
    if days <= 0:
        raise ValueError("persist_days must be positive.")
    window = frame.tail(days)
    averages = average.tail(days)
    if len(window) < days or averages.isna().any():
        return None
    desired = window["Close"] > averages if comparison == "above" else window["Close"] < averages
    if comparison not in {"above", "below"}:
        raise ValueError("comparison must be 'above' or 'below'.")
    if mode == "strict_close":
        return bool(desired.all())
    if mode == "extreme_reset":
        # A contrary close arms that candle's low (above run) or high
        # (below run). Only a later trade through that extreme resets the run.
        # Keep the anchor outside the requested tail: a reset in today's
        # window may have been armed by a candle before that window.
        run = 0
        anchor = None
        for close, low, high, value in zip(frame["Close"], frame["Low"], frame["High"], average):
            if pd.isna(value):
                run, anchor = 0, None
                continue
            on_side = close > value if comparison == "above" else close < value
            crossed = anchor is not None and (low < anchor if comparison == "above" else high > anchor)
            if crossed:
                run, anchor = 0, None
            if run == 0:
                if on_side:
                    run = 1
            else:
                run += 1
                if not on_side and anchor is None:
                    anchor = low if comparison == "above" else high
        return run >= days
    if mode != "reclaim_by_extreme":
        raise ValueError("persistence_mode must be strict_close, extreme_reset or reclaim_by_extreme.")

    # A single contrary close does not reset the run when a later bar trades
    # through that breach bar's extreme and closes back on the desired side.
    breaches = np.flatnonzero(~desired.to_numpy())
    if len(breaches) == 0:
        return True
    if len(breaches) != 1:
        return False
    breach_index = int(breaches[0])
    later = window.iloc[breach_index + 1:]
    if later.empty:
        return False
    breach = window.iloc[breach_index]
    if comparison == "above":
        reclaimed = (later["High"] >= breach["High"]) & (later["Close"] > averages.iloc[breach_index + 1:])
    else:
        reclaimed = (later["Low"] <= breach["Low"]) & (later["Close"] < averages.iloc[breach_index + 1:])
    return bool(reclaimed.any())


def _evaluate(frame, spec, delivery_history=None, context=None):
    base_kind=str(spec.get('kind') or spec.get('condition') or '').upper()
    if base_kind=='BASE_SETUP':
        from .base_conditions import select_setup_episode
        from .presets import get_preset
        p=spec.get('params',spec);context=context or {}
        records=context.get('base_episodes');symbol=(context.get('stock') or {}).get('symbol')
        if isinstance(records,dict):records=records.get(symbol)
        value,_=select_setup_episode(records,get_preset(p['presetId']),p)
        return _unavailable('base_setup','setup_candidates_unavailable') if value is None else _result('base_setup',value)
    if base_kind in ('BASE_STAGE','BASE_METRIC','BASE_FORMULA'):
        from .base_conditions import evaluate_base_condition
        context=context or {}
        records=context.get('base_episodes')
        if isinstance(records,dict) and (context.get('stock') or {}).get('symbol') in records:
            records=records[context['stock']['symbol']]
        parameters=spec.get('params',spec)
        value=evaluate_base_condition(records,base_kind,parameters)
        return _unavailable(base_kind.lower(),'base_record_unavailable') if value is None else _result(base_kind.lower(),value)
    spec = normalize_condition_spec(spec)
    condition = spec.get("condition") or spec.get("id")
    if condition not in CONDITION_REGISTRY and condition != "field_comparison":
        raise ValueError(f"Unsupported trend condition: {condition!r}")
    if frame.empty:
        return _unavailable(condition, "no_ohlcv_history")

    pattern_result = evaluate_pattern(frame, spec, _result, _unavailable, _comparison, _ma)
    if pattern_result is not None:
        return pattern_result

    context_result = evaluate_context_condition(frame, spec, context, _result, _unavailable, _comparison)
    if context_result is not None:
        return context_result

    if condition == "indicator_compare":
        left_name = str(spec.get("left_indicator", "RSI")).upper()
        right_name = str(spec.get("right_indicator", "")).upper()
        left_offset, right_offset = int(spec.get("left_offset", 0)), int(spec.get("right_offset", 0))
        if left_offset < 0 or right_offset < 0:
            raise ValueError("Indicator offsets must be zero or positive.")
        left = indicator_series(frame, left_name, int(spec.get("left_period", 14)), float(spec.get("multiplier", 3))).shift(left_offset)
        if right_name:
            right = indicator_series(frame, right_name, int(spec.get("right_period", 20)), float(spec.get("right_multiplier", 3))).shift(right_offset)
        else:
            right = pd.Series(float(spec.get("right_value", 0)), index=frame.index)
        operation = str(spec.get("op", "ABOVE")).upper()
        valid = left.notna() & right.notna()
        if operation == "GREATER":
            flags = (left > right).where(valid)
        elif operation == "ABOVE":
            flags = (left >= right).where(valid)
        elif operation == "LESS":
            flags = (left < right).where(valid)
        elif operation == "BELOW":
            flags = (left <= right).where(valid)
        elif operation == "EQUAL":
            flags = left.eq(right).where(valid)
        elif operation == "CROSSES_ABOVE":
            flags = ((left > right) & (left.shift(1) <= right.shift(1))).where(valid & valid.shift(1, fill_value=False))
        elif operation == "CROSSES_BELOW":
            flags = ((left < right) & (left.shift(1) >= right.shift(1))).where(valid & valid.shift(1, fill_value=False))
        else:
            raise ValueError("Unsupported indicator comparison operation.")
        return _event_result(condition, flags, spec.get("fired_within", 1), left, frame=frame,
                             left_indicator=left_name, right_indicator=right_name or None,
                             right_value=None if right_name else float(spec.get("right_value", 0)), operation=operation)

    if condition == "ma_convergence":
        periods = spec.get("periods", (9, 20, 50, 200))
        if isinstance(periods, str):
            periods = [part.strip() for part in periods.split(",") if part.strip()]
        periods = [int(period) for period in periods]
        if len(periods) < 2 or len(set(periods)) != len(periods):
            raise ValueError("MA convergence needs at least two distinct periods.")
        ma_type = str(spec.get("ma_type", "ema")).lower()
        values = pd.concat([_ma(frame, ma_type, period) for period in periods], axis=1)
        spread = (values.max(axis=1) - values.min(axis=1)) / frame["Close"].replace(0, np.nan) * 100
        complete = values.notna().all(axis=1) & frame["Close"].gt(0)
        threshold = float(spec.get("max_spread_percent", 1.5))
        comparison = str(spec.get("comparison", "less_or_equal")).lower()
        spread_comparisons = {
            "greater": spread.gt, "greater_or_equal": spread.ge,
            "less": spread.lt, "less_or_equal": spread.le, "equal": spread.eq,
        }
        if comparison not in spread_comparisons:
            raise ValueError("Unsupported MA convergence comparison.")
        flags = spread_comparisons[comparison](threshold).where(complete)
        return _event_result(condition, flags, spec.get("fired_within", 1), spread, frame=frame,
                             periods=periods, ma_type=ma_type,
                             comparison=comparison, max_spread_percent=threshold,
                             latest_averages=[round(float(value), 6) if not pd.isna(value) else None for value in values.iloc[-1]])

    if condition == "supertrend":
        period, multiplier = int(spec.get("period", 10)), float(spec.get("multiplier", 3))
        line, direction = supertrend(frame, period, multiplier)
        requested_direction = str(spec.get("direction", "bullish")).lower()
        if requested_direction not in {"bullish", "bearish"}:
            raise ValueError("Supertrend direction must be bullish or bearish.")
        wanted = 1 if requested_direction == "bullish" else -1
        state = direction.eq(wanted).where(direction.notna())
        signal = str(spec.get("signal", "state")).lower()
        if signal not in {"state", "turn"}:
            raise ValueError("Supertrend signal must be state or turn.")
        flags = state if signal == "state" else (
            state.fillna(False) & ~state.shift(1).fillna(False)
        ).where(direction.notna() & direction.shift(1).notna())
        return _event_result(condition, flags, spec.get("fired_within", 1), line, frame=frame,
                             period=period, multiplier=multiplier, direction="bullish" if wanted == 1 else "bearish", signal=signal)

    if condition == "divergence":
        oscillator_name = str(spec.get("oscillator", "RSI")).upper()
        if oscillator_name not in OSCILLATORS:
            raise ValueError(f"Unsupported divergence oscillator: {oscillator_name}")
        oscillator = indicator_series(frame, oscillator_name, int(spec.get("oscillator_period", 14)))
        if oscillator.notna().sum() == 0:
            return _unavailable(condition, "insufficient_history")
        flags, metadata = _divergence_events(frame, oscillator, spec)
        outcome = _event_result(condition, flags, spec.get("fired_within", 8), oscillator, frame=frame,
                                oscillator=oscillator_name, oscillator_period=int(spec.get("oscillator_period", 14)),
                                direction=str(spec.get("direction", "bullish")).lower(), variant=str(spec.get("variant", "regular")).lower())
        if outcome.status == "match":
            signal_index = len(frame) - 1 - int(outcome.details["days_since_signal"])
            if signal_index in metadata:
                outcome.details["pivots"] = metadata[signal_index]
        return outcome

    if condition == "delivery_percent":
        target_date = frame["Date"].iloc[-1].strftime("%Y-%m-%d")
        values = {str(item.get("date")): item.get("delivery_percent") for item in (delivery_history or [])}
        raw = values.get(target_date)
        if raw is None:
            return _unavailable(condition, "dated_delivery_percent_unavailable")
        value = float(raw); target = float(spec["value"])
        return _result(condition, _comparison(value, spec["comparison"], target), round(value, 6),
                       comparison=spec["comparison"], target=target, date=target_date)

    if condition == "persistent_momentum":
        periods = [int(period) for period in spec.get("periods", (10, 20, 50))]
        required = spec.get("persist_days", 1)
        # Persistent Momentum has its own one-breach reclaim rule. Price vs
        # EMA uses the separately documented extreme-reset rule below.
        persistence_mode = spec.get("persistence_mode", "reclaim_by_extreme")
        outcomes = {}
        for period in periods:
            days = int(required.get(str(period), required.get(period, 1)) if isinstance(required, dict) else required)
            persisted = _persisted(frame, _ma(frame, "ema", period), "above", days, persistence_mode)
            outcomes[str(period)] = persisted
        if not any(value is True for value in outcomes.values()) and any(value is None for value in outcomes.values()):
            return _unavailable(condition, "insufficient_history")
        return _result(condition, any(outcomes.values()), any(outcomes.values()), qualifying_periods=[key for key, value in outcomes.items() if value], runs=outcomes, persistence_mode=persistence_mode)

    if condition in {"price_vs_ema", "price_vs_sma"}:
        ma_type = "ema" if condition == "price_vs_ema" else "sma"
        persistence_mode = spec.get("persistence_mode", "extreme_reset" if ma_type == "ema" else "strict_close")
        persisted = _persisted(frame, _ma(frame, ma_type, spec["period"]), spec["comparison"], spec["persist_days"], persistence_mode)
        if persisted is None:
            return _unavailable(condition, "insufficient_history")
        return _result(condition, persisted, persisted, period=int(spec["period"]), comparison=spec["comparison"], persist_days=int(spec["persist_days"]), persistence_mode=persistence_mode)

    if condition == "ema_shakeout_reclaim":
        average = _ma(frame, "ema", spec["period"])
        dip_within = int(spec["dip_within"])
        recent = frame.tail(dip_within)
        recent_average = average.tail(dip_within)
        if len(recent) < dip_within or recent_average.isna().any():
            return _unavailable(condition, "insufficient_history")
        dip_basis = spec.get("dip_basis", "low")
        dips = recent["Low"] < recent_average if dip_basis == "low" else recent["Close"] < recent_average
        if dip_basis not in {"low", "close"}:
            raise ValueError("dip_basis must be 'low' or 'close'.")
        matched = bool(dips.any() and recent["Close"].iloc[-1] > recent_average.iloc[-1])
        return _result(condition, matched, matched, period=int(spec["period"]), dip_within=dip_within, dip_basis=dip_basis)

    if condition == "adx":
        value = _adx(frame, spec["period"]).iloc[-1]
        if pd.isna(value):
            return _unavailable(condition, "insufficient_history")
        return _result(condition, _comparison(float(value), spec["comparison"], float(spec["value"])), round(float(value), 6), period=int(spec["period"]), comparison=spec["comparison"], target=float(spec["value"]))

    if condition == "percent_days_above_ma":
        window = int(spec["window"])
        average = _ma(frame, spec.get("ma_type", "sma"), spec["period"])
        values = frame.tail(window)
        averages = average.tail(window)
        if len(values) < window or averages.isna().any():
            return _unavailable(condition, "insufficient_history")
        percentage = float((values["Close"] > averages).mean() * 100)
        return _result(condition, _comparison(percentage, spec["comparison"], float(spec["value"])), round(percentage, 6), period=int(spec["period"]), ma_type=spec.get("ma_type", "sma"), window=window, comparison=spec["comparison"], target=float(spec["value"]))

    if condition == "ma_stack":
        periods = sorted(int(period) for period in spec["periods"])
        if len(periods) < 2 or len(set(periods)) != len(periods):
            raise ValueError("ma_stack needs at least two distinct periods.")
        averages = [_ma(frame, spec.get("ma_type", "sma"), period).iloc[-1] for period in periods]
        if any(pd.isna(value) for value in averages):
            return _unavailable(condition, "insufficient_history")
        matched = all(left > right for left, right in zip(averages, averages[1:]))
        if spec.get("price_above_fastest", False):
            matched = matched and bool(frame["Close"].iloc[-1] > averages[0])
        return _result(condition, matched, matched, periods=periods, ma_type=spec.get("ma_type", "sma"), averages=[round(float(value), 6) for value in averages])

    if condition == "ma_slope":
        window = int(spec["window"])
        average = _ma(frame, spec.get("ma_type", "sma"), spec["period"])
        if len(average) <= window or pd.isna(average.iloc[-1]) or pd.isna(average.iloc[-1 - window]) or average.iloc[-1 - window] == 0:
            return _unavailable(condition, "insufficient_history")
        slope = float((average.iloc[-1] / average.iloc[-1 - window] - 1) * 100)
        return _result(condition, _comparison(slope, spec["comparison"], float(spec["value"])), round(slope, 6), period=int(spec["period"]), ma_type=spec.get("ma_type", "sma"), window=window, comparison=spec["comparison"], target=float(spec["value"]))

    if condition == "price_change_percent":
        window = int(spec["window"])
        if window <= 0 or len(frame) <= window:
            return _unavailable(condition, "insufficient_history")
        prior = frame["Close"].iloc[-1 - window]
        if prior == 0:
            return _unavailable(condition, "invalid_prior_close")
        change = float((frame["Close"].iloc[-1] / prior - 1) * 100)
        return _result(condition, _comparison(change, spec["comparison"], float(spec["value"])), round(change, 6), window=window, comparison=spec["comparison"], target=float(spec["value"]))

    if condition == "consecutive_up_days":
        minimum, fired_within = int(spec["minimum_up_days"]), int(spec.get("fired_within", 1))
        if minimum <= 0 or fired_within <= 0 or len(frame) <= minimum:
            return _unavailable(condition, "insufficient_history")
        up = frame["Close"].diff().gt(0)
        runs = up.groupby((~up).cumsum()).cumsum()
        candidates = [(age, int(runs.iloc[-1 - age])) for age in range(min(fired_within, len(frame))) if runs.iloc[-1 - age] >= minimum]
        matched = bool(candidates)
        age, run = candidates[0] if candidates else (None, int(runs.iloc[-1]))
        return _result(condition, matched, run, minimum_up_days=minimum, fired_within=fired_within, days_since_signal=age)

    if condition in {"gap_up", "gap_down"}:
        fired_within = int(spec.get("fired_within", 1))
        if fired_within <= 0 or len(frame) < 2:
            return _unavailable(condition, "insufficient_history")
        gap = (frame["Open"] / frame["Close"].shift(1) - 1) * 100
        threshold = float(spec["minimum_gap_percent"])
        values = gap.tail(fired_within)
        qualifying = values >= threshold if condition == "gap_up" else values <= -threshold
        locations = np.flatnonzero(qualifying.fillna(False).to_numpy())
        matched = len(locations) > 0
        offset = int(locations[-1]) if matched else None
        value = float(values.iloc[offset]) if matched else None
        return _result(condition, matched, round(value, 6) if value is not None else None, minimum_gap_percent=threshold, fired_within=fired_within, days_since_signal=(len(values) - 1 - offset) if offset is not None else None)

    if condition == "relative_volume":
        average_window, fired_within = int(spec["average_window"]), int(spec.get("fired_within", 1))
        if average_window <= 0 or fired_within <= 0 or len(frame) <= average_window:
            return _unavailable(condition, "insufficient_history")
        baseline = frame["Volume"].shift(1).rolling(average_window, min_periods=average_window).mean()
        ratios = frame["Volume"] / baseline
        values = ratios.tail(fired_within)
        comparison = spec.get("comparison", "greater_or_equal")
        qualifying = values.map(lambda value: False if pd.isna(value) else _comparison(float(value), comparison, float(spec["multiple"])))
        locations = np.flatnonzero(qualifying.fillna(False).to_numpy())
        matched = len(locations) > 0
        offset = int(locations[-1]) if matched else None
        value = float(values.iloc[offset]) if matched else None
        return _result(condition, matched, round(value, 6) if value is not None else None, average_window=average_window, multiple=float(spec["multiple"]), comparison=comparison, fired_within=fired_within, days_since_signal=(len(values) - 1 - offset) if offset is not None else None)

    if condition == "volume_trend":
        recent, base = int(spec["recent_window"]), int(spec["base_window"])
        if recent <= 0 or base <= 0 or len(frame) < recent + base:
            return _unavailable(condition, "insufficient_history")
        base_average = frame["Volume"].iloc[-recent - base:-recent].mean()
        if pd.isna(base_average) or base_average <= 0:
            return _unavailable(condition, "invalid_base_volume")
        ratio = float(frame["Volume"].tail(recent).mean() / base_average)
        return _result(condition, _comparison(ratio, spec["comparison"], float(spec["value"])), round(ratio, 6), recent_window=recent, base_window=base, comparison=spec["comparison"], target=float(spec["value"]))

    if condition == "highest_volume":
        lookback, fired_within = int(spec["lookback"]), int(spec.get("fired_within", 1))
        if lookback <= 0 or fired_within <= 0 or len(frame) < lookback:
            return _unavailable(condition, "insufficient_history")
        highest = frame["Volume"].rolling(lookback, min_periods=lookback).max()
        candidates = (frame["Volume"].eq(highest)).tail(fired_within)
        if spec.get("closed_up", False):
            candidates &= frame["Close"].gt(frame["Close"].shift(1)).tail(fired_within)
        locations = np.flatnonzero(candidates.fillna(False).to_numpy())
        matched = len(locations) > 0
        offset = int(locations[-1]) if matched else None
        value = int(frame["Volume"].tail(fired_within).iloc[offset]) if matched else None
        return _result(condition, matched, value, lookback=lookback, fired_within=fired_within, closed_up=bool(spec.get("closed_up", False)), days_since_signal=(fired_within - 1 - offset) if offset is not None else None)

    if condition == "delivery_percent_spike":
        fired_within = int(spec.get("fired_within", 1))
        if fired_within <= 0:
            raise ValueError("fired_within must be positive.")
        by_date = {
            str(item.get("date")): item.get("delivery_percent")
            for item in (delivery_history or [])
            if isinstance(item, dict) and item.get("date") and item.get("delivery_percent") is not None
        }
        sessions = frame.tail(fired_within)["Date"].dt.strftime("%Y-%m-%d").tolist()
        values = [by_date.get(session) for session in sessions]
        known = [(index, float(value)) for index, value in enumerate(values) if value is not None]
        if not known:
            return _unavailable(condition, "no_delivery_history_for_window")
        threshold = float(spec["minimum_delivery_percent"])
        qualifying = [(index, value) for index, value in known if value >= threshold]
        index, value = qualifying[-1] if qualifying else (None, max(value for _, value in known))
        return _result(condition, bool(qualifying), round(value, 6), minimum_delivery_percent=threshold, fired_within=fired_within, days_since_signal=(len(sessions) - 1 - index) if index is not None else None, available_sessions=len(known))

    raise AssertionError("registry and evaluator are out of sync")


def _combine_group(operator, children):
    """Three-valued boolean logic: unknown only survives when it can matter."""
    statuses = [child["status"] for child in children]
    if operator == "AND":
        status = "no_match" if "no_match" in statuses else ("unavailable" if "unavailable" in statuses else "match")
    elif operator == "OR":
        status = "match" if "match" in statuses else ("unavailable" if "unavailable" in statuses else "no_match")
    else:
        raise ValueError("Expression group op must be AND or OR.")
    return {"type": "group", "op": operator, "status": status, "children": children}


def _evaluate_expression(frame, expression, delivery_history, context):
    if isinstance(expression, list):
        expression = {"type": "group", "op": "AND", "children": expression}
    if not isinstance(expression, dict):
        raise ValueError("Screen expression must be a condition or group object.")
    if expression.get("type") == "group" or "children" in expression:
        children = expression.get("children") or []
        if not children:
            raise ValueError("Screen expression group must not be empty.")
        return _combine_group(str(expression.get("op", "AND")).upper(), [
            _evaluate_expression(frame, child, delivery_history, context) for child in children
        ])
    result = _evaluate(frame, expression, delivery_history, context).as_dict()
    return {"type": "condition", "status": result["status"], "result": result}


def _leaf_results(node):
    if node["type"] == "condition":
        return [node["result"]]
    return [result for child in node["children"] for result in _leaf_results(child)]


def evaluate_history(rows, conditions, as_of_date: str | None = None, delivery_history=None, context=None):
    """Evaluate a flat legacy list or compatible expression tree."""
    frame = normalize_history(pd.DataFrame(rows), as_of_date)
    context = dict(context or {})
    context["delivery_history"] = delivery_history or []
    expression = _evaluate_expression(frame, conditions, delivery_history, context)
    return {
        "status": expression["status"],
        "as_of_date": frame["Date"].iloc[-1].strftime("%Y-%m-%d") if not frame.empty else None,
        "conditions": _leaf_results(expression),
        "expression": expression,
    }


def evaluate_universe(ohlcv_directory, conditions, as_of_date: str | None = None, include_non_matches=False, delivery_history=None, context_by_symbol=None, symbols=None):
    """Evaluate a screen against selected cached symbols, returning only matches by default."""
    directory = Path(ohlcv_directory)
    wanted = {str(symbol).upper() for symbol in symbols} if symbols else None
    context_by_symbol = dict(context_by_symbol or {})
    if 'BASE_' in json.dumps(conditions) and 'base_episodes' not in context_by_symbol:
        from .base_publication import build_base_records, load_history_audits
        frames={}
        for path in sorted(directory.glob('*.csv')):
            stock=(context_by_symbol.get('stocks') or {}).get(path.stem,{})
            if not stock.get('default_screener_eligible',True):continue
            frame=normalize_history(pd.read_csv(path),as_of_date)
            if not frame.empty and (not as_of_date or str(frame.Date.iloc[-1].date())==as_of_date):frames[path.stem]=frame
        stocks={symbol:(context_by_symbol.get('stocks') or {}).get(symbol,{'symbol':symbol}) for symbol in frames}
        context_by_symbol['base_episodes']=build_base_records(frames,stocks,context_by_symbol.get('benchmarks'),selected_only=True,setup_candidates=True,history_audits=load_history_audits(directory.parent))
    results = []
    counts = {"match": 0, "no_match": 0, "unavailable": 0}
    for path in sorted(directory.glob("*.csv")):
        if wanted is not None and path.stem.upper() not in wanted:
            continue
        context = dict(context_by_symbol or {})
        context["stock"] = (context.get("stocks") or {}).get(path.stem, {})
        outcome = evaluate_history(pd.read_csv(path), conditions, as_of_date, (delivery_history or {}).get(path.stem, []), context)
        counts[outcome["status"]] += 1
        if include_non_matches or outcome["status"] == "match":
            results.append({"symbol": path.stem, **outcome})
    return {
        "generated_at": date.today().isoformat(),
        "as_of_date": as_of_date,
        "condition_count": len(conditions),
        "counts": counts,
        "results": results,
    }


def evaluate_universe_range(ohlcv_directory, conditions, dates, include_non_matches=False, delivery_history=None, context_for_date=None, symbols=None):
    """Run a screen independently at each supplied trading-session date.

    Range mode intentionally returns one point-in-time screen per session rather
    than flattening a condition into an undocumented, ambiguous "range match".
    """
    runs = []
    for session in dates:
        context = context_for_date(session) if context_for_date else None
        runs.append(evaluate_universe(
            ohlcv_directory, conditions, session, include_non_matches,
            delivery_history, context, symbols,
        ))
    return {"mode": "range", "from": dates[0] if dates else None, "to": dates[-1] if dates else None, "runs": runs}
