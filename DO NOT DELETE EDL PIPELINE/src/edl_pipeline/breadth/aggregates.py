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

    def update(self, history, symbol=None):
        for row in history.itertuples(index=False):
            record = self._record(row.Date)
            self._retain_contribution_date(row.Date)
            self._add(record, "eligible_with_candle", symbol)
            daily_return = row.Daily_Return
            if _present(row.Volume):
                record["total_volume"] += float(row.Volume)
                if self._contributions is not None and symbol and record["date"] in self._contributions:
                    self._contributions[record["date"]]["total_volume"].append(symbol)
            if _present(daily_return):
                self._add(record, "valid_return", symbol)
                if daily_return > 0: self._add(record, "advances", symbol)
                elif daily_return < 0: self._add(record, "declines", symbol)
                else: self._add(record, "unchanged", symbol)
                if daily_return >= self.methodology.advance_threshold: self._add(record, "up_4", symbol)
                if daily_return < -self.methodology.advance_threshold: self._add(record, "down_4", symbol)
                if daily_return >= self.methodology.extreme_advance_threshold: self._add(record, "up_4_5", symbol)
                if daily_return < -self.methodology.extreme_advance_threshold: self._add(record, "down_4_5", symbol)
                if _present(row.Volume):
                    if daily_return > 0:
                        record["advance_volume"] += float(row.Volume)
                        if self._contributions is not None and symbol and record["date"] in self._contributions:
                            self._contributions[record["date"]]["advance_volume"].append(symbol)
                    elif daily_return < 0:
                        record["decline_volume"] += float(row.Volume)
                        if self._contributions is not None and symbol and record["date"] in self._contributions:
                            self._contributions[record["date"]]["decline_volume"].append(symbol)
            for ma_type in ("SMA", "EMA"):
                for period in self.methodology.ma_periods:
                    value = getattr(row, f"{ma_type}_{period}")
                    if not _present(value): continue
                    prefix = ma_type.lower(); self._add(record, f"valid_{prefix}_{period}", symbol)
                    if row.Close > value: self._add(record, f"above_{prefix}_{period}", symbol)
                    elif row.Close < value: self._add(record, f"below_{prefix}_{period}", symbol)
                    else: self._add(record, f"equal_{prefix}_{period}", symbol)
            for label, valid, high, low in (("Monthly","valid_monthly_extrema","new_monthly_high","new_monthly_low"),("Quarterly","valid_quarterly_extrema","new_quarterly_high","new_quarterly_low"),("Yearly","valid_yearly_extrema","new_52w_high","new_52w_low")):
                if _present(getattr(row, f"{label}_Reference_High")) and _present(getattr(row, f"{label}_Reference_Low")):
                    self._add(record, valid, symbol)
                    if getattr(row, f"New_{label}_High"): self._add(record, high, symbol)
                    if getattr(row, f"New_{label}_Low"): self._add(record, low, symbol)
            if _present(row.Volume_SMA_20) and _present(row.Volume):
                self._add(record, "valid_volume_20", symbol)
                self._add(record, "volume_above_20" if row.Volume > row.Volume_SMA_20 else "volume_below_or_equal_20", symbol)
            if _present(row.Prior_20_High) and _present(row.Prior_20_Low):
                self._add(record, "valid_breakout_20", symbol)
                if row.Breakout_20d: self._add(record, "breakout_20d", symbol)
                if row.Breakdown_20d: self._add(record, "breakdown_20d", symbol)
            if _present(row.Yearly_Range_High) and _present(row.Yearly_Range_Low) and row.Yearly_Range_High > row.Yearly_Range_Low:
                self._add(record, "valid_yearly_range", symbol)
                midpoint = (row.Yearly_Range_High + row.Yearly_Range_Low) / 2
                self._add(record, "upper_half_52w" if row.Close >= midpoint else "lower_half_52w", symbol)
            for value, valid, rules in ((row.Return_21,"valid_return_21",(("up_25_month",25,"gte"),("down_25_month",-25,"lte"),("up_50_month",50,"gte"),("down_50_month",-50,"lte"))),(row.Return_34,"valid_return_34",(("up_13_34d",13,"gte"),("down_13_34d",-13,"lte"))),(row.Return_63,"valid_return_63",(("up_25_quarter",25,"gte"),("down_25_quarter",-25,"lte")))):
                if not _present(value): continue
                self._add(record, valid, symbol)
                for field, threshold, op in rules:
                    if (op == "gte" and value >= threshold) or (op == "lte" and value <= threshold): self._add(record, field, symbol)
    def records(self): return [self._records[day] for day in sorted(self._records)]
    def contribution_records(self):
        return [{"date": day, "metrics": {key: sorted(value) for key, value in self._contributions[day].items()}} for day in sorted(self._contributions)] if self._contributions is not None else []

def percentage(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def scaled_ratio(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def percentage_change(current, previous):
    return None if current is None or previous in (None, 0) or not math.isfinite(previous) else 100.0 * (current / previous - 1)
