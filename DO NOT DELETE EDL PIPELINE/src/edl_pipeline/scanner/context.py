"""Artifact-aware screener rules and legacy request normalization."""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

import numpy as np
import pandas as pd

from .financials import financial_value
from ..breadth.gates import MARKET_BREADTH_METRICS


CONTEXT_CONDITION_REGISTRY = {
    "relative_strength": {"inputs": {"benchmark": "string", "window": "integer", "comparison": "comparison", "value": "number"}, "definition": "Stock return less benchmark return over the same sessions, in percentage points."},
    "rs_new_high": {"inputs": {"benchmark": "string", "lookback_days": "integer", "minimum_price_below_high_percent": "number"}, "definition": "Relative-strength line is at its lookback high while price remains below its own high."},
    "rs_rating": {"inputs": {"window": "one_month | three_month | six_month | twelve_month | front_weighted", "comparison": "comparison", "value": "number"}, "definition": "Cross-sectional 1–99 Nifty 500 relative-strength percentile for a 21/63/126/252-session horizon, or its 40/20/20/20 front-weighted composite."},
    "market_cap": {"inputs": {"comparison": "comparison", "value_crore": "number"}, "definition": "Current full market capitalisation in crore."},
    "free_float_market_cap": {"inputs": {"comparison": "comparison", "value_crore": "number"}, "definition": "Current market capitalisation multiplied by free-float percentage."},
    "pe_ratio": {"inputs": {"comparison": "comparison", "value": "number"}, "definition": "Current positive trailing P/E."},
    "earnings_growth": {"inputs": {"metric": "net_profit|revenue|pbt|eps|opm", "basis": "qoq|yoy", "comparison": "comparison", "value": "number", "maximum_filing_age_days": "integer"}, "definition": "Reported quarterly line-item growth, subject to filing age. OPM compares reported operating-margin percentages."},
    "fundamental_metric": {"inputs": {"metric": "roe|roce|opm_ttm|debt_to_equity|peg_ratio|sales_growth_5y|total_revenue_in_lakhs|non_current_assets_in_lakhs|total_liabilities_in_lakhs|interest_coverage|dividend_per_share_latest|vwap|all_time_high|all_time_low|return_5y", "comparison": "comparison", "value": "number"}, "definition": "Current published fundamental metric aligned to the screen session."},
    "eps_last_year_higher": {"inputs": {}, "definition": "Latest annual EPS is greater than the preceding annual EPS in the current published fundamentals."},
    "days_since_earnings": {"inputs": {"comparison": "comparison", "days": "integer"}, "definition": "Trading sessions since the latest reported earnings date."},
    "sector": {"inputs": {"values": "string[]"}, "definition": "NSE sector membership."},
    "industry": {"inputs": {"values": "string[]"}, "definition": "NSE industry membership."},
    "average_turnover": {"inputs": {"comparison": "comparison", "lookback_days": "integer", "value_crore": "number", "window_minutes": "daily|1|3|5"}, "definition": "Average daily traded value; intraday modes require intraday turnover history."},
    "adr_percent": {"inputs": {"comparison": "comparison", "lookback_days": "integer", "value": "number"}, "definition": "Mean daily high-low percentage range."},
    "percent_from_ath": {"inputs": {"comparison": "comparison", "value": "number"}, "definition": "Percentage distance below the split- and bonus-adjusted all-time high from the EOD2 daily history."},
    "price_range": {"inputs": {"minimum_price": "number", "maximum_price": "number"}, "definition": "Latest close lies within an inclusive price band."},
    "price_band": {"inputs": {"values": "string[]"}, "definition": "Current NSE regulatory price-band value."},
    "circuit_band_minimum": {"inputs": {"minimum_band_percent": "number"}, "definition": "Current circuit/price band is at least the specified percentage."},
    "series": {"inputs": {"values": "string[]"}, "definition": "NSE listing series."},
    "listing_age_days": {"inputs": {"comparison": "comparison", "days": "integer"}, "definition": "Trading sessions since NSE listing date."},
    "index_membership": {"inputs": {"index_name": "string"}, "definition": "Current canonical index membership."},
    "market_breadth": {"inputs": {"universe": "all_active|nifty50|nifty500|niftymidsmall400", "metric": "|".join(MARKET_BREADTH_METRICS), "comparison": "comparison", "value": "number"}, "definition": "Date-aligned published breadth metric for a named universe."},
    "fno_ban": {"inputs": {"mode": "exclude|only"}, "definition": "Current official NSE F&O security-ban report."},
    "exclude_surveillance": {"inputs": {}, "definition": "Excludes stocks in the latest ASM or GSM surveillance lists. Both lists must be available for the screen session."},
    "absolute_volume": {"inputs": {"comparison": "comparison", "value": "number"}, "definition": "Latest session traded volume in shares."},
    "absolute_eps": {"inputs": {"comparison": "comparison", "value": "number"}, "definition": "Published trailing EPS, aligned to the screen session."},
    "dividend_yield": {"inputs": {"comparison": "comparison", "value": "number"}, "definition": "Published dividend yield percentage, aligned to the screen session."},
}

KIND_ALIASES = {
    "PERSISTENT_MOMENTUM": "persistent_momentum", "INDICATOR_COMPARE": "indicator_compare", "MA_CONVERGENCE": "ma_convergence", "DIVERGENCE": "divergence", "SUPERTREND": "supertrend", "PRICE_VS_EMA": "price_vs_ema", "EMA_SHAKEOUT": "ema_shakeout_reclaim", "ADX": "adx", "PRICE_VS_SMA": "price_vs_sma", "PCT_DAYS_ABOVE_MA": "percent_days_above_ma", "MA_STACK": "ma_stack", "MA_SLOPE": "ma_slope", "PRICE_CHANGE_PCT": "price_change_percent", "CONSECUTIVE_UP_DAYS": "consecutive_up_days", "GAP_UP": "gap_up", "GAP_DOWN": "gap_down", "VOLUME_VS_AVG": "relative_volume", "AVG_VOLUME_RATIO": "volume_trend", "HIGHEST_VOLUME_IN_N_DAYS": "highest_volume", "DELIVERY_PCT_SPIKE": "delivery_percent_spike", "DELIVERY_PERCENT": "delivery_percent", "ABSOLUTE_VOLUME": "absolute_volume", "ABSOLUTE_EPS": "absolute_eps", "DIVIDEND_YIELD": "dividend_yield", "NEW_HIGH": "new_high", "NEW_LOW": "new_low", "PCT_FROM_52W_HIGH": "percent_from_52w_high", "PCT_FROM_52W_LOW": "percent_from_52w_low", "PCT_FROM_ATH": "percent_from_ath", "CONSOLIDATION_RANGE": "consolidation_range", "ATR_PCT": "atr_percent", "RANGE_CONTRACTION": "range_contraction", "INSIDE_BAR": "inside_bar", "UNFILLED_GAP": "unfilled_gap", "VCP_LEGS": "vcp_contraction_legs", "HORIZONTAL_RESISTANCE_LINE": "horizontal_resistance_line", "RELATIVE_STRENGTH": "relative_strength", "RS_NEW_HIGH": "rs_new_high", "RS_RATING": "rs_rating", "MARKETCAP": "market_cap", "FF_MARKETCAP": "free_float_market_cap", "PE_RATIO": "pe_ratio", "EARNINGS_GROWTH": "earnings_growth", "FUNDAMENTAL_METRIC": "fundamental_metric", "EPS_LAST_YEAR_HIGHER": "eps_last_year_higher", "DAYS_SINCE_EARNINGS": "days_since_earnings", "SECTOR": "sector", "INDUSTRY": "industry", "AVG_TURNOVER": "average_turnover", "ADR_PCT": "adr_percent", "PRICE_RANGE": "price_range", "PRICE_BAND": "price_band", "CIRCUIT_BAND_MIN": "circuit_band_minimum", "SERIES": "series", "LISTING_AGE_DAYS": "listing_age_days", "INDEX_MEMBERSHIP": "index_membership", "MARKET_BREADTH": "market_breadth", "FNO_BAN": "fno_ban", "EXCLUDE_SURVEILLANCE": "exclude_surveillance",
}

COMPARISON_ALIASES = {"ABOVE": "greater_or_equal", "BELOW": "less_or_equal", "GREATER": "greater", "LESS": "less", "EQUAL": "equal"}


def normalize_condition_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """Translate legacy client request keys without changing native callers."""
    spec = dict(raw)
    kind = spec.get("condition") or spec.get("id") or spec.get("kind")
    legacy_kind = str(spec.get("kind") or spec.get("id") or "").upper()
    condition = KIND_ALIASES.get(str(kind), str(kind).lower())
    params = dict(spec.pop("params", {}) or {})
    spec.update(params)
    spec["condition"] = condition
    spec.pop("id", None); spec.pop("kind", None)
    aliases = {
        "overDays": "window", "withinDays": "fired_within", "persistDays": "persist_days", "avgDays": "average_window", "minDays": "minimum_up_days", "positiveClose": "closed_up", "minDeliverablePct": "minimum_delivery_percent", "lookbackDays": "lookback_days", "maxRangePct": "max_range_percent", "excludeLatest": "exclude_latest", "recentDays": "recent_days", "priorDays": "prior_days", "maxRatio": "max_ratio", "priorMode": "prior_mode", "minGapPct": "minimum_gap_percent", "minLegs": "minimum_legs", "maxFinalLegPct": "max_final_leg_percent", "maxLegRatio": "max_leg_ratio", "minSwingPct": "minimum_swing_percent", "clusterTolerancePct": "cluster_tolerance_percent", "minBaseLengthDays": "minimum_base_length_days", "maxBaseLengthDays": "maximum_base_length_days", "minBaseDepthPct": "minimum_base_depth_percent", "maxBaseDepthPct": "maximum_base_depth_percent", "maxPctBelowLine": "maximum_percent_below_line", "maxPctBelow20Ema": "maximum_percent_below_20ema", "valueCr": "value_crore", "maxAgeDays": "maximum_filing_age_days", "windowMinutes": "window_minutes", "minPrice": "minimum_price", "maxPrice": "maximum_price", "minBandPct": "minimum_band_percent", "minPriceBelowHighPct": "minimum_price_below_high_percent", "indexName": "index_name", "ema10Days": "ema10_days", "ema20Days": "ema20_days", "ema50Days": "ema50_days", "maType": "ma_type", "priceAbove": "price_above_fastest", "minChangePct": "value", "pct": "value", "reportType": "report_type", "leftIndicator": "left_indicator", "leftPeriod": "left_period", "leftOffset": "left_offset", "rightIndicator": "right_indicator", "rightValue": "right_value", "rightPeriod": "right_period", "rightOffset": "right_offset", "maxSpreadPct": "max_spread_percent", "oscPeriod": "oscillator_period", "maxBarDifference": "max_bar_difference", "pivotLeft": "pivot_left", "pivotRight": "pivot_right", "invalidateOnBreak": "invalidate_on_break", "weeklyMode": "weekly_mode",
    }
    for source, destination in aliases.items():
        if source in spec and destination not in spec:
            spec[destination] = spec[source]
    if condition == "persistent_momentum" and "periods" not in spec:
        spec["periods"] = [10, 20, 50]
        spec["persist_days"] = {10: int(spec.get("ema10_days", 20)), 20: int(spec.get("ema20_days", 30)), 50: int(spec.get("ema50_days", 50))}
    if condition == "ema_shakeout_reclaim" and "dip_within" not in spec:
        spec["dip_within"] = spec.get("fired_within")
    if condition in {"price_vs_ema", "price_vs_sma"}:
        comparison = str(spec.get("comparison", "ABOVE")).lower()
        spec["comparison"] = "above" if comparison in {"above", "greater", "greater_or_equal"} else "below"
    elif "comparison" in spec:
        spec["comparison"] = COMPARISON_ALIASES.get(str(spec["comparison"]).upper(), str(spec["comparison"]).lower())
    if condition == "price_change_percent" and legacy_kind == "PRICE_CHANGE_PCT" and str(params.get("comparison", "")).upper() == "BELOW":
        # The legacy Price Change UI defines “Below 20%” as a fall of at
        # least 20%, not an ordinary return less than +20%.
        spec["value"] = -abs(float(spec["value"]))
    for key in ("direction", "state", "timeframe", "prior_mode", "ma_type", "basis", "metric", "mode", "universe"):
        if key in spec and isinstance(spec[key], str):
            spec[key] = spec[key].lower()
    if condition == "relative_volume" and "multiple" not in spec:
        spec["multiple"] = spec.get("value", 1)
    if condition == "volume_trend":
        spec.setdefault("recent_window", spec.get("recent_days", spec.get("recentDays")))
        spec.setdefault("base_window", spec.get("baseDays"))
        spec.setdefault("value", spec.get("ratio"))
    if condition == "highest_volume":
        spec.setdefault("lookback", spec.get("lookback_days"))
    if condition == "atr_percent":
        spec.setdefault("value", spec.get("pct"))
    metric_aliases = {
        "pctabovesma10": "pct_above_sma10", "pctabovesma20": "pct_above_sma20",
        "pctabovesma50": "pct_above_sma50", "pctabovesma200": "pct_above_sma200",
        "adratiosma10": "ad_ratio_sma10", "volratio20": "volume_ratio_20", "volume_ratio20": "volume_ratio_20",
    }
    if condition == "market_breadth":
        spec["metric"] = metric_aliases.get(spec.get("metric"), spec.get("metric"))
    return spec


def _value(stock, key):
    value = (stock or {}).get(key)
    return value if value not in {None, "", "N/A"} else None


def _float(stock, key):
    value = _value(stock, key)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _aligned_relative_strength(frame, benchmark):
    if benchmark is None or benchmark.empty:
        return None
    # Pipeline index artifacts retain raw ``date``/``close`` alongside their
    # parsed ``Date`` column. Selecting explicitly avoids a duplicate Date
    # label when a raw artifact is used as a benchmark.
    date_column = "Date" if "Date" in benchmark.columns else "date"
    close_column = "close" if "close" in benchmark.columns else "Close"
    if date_column not in benchmark.columns or close_column not in benchmark.columns:
        return None
    index = pd.DataFrame({
        "Date": pd.to_datetime(benchmark[date_column], errors="coerce"),
        "benchmark_close": pd.to_numeric(benchmark[close_column], errors="coerce"),
    }).dropna(subset=("Date", "benchmark_close"))
    merged = frame[["Date", "Close"]].merge(index, on="Date", how="inner")
    merged = merged.loc[(merged["Close"] > 0) & (merged["benchmark_close"] > 0)].copy()
    if merged.empty:
        return None
    merged["rs"] = merged["Close"] / merged["benchmark_close"]
    return merged


def _stock_snapshot_is_aligned(stock, as_of_date):
    """Whether point-in-time-only stock metadata belongs to this screen date."""
    snapshot_date = pd.to_datetime(_value(stock, "as_of_date"), errors="coerce")
    return as_of_date is not None and not pd.isna(snapshot_date) and snapshot_date.date() == as_of_date


def _published_field_value(frame, stock, field, as_of_date):
    """Read a query field without silently using a future financial snapshot."""
    field = str(field).lower()
    latest = {
        "close": "Close", "open": "Open", "high": "High", "low": "Low",
    }
    def latest_number(column):
        value = float(frame[column].iloc[-1])
        return (value, None) if np.isfinite(value) else (None, "snapshot_value_unavailable")

    if field in latest:
        return latest_number(latest[field])
    if field == "volume_lakh":
        value = float(frame["Volume"].iloc[-1] / 100_000)
        return (value, None) if np.isfinite(value) else (None, "snapshot_value_unavailable")
    if field == "volume":
        return latest_number("Volume")
    if field in {"sma_20", "sma_50", "sma_200"}:
        period = int(field.rsplit("_", 1)[1])
        if len(frame) < period:
            return None, "insufficient_history"
        return float(frame["Close"].tail(period).mean()), None
    if field in {"high_52w", "low_52w"}:
        if len(frame) < 252:
            return None, "insufficient_history"
        column = "High" if field == "high_52w" else "Low"
        return float(frame[column].tail(252).max() if field == "high_52w" else frame[column].tail(252).min()), None
    periods = {"return_1m": 21, "return_1y": 252, "return_3y": 756, "return_5y": 1260}
    if field in periods:
        period = periods[field]
        if len(frame) <= period:
            return None, "insufficient_history"
        return float((frame["Close"].iloc[-1] / frame["Close"].iloc[-1 - period] - 1) * 100), None
    if field == "return_ytd":
        year_start = pd.Timestamp(as_of_date.year, 1, 1)
        prior = frame.loc[frame["Date"] < year_start, "Close"]
        if prior.empty:
            return None, "insufficient_history"
        return float((frame["Close"].iloc[-1] / prior.iloc[-1] - 1) * 100), None
    if field in {"daily_volatility", "annualized_volatility"}:
        if len(frame) < 14:
            return None, "insufficient_history"
        adr = float(((frame["High"] - frame["Low"]) / frame["Close"] * 100).tail(14).mean())
        # This deliberately matches the public query screen's documented
        # ADR approximation, not a claim of exchange-calculated volatility.
        return (adr * np.sqrt(250) if field == "annualized_volatility" else adr), None
    if field == "market_cap_crore":
        cap, close = _float(stock, "market_cap_crore"), _float(stock, "close")
        if cap is None or close in (None, 0):
            return None, "snapshot_value_unavailable"
        return float(cap * frame["Close"].iloc[-1] / close), None
    if not _stock_snapshot_is_aligned(stock, as_of_date):
        return None, "snapshot_not_aligned_to_screen_date"
    if field == "vwap" and stock.get("vwap_as_of_date") != as_of_date.isoformat():
        return None, "vwap_not_aligned_to_screen_date"
    value = _float(stock, field)
    return (value, None) if value is not None else (None, "snapshot_value_unavailable")


def evaluate_context_condition(frame, spec, context, result: Callable[..., Any], unavailable: Callable[..., Any], comparison: Callable[[float, str, float], bool]):
    """Evaluate non-OHLCV-only rules; return ``None`` when not applicable."""
    condition = spec["condition"]
    # ``field_comparison`` belongs to the local text-query compiler, not the
    # published condition registry. Keeping it out of that registry
    # lets the checked-in public-contract fixture remain exact.
    if condition not in CONTEXT_CONDITION_REGISTRY and condition != "field_comparison":
        return None
    context = context or {}
    stock = context.get("stock") or {}
    requested_date = context.get("screen_date")
    as_of_date = date.fromisoformat(requested_date) if isinstance(requested_date, str) else frame["Date"].iloc[-1].date() if not frame.empty else None

    if condition == "field_comparison":
        left, reason = _published_field_value(frame, stock, spec.get("field"), as_of_date)
        if reason:
            return unavailable(condition, reason)
        raw_right = spec.get("value")
        if isinstance(raw_right, dict) and raw_right.get("field"):
            right, reason = _published_field_value(frame, stock, raw_right["field"], as_of_date)
            if reason:
                return unavailable(condition, reason)
        else:
            try:
                right = float(raw_right)
            except (TypeError, ValueError):
                return unavailable(condition, "invalid_comparison_value")
        return result(condition, comparison(left, spec["comparison"], right), round(left, 6), field=spec.get("field"), comparison=spec["comparison"], target=round(right, 6))

    if condition in {"absolute_volume", "absolute_eps", "dividend_yield"}:
        field = {"absolute_volume": "volume", "absolute_eps": "eps_ttm",
                 "dividend_yield": "dividend_yield_percent"}[condition]
        value, reason = _published_field_value(frame, stock, field, as_of_date)
        if reason:
            return unavailable(condition, reason)
        target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6),
                      comparison=spec["comparison"], target=target,
                      unit="shares" if condition == "absolute_volume" else "percent" if condition == "dividend_yield" else "rupees")

    if condition in {"relative_strength", "rs_new_high"}:
        benchmark = (context.get("benchmarks") or {}).get(str(spec.get("benchmark", "NIFTY_50")).upper())
        merged = _aligned_relative_strength(frame, benchmark)
        if merged is None:
            return unavailable(condition, "benchmark_history_unavailable")
        window = int(spec.get("window", spec.get("lookback_days", 60)))
        if len(merged) <= window:
            return unavailable(condition, "insufficient_aligned_history")
        if condition == "relative_strength":
            stock_return = merged["Close"].iloc[-1] / merged["Close"].iloc[-1-window] - 1
            benchmark_return = merged["benchmark_close"].iloc[-1] / merged["benchmark_close"].iloc[-1-window] - 1
            spread = (stock_return - benchmark_return) * 100
            target = float(spec["value"])
            return result(condition, comparison(spread, spec["comparison"], target), round(spread, 6), benchmark=str(spec.get("benchmark", "NIFTY_50")), window=window, comparison=spec["comparison"], target=target)
        rs = merged["rs"].tail(window)
        own_high = frame["High"].tail(window).max()
        below = (own_high - frame["Close"].iloc[-1]) / own_high * 100 if own_high else np.nan
        target = float(spec["minimum_price_below_high_percent"])
        matched = bool(rs.iloc[-1] >= rs.max() and below >= target)
        return result(condition, matched, round(float(rs.iloc[-1]), 8), benchmark=str(spec.get("benchmark", "NIFTY_50")), lookback_days=window, percent_below_own_high=round(float(below), 6), minimum_price_below_high_percent=target)

    if condition == "rs_rating":
        rating_as_of = pd.to_datetime(context.get("rs_ratings_as_of"), errors="coerce")
        if as_of_date is None or pd.isna(rating_as_of) or rating_as_of.date() != as_of_date:
            return unavailable(condition, "rs_rating_not_aligned_to_screen_date")
        window = str(spec.get("window") or "front_weighted").lower()
        rating = _value((context.get("rs_ratings") or {}).get(stock.get("symbol"), {}), window)
        if rating is None:
            return unavailable(condition, "rs_rating_history_unavailable")
        value = float(rating); target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), value, window=window, comparison=spec["comparison"], target=target)

    if condition in {"market_cap", "free_float_market_cap", "pe_ratio"}:
        if condition in {"market_cap", "free_float_market_cap"}:
            current_cap, current_close = _float(stock, "market_cap_crore"), _float(stock, "close")
            # The bundle documents historical market-cap as historical price
            # scaled by today's share count.  Derive that share count from the
            # current cap/close instead of reusing a future cap unchanged.
            cap = current_cap * float(frame["Close"].iloc[-1]) / current_close if current_cap is not None and current_close not in (None, 0) else None
        else:
            cap = None
        if condition == "market_cap": value = cap
        elif condition == "free_float_market_cap":
            free_float = _float(stock, "free_float_percent")
            value = cap * free_float / 100 if cap is not None and free_float is not None else None
        else:
            if "financial_history" in context:
                current_cap, current_close = _float(stock, "market_cap_crore"), _float(stock, "close")
                historical_cap = current_cap * float(frame["Close"].iloc[-1]) / current_close if current_cap is not None and current_close not in (None, 0) else None
                value, details, reason = financial_value(context, stock, spec, as_of_date, historical_cap)
                if reason:
                    return unavailable(condition, reason)
                return result(condition, comparison(value, spec["comparison"], float(spec["value"])), value, **details)
            if not _stock_snapshot_is_aligned(stock, as_of_date):
                return unavailable(condition, "pe_snapshot_not_aligned_to_screen_date")
            value = _float(stock, "pe_ratio")
            if value is not None and value <= 0: value = None
        if value is None:
            return unavailable(condition, "snapshot_value_unavailable")
        target = float(spec.get("value_crore", spec.get("value")))
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6), comparison=spec["comparison"], target=target)

    if condition == "earnings_growth":
        if "financial_history" in context:
            value, details, reason = financial_value(context, stock, spec, as_of_date, _float(stock, "market_cap_crore"))
            if reason:
                return unavailable(condition, reason)
            return result(condition, comparison(value, spec["comparison"], float(spec["value"])), value, **details)
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "earnings_snapshot_not_aligned_to_screen_date")
        metric = str(spec.get("metric", "net_profit")).lower()
        basis = str(spec.get("basis", "yoy")).lower()
        requested_report_type = str(spec.get("report_type", "")).upper()
        actual_report_type = str(_value(stock, "earnings_report_type") or "").upper()
        if requested_report_type in {"CONSOLIDATED", "C"} and actual_report_type not in {"CONSOLIDATED", "C"}:
            return unavailable(condition, "consolidated_earnings_unavailable")
        prefix = {"net_profit": "net_profit", "revenue": "sales", "eps": "eps", "pbt": "pbt"}.get(metric)
        if prefix is None:
            return unavailable(condition, "metric_history_unavailable")
        value = _float(stock, f"{basis}_percent_{prefix}_latest")
        announcement = pd.to_datetime(_value(stock, "latest_earnings_date"), errors="coerce")
        max_age = int(spec.get("maximum_filing_age_days", 200))
        if value is None or pd.isna(announcement) or announcement.date() > as_of_date: return unavailable(condition, "earnings_history_unavailable")
        age = int((as_of_date - announcement.date()).days) if as_of_date else None
        if age is None or age > max_age: return unavailable(condition, "earnings_filing_too_old")
        target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), value, metric=metric, basis=basis, report_type=actual_report_type, filing_age_days=age, maximum_filing_age_days=max_age)

    if condition == "percent_from_ath":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        value = _float(stock, "percent_from_ath")
        if value is None:
            return unavailable(condition, "ath_history_unavailable")
        target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6), comparison=spec["comparison"], target=target)

    if condition == "fundamental_metric":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        field = {
            "roe": "roe_percent", "roce": "roce_percent", "opm_ttm": "operating_margin_ttm_percent",
            "debt_to_equity": "debt_to_equity", "peg_ratio": "peg_ratio", "sales_growth_5y": "sales_growth_5_years_percent",
            "total_revenue_in_lakhs": "total_revenue_in_lakhs", "non_current_assets_in_lakhs": "non_current_assets_in_lakhs", "total_liabilities_in_lakhs": "total_liabilities_in_lakhs", "interest_coverage": "interest_coverage", "dividend_per_share_latest": "dividend_per_share_latest", "vwap": "vwap", "all_time_high": "all_time_high", "all_time_low": "all_time_low", "return_5y": "return_5y",
        }.get(str(spec.get("metric", "")).lower())
        if field is None:
            return unavailable(condition, "unsupported_fundamental_metric")
        if field == "vwap" and stock.get("vwap_as_of_date") != as_of_date.isoformat():
            return unavailable(condition, "vwap_not_aligned_to_screen_date")
        value = _float(stock, field)
        if value is None:
            return unavailable(condition, "fundamental_metric_unavailable")
        target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6), metric=spec["metric"], comparison=spec["comparison"], target=target)

    if condition == "eps_last_year_higher":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        latest, prior = _float(stock, "eps_last_year"), _float(stock, "eps_2_years_back")
        if latest is None or prior is None:
            return unavailable(condition, "annual_eps_history_unavailable")
        return result(condition, latest > prior, latest, eps_last_year=latest, eps_2_years_back=prior)

    if condition == "exclude_surveillance":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        listed_as_of = pd.to_datetime(_value(stock, "surveillance_as_of_date"), errors="coerce")
        if stock.get("surveillance_available") is not True:
            return unavailable(condition, "surveillance_lists_unavailable")
        if as_of_date is None or pd.isna(listed_as_of) or listed_as_of.date() != as_of_date:
            return unavailable(condition, "surveillance_not_aligned_to_screen_date")
        is_asm, is_gsm = bool(stock.get("is_asm")), bool(stock.get("is_gsm"))
        restricted = is_asm or is_gsm
        return result(condition, not restricted, restricted, is_asm=is_asm, asm_stage=_value(stock, "asm_stage"), is_gsm=is_gsm, gsm_stage=_value(stock, "gsm_stage"), surveillance_as_of_date=listed_as_of.date().isoformat(), surveillance_fetched_at=_value(stock, "surveillance_fetched_at"))

    if condition in {"days_since_earnings", "listing_age_days"}:
        if condition == "days_since_earnings" and not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "earnings_snapshot_not_aligned_to_screen_date")
        source = "latest_earnings_date" if condition == "days_since_earnings" else "listing_date"
        marker = pd.to_datetime(_value(stock, source), errors="coerce")
        if pd.isna(marker) or marker.date() > as_of_date: return unavailable(condition, "date_unavailable")
        sessions = int((frame["Date"].dt.date > marker.date()).sum())
        target = float(spec["days"])
        return result(condition, comparison(sessions, spec["comparison"], target), sessions, comparison=spec["comparison"], target=target, source_date=marker.date().isoformat())

    if condition in {"sector", "industry", "price_band", "series"}:
        key = {"sector":"sector", "industry":"industry", "price_band":"circuit_limit", "series":"listing_series"}[condition]
        if condition == "series" and _value(stock, key) is None:
            key = "delivery_series"
        actual, wanted = _value(stock, key), {str(item).upper() for item in spec.get("values", [])}
        if condition == "series":
            dated = {str(row.get("date")): row.get("series") for row in context.get("delivery_history", []) if row.get("date")}
            actual = dated.get(as_of_date.isoformat(), actual) if as_of_date else actual
        elif not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        if condition == "price_band" and str(actual).strip() in {"", "-", "NONE", "N/A"}:
            actual = "No Band"
        if actual is None: return unavailable(condition, "snapshot_value_unavailable")
        matched = str(actual).upper() in wanted if wanted else False
        return result(condition, matched, matched, actual=actual, values=sorted(wanted))

    if condition == "average_turnover":
        if str(spec.get("window_minutes", "daily")) not in {"", "daily"}:
            return unavailable(condition, "intraday_turnover_history_unavailable")
        window = int(spec.get("lookback_days", 20))
        if len(frame) < window: return unavailable(condition, "insufficient_history")
        value = float((frame["Close"] * frame["Volume"]).tail(window).mean() / 10_000_000)
        target = float(spec["value_crore"])
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6), lookback_days=window, comparison=spec["comparison"], target=target)

    if condition == "adr_percent":
        window = int(spec.get("lookback_days", 14))
        if len(frame) < window: return unavailable(condition, "insufficient_history")
        value = float(((frame["High"] - frame["Low"]) / frame["Close"] * 100).tail(window).mean())
        target = float(spec["value"])
        return result(condition, comparison(value, spec["comparison"], target), round(value, 6), lookback_days=window, comparison=spec["comparison"], target=target)

    if condition == "price_range":
        value = float(frame["Close"].iloc[-1]); low, high = float(spec.get("minimum_price", 0)), float(spec.get("maximum_price", float("inf")))
        return result(condition, low <= value <= high, value, minimum_price=low, maximum_price=high)

    if condition == "circuit_band_minimum":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "snapshot_not_aligned_to_screen_date")
        raw = _value(stock, "circuit_limit")
        if raw is None: return unavailable(condition, "snapshot_value_unavailable")
        if str(raw).strip().upper() in {"-", "NO BAND", "NONE"}:
            return result(condition, True, None, minimum_band_percent=float(spec["minimum_band_percent"]), no_band=True)
        try: value = float(str(raw).replace("%", "").strip())
        except ValueError: return unavailable(condition, "invalid_circuit_band")
        target = float(spec["minimum_band_percent"])
        return result(condition, value >= target, value, minimum_band_percent=target)

    if condition == "index_membership":
        if not _stock_snapshot_is_aligned(stock, as_of_date):
            return unavailable(condition, "index_membership_not_aligned_to_screen_date")
        memberships = {str(item).upper() for item in (stock.get("index_memberships") or [])}
        target = str(spec["index_name"]).upper()
        if not memberships: return unavailable(condition, "index_membership_unavailable")
        return result(condition, target in memberships, target in memberships, index_name=spec["index_name"], memberships=sorted(memberships))

    if condition == "market_breadth":
        breadth_as_of = pd.to_datetime(context.get("breadth_as_of"), errors="coerce")
        if as_of_date is None or pd.isna(breadth_as_of) or breadth_as_of.date() != as_of_date:
            return unavailable(condition, "breadth_not_aligned_to_screen_date")
        breadth = (context.get("breadth") or {}).get(str(spec.get("universe", "all_active")).lower())
        if not breadth: return unavailable(condition, "breadth_universe_unavailable")
        metric = str(spec["metric"]).lower()
        value = breadth.get(metric)
        if value is None: return unavailable(condition, "breadth_metric_unavailable")
        target = float(spec["value"])
        return result(condition, comparison(float(value), spec["comparison"], target), float(value), universe=spec.get("universe"), metric=metric, comparison=spec["comparison"], target=target)

    if condition == "fno_ban":
        available = context.get("fno_ban_available", "fno_ban_symbols" in context)
        if not available: return unavailable(condition, "fno_ban_snapshot_unavailable")
        trade_date = pd.to_datetime(context.get("fno_ban_trade_date"), errors="coerce")
        if context.get("fno_ban_trade_date") is not None and (as_of_date is None or pd.isna(trade_date) or trade_date.date() != as_of_date):
            return unavailable(condition, "fno_ban_not_aligned_to_screen_date")
        status = bool((context.get("fno_ban_symbols") or {}).get(str(stock.get("symbol", "")).upper()))
        mode = str(spec.get("mode", "exclude")).lower()
        matched = status if mode == "only" else not status
        return result(condition, matched, status, mode=mode)
    return None
