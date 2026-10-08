"""Cross-sectional aggregation with metric-specific denominators and audit flags."""

from collections import defaultdict
import heapq
import math
import pandas as pd

COUNT_FIELDS = (
    "eligible_with_candle", "valid_return", "advances", "declines", "unchanged",
    "up_4", "down_4", "up_4_5", "down_4_5", "advance_volume", "decline_volume", "total_volume",
    "valid_monthly_extrema", "new_monthly_high", "new_monthly_low",
    "valid_quarterly_extrema", "new_quarterly_high", "new_quarterly_low",
    "valid_yearly_extrema", "new_52w_high", "new_52w_low",
    "valid_volume_20", "volume_above_20", "volume_below_or_equal_20",
    "valid_breakout_20", "breakout_20d", "breakdown_20d",
    "valid_yearly_range", "upper_half_52w", "lower_half_52w",
    "valid_return_21", "up_25_month", "down_25_month", "up_50_month", "down_50_month",
    "valid_return_34", "up_13_34d", "down_13_34d", "valid_return_63", "up_25_quarter", "down_25_quarter",
)
VOLUME_FIELDS = frozenset(('total_volume', 'advance_volume', 'decline_volume'))

def _blank_record(date):
    record = {"date": date, **{field: 0 for field in COUNT_FIELDS}}
    for ma_type in ("sma", "ema"):
        for period in (10, 20, 50, 200):
            for state in ("valid", "above", "below", "equal"):
                record[f"{state}_{ma_type}_{period}"] = 0
    return record

def _present(value):
    return value is not None and not pd.isna(value)

class BreadthAccumulator:
    def __init__(self, methodology, include_contributions=False):
        self.methodology = methodology
        self._records = defaultdict(dict)
        self._contribution_days = []
        self._contributions = defaultdict(lambda: defaultdict(list)) if include_contributions else None

    def _record(self, date):
        if not self._records[date]: self._records[date] = _blank_record(date)
        return self._records[date]

    def _retain_contribution_date(self, day):
        if self._contributions is None or day in self._contributions:
            return
        limit = self.methodology.output_sessions
        if limit and len(self._contribution_days) >= limit:
            if day <= self._contribution_days[0]:
                return
            del self._contributions[heapq.heapreplace(self._contribution_days, day)]
        else:
            heapq.heappush(self._contribution_days, day)
        self._contributions[day]  # Admit only dates in the final output window.

    def _add(self, record, field, symbol):
        record[field] += 1
        if self._contributions is not None and symbol and record["date"] in self._contributions: self._contributions[record["date"]][field].append(symbol)

    def update(self, history, symbol=None, peers=()):
        """Evaluate each candle once for overlapping universes and sectors.

        Apply each increment separately in the original symbol/date order;
        in particular, never regroup or vector-sum floating-point volumes.
        Peers must use the same calculation methodology as this accumulator.
        """
        targets = (self, *peers)
        if len({id(target) for target in targets}) != len(targets):
            raise ValueError('Breadth targets must be distinct')
        if any(target.methodology != self.methodology for target in targets[1:]):
            raise ValueError('Breadth targets must share a methodology')
        for row in history.itertuples(index=False):
            records = [(target, target._record(row.Date)) for target in targets]
            for target, record in records:
                if symbol:
                    target._retain_contribution_date(row.Date)
            fields = []
            add = fields.append
            add("eligible_with_candle")
            daily_return = row.Daily_Return
            if _present(row.Volume):
                add("total_volume")
            if _present(daily_return):
                add("valid_return")
                if daily_return > 0: add("advances")
                elif daily_return < 0: add("declines")
                else: add("unchanged")
                if daily_return >= self.methodology.advance_threshold: add("up_4")
                if daily_return < -self.methodology.advance_threshold: add("down_4")
                if daily_return >= self.methodology.extreme_advance_threshold: add("up_4_5")
                if daily_return < -self.methodology.extreme_advance_threshold: add("down_4_5")
                if _present(row.Volume):
                    if daily_return > 0:
                        add("advance_volume")
                    elif daily_return < 0:
                        add("decline_volume")
            for ma_type in ("SMA", "EMA"):
                for period in self.methodology.ma_periods:
                    value = getattr(row, f"{ma_type}_{period}")
                    if not _present(value): continue
                    prefix = ma_type.lower(); add(f"valid_{prefix}_{period}")
                    if row.Close > value: add(f"above_{prefix}_{period}")
                    elif row.Close < value: add(f"below_{prefix}_{period}")
                    else: add(f"equal_{prefix}_{period}")
            for label, valid, high, low in (("Monthly","valid_monthly_extrema","new_monthly_high","new_monthly_low"),("Quarterly","valid_quarterly_extrema","new_quarterly_high","new_quarterly_low"),("Yearly","valid_yearly_extrema","new_52w_high","new_52w_low")):
                if _present(getattr(row, f"{label}_Reference_High")) and _present(getattr(row, f"{label}_Reference_Low")):
                    add(valid)
                    if getattr(row, f"New_{label}_High"): add(high)
                    if getattr(row, f"New_{label}_Low"): add(low)
            if _present(row.Volume_SMA_20) and _present(row.Volume):
                add("valid_volume_20")
                add("volume_above_20" if row.Volume > row.Volume_SMA_20 else "volume_below_or_equal_20")
            if _present(row.Prior_20_High) and _present(row.Prior_20_Low):
                add("valid_breakout_20")
                if row.Breakout_20d: add("breakout_20d")
                if row.Breakdown_20d: add("breakdown_20d")
            if _present(row.Yearly_Range_High) and _present(row.Yearly_Range_Low) and row.Yearly_Range_High > row.Yearly_Range_Low:
                add("valid_yearly_range")
                midpoint = (row.Yearly_Range_High + row.Yearly_Range_Low) / 2
                add("upper_half_52w" if row.Close >= midpoint else "lower_half_52w")
            for value, valid, rules in ((row.Return_21,"valid_return_21",(("up_25_month",25,"gte"),("down_25_month",-25,"lte"),("up_50_month",50,"gte"),("down_50_month",-50,"lte"))),(row.Return_34,"valid_return_34",(("up_13_34d",13,"gte"),("down_13_34d",-13,"lte"))),(row.Return_63,"valid_return_63",(("up_25_quarter",25,"gte"),("down_25_quarter",-25,"lte")))):
                if not _present(value): continue
                add(valid)
                for field, threshold, op in rules:
                    if (op == "gte" and value >= threshold) or (op == "lte" and value <= threshold): add(field)
            # Replay the original field order, including zero-volume audit
            # membership, so record bytes and contribution order stay stable.
            for target, record in records:
                for field in fields:
                    if field not in VOLUME_FIELDS:
                        target._add(record, field, symbol)
                    else:
                        record[field] += float(row.Volume)
                        if target._contributions is not None and symbol and record['date'] in target._contributions:
                            target._contributions[record['date']][field].append(symbol)
    def records(self): return [self._records[day] for day in sorted(self._records)]
    def contribution_records(self):
        return [{"date": day, "metrics": {key: sorted(value) for key, value in self._contributions[day].items()}} for day in sorted(self._contributions)] if self._contributions is not None else []

def percentage(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def scaled_ratio(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def percentage_change(current, previous):
    return None if current is None or previous in (None, 0) or not math.isfinite(previous) else 100.0 * (current / previous - 1)
