"""Public numeric fields available to the Market Breadth scanner gate."""
from .aggregates import scaled_ratio

def gate_metrics(row):
    """Return stable scanner names without exposing methodology internals."""
    result = dict(row)
    result.update({
        "net_breadth": row.get("advances", 0) - row.get("declines", 0),
        "thrust_4_ratio": scaled_ratio(row.get("up_4", 0), row.get("down_4", 0)),
        "thrust_4_5_ratio": scaled_ratio(row.get("up_4_5", 0), row.get("down_4_5", 0)),
        "volume_ratio_20": row.get("volume_ratio_20") or scaled_ratio(row.get("volume_above_20", 0), row.get("volume_below_or_equal_20", 0)),
        "warning_day": 1 if row.get("warning_day") else 0,
    })
    for period in (10, 20, 50, 200):
        result[f"pct_above_sma{period}"] = row.get(f"above_{period}_pct")
        result[f"ad_ratio_sma{period}"] = row.get(f"ratio_{period}")
        for kind in ("above", "below", "equal", "valid"):
            result[f"{kind}_sma{period}"] = row.get(f"{kind}_sma_{period}")
            result[f"{kind}_ema{period}"] = row.get(f"{kind}_ema_{period}")
    return result
