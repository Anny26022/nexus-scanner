"""Reusable, deterministic technical indicators for scanner conditions.

All functions consume an already-normalized daily OHLCV frame.  They return a
series aligned to that frame and leave warm-up rows as NaN, so callers can
distinguish insufficient history from a negative match.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


PRICE_SERIES = {"CLOSE", "OPEN", "HIGH", "LOW", "VOLUME", "HL2", "HLC3", "OHLC4"}
SUPPORTED_INDICATORS = PRICE_SERIES | {
    "SMA", "EMA", "WMA", "VOLUME_SMA", "RSI", "MACD", "MACD_SIGNAL", "MACD_HIST",
    "STOCH_K", "STOCH_D", "CCI", "WILLIAMS_R", "MFI", "ROC", "OBV", "ADX",
    "PLUS_DI", "MINUS_DI", "ATR", "SUPERTREND", "SUPERTREND_DIRECTION",
    "BB_UPPER", "BB_MIDDLE", "BB_LOWER", "BB_PCTB", "BB_WIDTH",
    "DONCHIAN_UPPER", "DONCHIAN_LOWER",
}
OSCILLATORS = {"RSI", "MACD", "MACD_HIST", "STOCH_K", "CCI", "MFI", "WILLIAMS_R", "ROC", "OBV"}


def _positive_period(period: int) -> int:
    value = int(period)
    if value <= 0:
        raise ValueError("Indicator period must be positive.")
    return value


def true_range(frame: pd.DataFrame) -> pd.Series:
    previous = frame["Close"].shift(1)
    return pd.concat((
        frame["High"] - frame["Low"],
        (frame["High"] - previous).abs(),
        (frame["Low"] - previous).abs(),
    ), axis=1).max(axis=1)


def wilder_average(values: pd.Series, period: int) -> pd.Series:
    period = _positive_period(period)
    return values.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def directional_series(frame: pd.DataFrame, period: int) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    period = _positive_period(period)
    upward, downward = frame["High"].diff(), -frame["Low"].diff()
    plus_dm = upward.where((upward > downward) & (upward > 0), 0.0)
    minus_dm = downward.where((downward > upward) & (downward > 0), 0.0)
    atr = wilder_average(true_range(frame), period)
    plus_di = 100 * wilder_average(plus_dm, period) / atr.replace(0, np.nan)
    minus_di = 100 * wilder_average(minus_dm, period) / atr.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return atr, plus_di, minus_di, wilder_average(dx, period)


def supertrend(frame: pd.DataFrame, period: int = 10, multiplier: float = 3.0) -> tuple[pd.Series, pd.Series]:
    """Return Supertrend line and direction (1 bullish, -1 bearish).

    ATR uses Wilder smoothing.  Bands carry forward using the prior close and
    direction switches only when the close crosses the carried opposite band.
    """
    period = _positive_period(period)
    multiplier = float(multiplier)
    if multiplier <= 0:
        raise ValueError("Supertrend multiplier must be positive.")
    atr = wilder_average(true_range(frame), period)
    midpoint = (frame["High"] + frame["Low"]) / 2
    basic_upper, basic_lower = midpoint + multiplier * atr, midpoint - multiplier * atr
    closes = frame["Close"].to_numpy(dtype=float)
    middle_values = midpoint.to_numpy(dtype=float)
    basic_upper_values = basic_upper.to_numpy(dtype=float)
    basic_lower_values = basic_lower.to_numpy(dtype=float)
    upper = np.full(len(frame), np.nan); lower = np.full(len(frame), np.nan)
    line = np.full(len(frame), np.nan); direction = np.full(len(frame), np.nan)
    valid = np.flatnonzero(atr.notna().to_numpy())
    if not len(valid):
        return pd.Series(line, index=frame.index), pd.Series(direction, index=frame.index)
    start = int(valid[0])
    upper[start], lower[start] = basic_upper_values[start], basic_lower_values[start]
    direction[start] = 1 if closes[start] >= middle_values[start] else -1
    line[start] = lower[start] if direction[start] == 1 else upper[start]
    for index in range(start + 1, len(frame)):
        if np.isnan(basic_upper_values[index]):
            continue
        prior_close = closes[index - 1]
        upper[index] = basic_upper_values[index] if basic_upper_values[index] < upper[index - 1] or prior_close > upper[index - 1] else upper[index - 1]
        lower[index] = basic_lower_values[index] if basic_lower_values[index] > lower[index - 1] or prior_close < lower[index - 1] else lower[index - 1]
        previous_direction = direction[index - 1]
        if previous_direction == 1 and closes[index] < lower[index]:
            direction[index] = -1
        elif previous_direction == -1 and closes[index] > upper[index]:
            direction[index] = 1
        else:
            direction[index] = previous_direction
        line[index] = lower[index] if direction[index] == 1 else upper[index]
    return pd.Series(line, index=frame.index), pd.Series(direction, index=frame.index)


def indicator_series(frame: pd.DataFrame, name: str, period: int = 14, multiplier: float = 3.0) -> pd.Series:
    """Calculate one supported indicator with stable defaults."""
    name = str(name).upper()
    if name not in SUPPORTED_INDICATORS:
        raise ValueError(f"Unsupported indicator: {name}")
    period = _positive_period(period)
    close, high, low, volume = frame["Close"], frame["High"], frame["Low"], frame["Volume"]
    if name in {"CLOSE", "OPEN", "HIGH", "LOW", "VOLUME"}:
        return frame[name.title()].astype(float)
    if name == "HL2": return (high + low) / 2
    if name == "HLC3": return (high + low + close) / 3
    if name == "OHLC4": return (frame["Open"] + high + low + close) / 4
    if name == "SMA": return close.rolling(period, min_periods=period).mean()
    if name == "EMA": return close.ewm(span=period, adjust=False, min_periods=period).mean()
    if name == "WMA":
        weights = np.arange(1, period + 1, dtype=float)
        return close.rolling(period, min_periods=period).apply(lambda values: float(np.dot(values, weights) / weights.sum()), raw=True)
    if name == "VOLUME_SMA": return volume.rolling(period, min_periods=period).mean()
    if name == "RSI":
        delta = close.diff()
        gains, losses = delta.clip(lower=0), -delta.clip(upper=0)
        average_gain = wilder_average(gains, period)
        average_loss = wilder_average(losses, period)
        relative = average_gain / average_loss.replace(0, np.nan)
        result = 100 - 100 / (1 + relative)
        result = result.where(average_loss != 0, 100.0)
        return result.where(~((average_gain == 0) & (average_loss == 0)), 50.0)
    if name in {"MACD", "MACD_SIGNAL", "MACD_HIST"}:
        # ``period`` is the slow span.  Scale the conventional 12/26/9
        # relationship so the generic indicator builder's period control is
        # real; period=26 remains the standard MACD exactly.
        slow_period = max(3, period)
        fast_period = max(2, round(slow_period * 12 / 26))
        signal_period = max(2, round(slow_period * 9 / 26))
        fast_period = min(fast_period, slow_period - 1)
        fast = close.ewm(span=fast_period, adjust=False, min_periods=fast_period).mean()
        slow = close.ewm(span=slow_period, adjust=False, min_periods=slow_period).mean()
        macd = fast - slow
        signal = macd.ewm(span=signal_period, adjust=False, min_periods=signal_period).mean()
        return macd if name == "MACD" else signal if name == "MACD_SIGNAL" else macd - signal
    if name in {"STOCH_K", "STOCH_D", "WILLIAMS_R"}:
        rolling_low, rolling_high = low.rolling(period, min_periods=period).min(), high.rolling(period, min_periods=period).max()
        span = (rolling_high - rolling_low).replace(0, np.nan)
        k = 100 * (close - rolling_low) / span
        if name == "STOCH_K": return k
        if name == "STOCH_D": return k.rolling(3, min_periods=3).mean()
        return -100 * (rolling_high - close) / span
    typical = (high + low + close) / 3
    if name == "CCI":
        mean = typical.rolling(period, min_periods=period).mean()
        deviation = typical.rolling(period, min_periods=period).apply(lambda values: float(np.mean(np.abs(values - values.mean()))), raw=True)
        return (typical - mean) / (0.015 * deviation.replace(0, np.nan))
    if name == "MFI":
        flow = typical * volume
        positive = flow.where(typical.diff() > 0, 0.0).rolling(period, min_periods=period).sum()
        negative = flow.where(typical.diff() < 0, 0.0).rolling(period, min_periods=period).sum()
        ratio = positive / negative.replace(0, np.nan)
        result = (100 - 100 / (1 + ratio)).where(negative != 0, 100.0)
        return result.where(~((positive == 0) & (negative == 0)), 50.0)
    if name == "ROC": return close.pct_change(period, fill_method=None) * 100
    if name == "OBV":
        signed = np.sign(close.diff()).fillna(0) * volume
        return signed.cumsum()
    if name in {"ADX", "PLUS_DI", "MINUS_DI", "ATR"}:
        atr, plus_di, minus_di, adx = directional_series(frame, period)
        return {"ATR": atr, "PLUS_DI": plus_di, "MINUS_DI": minus_di, "ADX": adx}[name]
    if name in {"SUPERTREND", "SUPERTREND_DIRECTION"}:
        line, direction = supertrend(frame, period, multiplier)
        return line if name == "SUPERTREND" else direction
    if name.startswith("BB_"):
        middle = close.rolling(period, min_periods=period).mean()
        deviation = close.rolling(period, min_periods=period).std(ddof=0)
        upper, lower = middle + 2 * deviation, middle - 2 * deviation
        return {"BB_UPPER": upper, "BB_MIDDLE": middle, "BB_LOWER": lower,
                "BB_PCTB": (close - lower) / (upper - lower).replace(0, np.nan) * 100,
                "BB_WIDTH": (upper - lower) / middle.replace(0, np.nan) * 100}[name]
    if name == "DONCHIAN_UPPER": return high.rolling(period, min_periods=period).max()
    if name == "DONCHIAN_LOWER": return low.rolling(period, min_periods=period).min()
    raise AssertionError(name)
