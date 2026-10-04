"""Public numeric fields available to the Market Breadth scanner gate."""

import math

from .aggregates import percentage, scaled_ratio

# This is the public scanner contract.  Keep implementation intermediates out of
# gate payloads even when they are numeric, so `--list-conditions` and the UI
# can describe every selectable metric precisely.
MARKET_BREADTH_METRICS = (
    "advances", "declines", "unchanged", "net_breadth",
    "up_4", "down_4", "up_4_5", "down_4_5",
    "thrust_4_ratio", "thrust_4_5_ratio",
    "advance_decline_ratio_5d", "advance_decline_ratio_10d",
    "new_monthly_high", "new_monthly_low",
    "new_quarterly_high", "new_quarterly_low",
    "new_52w_high", "new_52w_low", "new_52w_high_pct", "new_52w_low_pct",
    "up_25_month", "down_25_month", "up_13_34d", "down_13_34d",
    "up_25_quarter", "down_25_quarter",
    "volume_above_20", "volume_ratio_20", "advance_volume", "decline_volume", "total_volume",
    "breakout_20d", "breakdown_20d", "upper_half_52w", "lower_half_52w",
    "mbi_score", "warning_day", "xp", "index_change_pct",
    "pct_above_sma10", "pct_above_sma20", "pct_above_sma50", "pct_above_sma200",
    "ad_ratio_sma10", "ad_ratio_sma20", "ad_ratio_sma50", "ad_ratio_sma200",
)


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def gate_metrics(row):
    """Return stable scanner metrics with nulls kept unavailable, not coerced."""
    result = {
        key: row[key]
        for key in MARKET_BREADTH_METRICS
        if key in row and _finite_number(row[key])
    }
    result.update({
        "net_breadth": row.get("advances", 0) - row.get("declines", 0),
        "thrust_4_ratio": scaled_ratio(row.get("up_4", 0), row.get("down_4", 0)),
        "thrust_4_5_ratio": scaled_ratio(row.get("up_4_5", 0), row.get("down_4_5", 0)),
        "volume_ratio_20": row.get("volume_ratio_20") or scaled_ratio(
            row.get("volume_above_20", 0), row.get("volume_below_or_equal_20", 0)
        ),
        "warning_day": 1 if row.get("warning_day") else 0,
    })
    # The gate names promise SMA semantics. Derive them from raw SMA counts,
    # irrespective of the methodology's display/default MA type.
    for period in (10, 20, 50, 200):
        above = row.get(f"above_sma_{period}", 0)
        valid = row.get(f"valid_sma_{period}", 0)
        result[f"pct_above_sma{period}"] = percentage(above, valid)
        result[f"ad_ratio_sma{period}"] = scaled_ratio(above, max(valid - above, 0))
    return {key: value for key, value in result.items() if value is not None and _finite_number(value)}
