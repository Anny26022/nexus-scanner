"""MBI ratios, colour scoring, and the publicly disclosed XP proxy."""

import math

from .aggregates import percentage, percentage_change, scaled_ratio


def _cell(value, green_above, red_below):
    if value is None:
        return "neutral"
    if value > green_above:
        return "green"
    if value < red_below:
        return "red"
    return "neutral"


def _change_cell(value):
    return _cell(value, 20.0, -20.0)


def _nnh_cell(highs, lows):
    if highs > lows:
        return "green"
    if highs < lows:
        return "red"
    return "neutral"


def _safe_log_positive(value, methodology):
    return math.log(max(float(value), methodology.xp_positive_epsilon))


def _safe_log_odds(percentage_value, methodology):
    epsilon = methodology.xp_percentage_epsilon
    bounded = min(max(float(percentage_value), epsilon), 100.0 - epsilon)
    return math.log(bounded / (100.0 - bounded))


def enrich_records(records, methodology, index_closes=None, output_sessions=None):
    """Decorate output rows, always replaying full historical XP/rolling state."""
    index_closes = index_closes or {}
    ma_prefix = methodology.default_ma_type.lower()
    previous = None
    previous_index_close = None
    previous_xp = methodology.xp_initial
    previous_z = None
    rolling_advances = []
    rolling_declines = []
    output = []

    first_output = max(0, len(records) - output_sessions) if output_sessions else 0
    for position, raw in enumerate(records):
        row = dict(raw)
        emit = position >= first_output
        # Changes on the first output row need the immediately preceding ratios.
        needs_ratios = emit or position == first_output - 1
        return_denominator = row["valid_return"]
        if emit:
            row["up_4_pct"] = percentage(row["up_4"], return_denominator)
            row["down_4_pct"] = percentage(row["down_4"], return_denominator)
            row["up_4_5_pct"] = percentage(row["up_4_5"], return_denominator)
            row["down_4_5_pct"] = percentage(row["down_4_5"], return_denominator)
            row["net_4_pct"] = (
                row["up_4_pct"] - row["down_4_pct"]
                if row["up_4_pct"] is not None and row["down_4_pct"] is not None
                else None
            )
        if needs_ratios:
            row["ratio_4"] = scaled_ratio(row["up_4"], row["down_4"])
            row["ratio_4_5"] = scaled_ratio(row["up_4_5"], row["down_4_5"])

        for period in methodology.ma_periods:
            above = row[f"above_{ma_prefix}_{period}"]
            valid = row[f"valid_{ma_prefix}_{period}"]
            not_above = max(valid - above, 0)
            # A missing MA population remains unavailable in the published record.
            # XP handles its own neutral fallback below; it must not redefine the
            # public percentage as zero.
            if emit or period in (10, 20):
                row[f"above_{period}_pct"] = percentage(above, valid)
            if emit or (needs_ratios and period in (20, 50)):
                row[f"ratio_{period}"] = scaled_ratio(above, not_above)

        if position < first_output:
            # Retain every input to the first published row and the XP recurrence.
            rolling_advances.append(row["advances"])
            rolling_declines.append(row["declines"])
            index_close = index_closes.get(row["date"])
            if index_close is not None:
                previous_index_close = index_close
        else:
            row["change_4"] = percentage_change(
                row["ratio_4"],
                previous["ratio_4"] if previous else None,
            )
            row["change_4_5"] = percentage_change(
                row["ratio_4_5"],
                previous["ratio_4_5"] if previous else None,
            )
            row["change_20"] = percentage_change(
                row["ratio_20"],
                previous["ratio_20"] if previous else None,
            )
            row["change_50"] = percentage_change(
                row["ratio_50"],
                previous["ratio_50"] if previous else None,
            )

            row["monthly_nnh"] = row["new_monthly_high"] - row["new_monthly_low"]
            row["quarterly_nnh"] = row["new_quarterly_high"] - row["new_quarterly_low"]
            row["nnh_52w"] = row["new_52w_high"] - row["new_52w_low"]
            row["new_monthly_high_pct"] = percentage(
                row["new_monthly_high"], row["valid_monthly_extrema"]
            )
            row["new_monthly_low_pct"] = percentage(
                row["new_monthly_low"], row["valid_monthly_extrema"]
            )
            row["new_quarterly_high_pct"] = percentage(
                row["new_quarterly_high"], row["valid_quarterly_extrema"]
            )
            row["new_quarterly_low_pct"] = percentage(
                row["new_quarterly_low"], row["valid_quarterly_extrema"]
            )
            row["new_52w_high_pct"] = percentage(
                row["new_52w_high"], row["valid_yearly_extrema"]
            )
            row["new_52w_low_pct"] = percentage(
                row["new_52w_low"], row["valid_yearly_extrema"]
            )

            rolling_advances.append(row["advances"])
            rolling_declines.append(row["declines"])
            for window in (5, 10):
                advances = sum(rolling_advances[-window:])
                declines = sum(rolling_declines[-window:])
                row[f"advance_decline_ratio_{window}d"] = (
                    advances / declines if declines > 0 else None
                )

            index_close = index_closes.get(row["date"])
            row["net_breadth"] = row["advances"] - row["declines"]
            row["volume_ratio_20"] = scaled_ratio(row["volume_above_20"], row["volume_below_or_equal_20"])
            row["advance_volume_ratio"] = scaled_ratio(row.get("advance_volume", 0), row.get("decline_volume", 0))
            row["breakout_ratio_20d"] = scaled_ratio(row.get("breakout_20d", 0), row.get("breakdown_20d", 0))
            row["breakout_20d_pct"] = percentage(row.get("breakout_20d", 0), row.get("valid_breakout_20", 0))
            row["breakdown_20d_pct"] = percentage(row.get("breakdown_20d", 0), row.get("valid_breakout_20", 0))
            row["upper_half_52w_pct"] = percentage(row.get("upper_half_52w", 0), row.get("valid_yearly_range", 0))
            row["lower_half_52w_pct"] = percentage(row.get("lower_half_52w", 0), row.get("valid_yearly_range", 0))

            row["index_close"] = index_close
            row["index_change_pct"] = (
                percentage_change(index_close, previous_index_close)
                if index_close is not None
                else None
            )
            if index_close is not None:
                previous_index_close = index_close

            cells = {
                "ratio_4_5": _cell(row["ratio_4_5"], 200.0, 50.0),
                "change_4_5": _change_cell(row["change_4_5"]),
                "ratio_20": _cell(row["ratio_20"], 75.0, 50.0),
                "change_20": _change_cell(row["change_20"]),
                "ratio_50": _cell(row["ratio_50"], 85.0, 60.0),
                "change_50": _change_cell(row["change_50"]),
                "nnh_52w": _nnh_cell(row["new_52w_high"], row["new_52w_low"]),
            }
            green_count = sum(value == "green" for value in cells.values())
            red_count = sum(value == "red" for value in cells.values())
            score = green_count - red_count
            state = "green" if score >= 3 else "red" if score <= -3 else "neutral"
            row["mbi_cells"] = cells
            row["mbi_green_count"] = green_count
            row["mbi_red_count"] = red_count
            row["mbi_score"] = score
            row["mbi_state"] = state
            row["warning_day"] = red_count >= 3 and state != "red"

        # XP's historical formula treats insufficient MA coverage as neutral,
        # while the published breadth fields remain unavailable (None).
        p10 = row["above_10_pct"] if row["above_10_pct"] is not None else 0.0
        p20 = row["above_20_pct"] if row["above_20_pct"] is not None else 0.0
        up_4_5_count = row["up_4_5"]
        down_4_5_count = row["down_4_5"]
        current_z = None
        if up_4_5_count is not None:
            current_z = (
                float(up_4_5_count)
                if previous_z is None
                else 0.162 * up_4_5_count + 0.838 * previous_z
            )
        row["xp_advancer_count"] = up_4_5_count
        row["xp_decliner_count"] = down_4_5_count
        row["em"] = None
        row["xp_smoothed_advances"] = current_z
        if current_z is not None:
            previous_z = current_z
        if current_z is None or down_4_5_count is None:
            row["xp_raw"] = None
            row["xp"] = None
        else:
            log_xp = (
                0.592 * math.log(previous_xp)
                + 0.471 * _safe_log_positive(current_z, methodology)
                + 0.198 * _safe_log_odds(p10, methodology)
                + 0.334
                - 0.067 * _safe_log_positive(down_4_5_count, methodology)
                - 0.077 * _safe_log_odds(p20, methodology)
            )
            current_xp = math.exp(log_xp)
            row["xp_raw"] = current_xp
            row["xp"] = current_xp * methodology.xp_output_multiplier
            previous_xp = current_xp

        if position >= first_output:
            output.append(row)
        previous = row

    return output
