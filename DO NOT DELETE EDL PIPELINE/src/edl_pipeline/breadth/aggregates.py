"""Cross-sectional aggregation with metric-specific denominators and audit flags."""

from collections import defaultdict
import heapq
import math
import pandas as pd
import numpy as np

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
VOLUME_COLUMNS = {field: index for index, field in enumerate(field for field in COUNT_FIELDS if field in VOLUME_FIELDS)}
INTEGER_FIELDS = tuple(field for field in (
    *COUNT_FIELDS,
    *(f"{state}_{ma_type}_{period}" for ma_type in ("sma", "ema")
      for period in (10, 20, 50, 200) for state in ("valid", "above", "below", "equal"))
) if field not in VOLUME_FIELDS)
INTEGER_COLUMNS = {field: index for index, field in enumerate(INTEGER_FIELDS)}

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
        self._dates = {}
        self._counts = np.zeros((0, len(INTEGER_FIELDS)), dtype=np.int64)
        self._volumes = np.zeros((0, len(VOLUME_COLUMNS)))
        self._volume_seen = np.zeros((0, len(VOLUME_COLUMNS)), dtype=bool)
        self._total_updates = 0
        self._contribution_days = []
        self._contributions = defaultdict(lambda: defaultdict(list)) if include_contributions else None

    def _count_history(self, dates, columns, flags):
        for day in dates:
            if day not in self._dates:
                self._dates[day] = len(self._dates)
        size = len(self._dates)
        if size > len(self._counts):
            counts = np.zeros((max(size, 2 * len(self._counts)), len(INTEGER_FIELDS)),
                              dtype=self._counts.dtype)
            counts[:len(self._counts)] = self._counts
            self._counts = counts
            volumes = np.zeros((len(counts), len(VOLUME_COLUMNS)))
            seen = np.zeros(volumes.shape, dtype=bool)
            volumes[:len(self._volumes)] = self._volumes
            seen[:len(self._volume_seen)] = self._volume_seen
            self._volumes, self._volume_seen = volumes, seen
        self._total_updates += len(dates)
        # Each counter is bounded by the number of updates. Promote rather than
        # allowing native overflow to change Python's unbounded integer behavior.
        if self._counts.dtype != object and self._total_updates > np.iinfo(np.int64).max:
            self._counts = self._counts.astype(object)
        positions = np.fromiter((self._dates[day] for day in dates), dtype=np.intp)
        indices = (positions[:, None], columns)
        if len(set(dates)) == len(dates):
            self._counts[indices] += flags
        else:
            # Direct callers can repeat dates; fancy-index addition alone
            # would lose those repeated increments.
            np.add.at(self._counts, indices, flags)
        return positions

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

    def update(self, history, symbol=None, peers=()):
        """Vectorize predicates, replay increments in original symbol/date order."""
        targets = (self, *peers)
        if len({id(target) for target in targets}) != len(targets):
            raise ValueError('Breadth targets must be distinct')
        if any(target.methodology != self.methodology for target in targets[1:]):
            raise ValueError('Breadth targets must share a methodology')
        if history.empty:
            return
        names, flags = _increment_flags(history, self.methodology)
        integer_indices = [i for i, name in enumerate(names) if name not in VOLUME_FIELDS]
        volume_indices = [i for i, name in enumerate(names) if name in VOLUME_FIELDS]
        columns = np.asarray([INTEGER_COLUMNS[names[i]] for i in integer_indices])
        dates = history['Date'].tolist()
        unique_dates = len(set(dates)) == len(dates)
        volume = history['Volume'].to_numpy()
        for target in targets:
            positions = target._count_history(dates, columns, flags[:, integer_indices])
            for index in volume_indices:
                selected = flags[:, index]
                rows = positions[selected]
                column = VOLUME_COLUMNS[names[index]]
                amounts = np.asarray(volume[selected], dtype=float)
                # Each cell receives the same additions in symbol/date order.
                # add.at also preserves repeated-date additions; never sum them.
                with np.errstate(over='ignore', invalid='ignore'):
                    if unique_dates:
                        target._volumes[rows, column] += amounts
                    else:
                        np.add.at(target._volumes[:, column], rows, amounts)
                target._volume_seen[rows, column] = True
        audit_targets = [target for target in targets if target._contributions is not None] if symbol else []
        if audit_targets:
            for day, mask in zip(dates, flags):
                for target in audit_targets:
                    target._retain_contribution_date(day)
                audits = [target._contributions.get(day) for target in audit_targets]
                active = np.flatnonzero(mask) if any(audit is not None for audit in audits) else ()
                for audit in audits:
                    if audit is not None:
                        for index in active:
                            audit[names[index]].append(symbol)
    def records(self):
        output = []
        for day in sorted(self._dates):
            record = _blank_record(day)
            record.update(zip(INTEGER_FIELDS, map(int, self._counts[self._dates[day]])))
            position = self._dates[day]
            # Untouched fields remain integer zero, as in the scalar accumulator.
            record.update((field, float(self._volumes[position, index])
                           if self._volume_seen[position, index] else 0)
                          for field, index in VOLUME_COLUMNS.items())
            output.append(record)
        return output
    def contribution_records(self):
        return [{"date": day, "metrics": {key: sorted(value) for key, value in self._contributions[day].items()}} for day in sorted(self._contributions)] if self._contributions is not None else []

def _increment_flags(history, methodology):
    names, masks = [], []
    source = history
    boolean_columns = ('Breakout_20d', 'Breakdown_20d', *(f'New_{label}_{side}'
                       for label in ('Monthly', 'Quarterly', 'Yearly') for side in ('High', 'Low')))
    # Prepared histories contain native numeric/bool columns. Keep pandas'
    # nullable/object semantics for direct callers with other dtypes.
    if (all(isinstance(dtype, np.dtype) and dtype.kind in 'biuf'
            for name, dtype in history.dtypes.items() if name != 'Date')
            and all(history[name].dtype == np.dtype(bool) for name in boolean_columns)):
        source = {name: history[name].to_numpy() for name in history if name != 'Date'}
    def add(name, mask):
        names.append(name)
        masks.append(np.asarray(mask.fillna(False) if isinstance(mask, pd.Series) else mask, dtype=bool))
    present = lambda column: pd.notna(source[column])
    close, volume, returns = source['Close'], source['Volume'], source['Daily_Return']
    add('eligible_with_candle', np.ones(len(history), dtype=bool))
    add('total_volume', present('Volume'))
    valid = present('Daily_Return')
    add('valid_return', valid)
    add('advances', valid & (returns > 0))
    add('declines', valid & (returns < 0))
    add('unchanged', valid & (returns == 0))
    add('up_4', valid & (returns >= methodology.advance_threshold))
    add('down_4', valid & (returns < -methodology.advance_threshold))
    add('up_4_5', valid & (returns >= methodology.extreme_advance_threshold))
    add('down_4_5', valid & (returns < -methodology.extreme_advance_threshold))
    add('advance_volume', valid & present('Volume') & (returns > 0))
    add('decline_volume', valid & present('Volume') & (returns < 0))
    for ma_type in ('SMA', 'EMA'):
        for period in methodology.ma_periods:
            column = f'{ma_type}_{period}'
            valid = present(column)
            prefix = f'{ma_type.lower()}_{period}'
            above, below = close > source[column], close < source[column]
            add('valid_' + prefix, valid)
            add('above_' + prefix, valid & above)
            add('below_' + prefix, valid & below)
            add('equal_' + prefix, valid & ~(above | below))
    for label, valid_name, high, low in (
        ('Monthly', 'valid_monthly_extrema', 'new_monthly_high', 'new_monthly_low'),
        ('Quarterly', 'valid_quarterly_extrema', 'new_quarterly_high', 'new_quarterly_low'),
        ('Yearly', 'valid_yearly_extrema', 'new_52w_high', 'new_52w_low')):
        valid = present(label + '_Reference_High') & present(label + '_Reference_Low')
        add(valid_name, valid)
        add(high, valid & source['New_' + label + '_High'])
        add(low, valid & source['New_' + label + '_Low'])
    valid = present('Volume_SMA_20') & present('Volume')
    add('valid_volume_20', valid)
    add('volume_above_20', valid & (volume > source['Volume_SMA_20']))
    add('volume_below_or_equal_20', valid & ~(volume > source['Volume_SMA_20']))
    valid = present('Prior_20_High') & present('Prior_20_Low')
    add('valid_breakout_20', valid)
    add('breakout_20d', valid & source['Breakout_20d'])
    add('breakdown_20d', valid & source['Breakdown_20d'])
    valid = present('Yearly_Range_High') & present('Yearly_Range_Low') & (source['Yearly_Range_High'] > source['Yearly_Range_Low'])
    midpoint = (source['Yearly_Range_High'] + source['Yearly_Range_Low']) / 2
    add('valid_yearly_range', valid)
    add('upper_half_52w', valid & (close >= midpoint))
    add('lower_half_52w', valid & ~(close >= midpoint))
    for column, valid_name, rules in (
        ('Return_21', 'valid_return_21', (('up_25_month', 25, True), ('down_25_month', -25, False), ('up_50_month', 50, True), ('down_50_month', -50, False))),
        ('Return_34', 'valid_return_34', (('up_13_34d', 13, True), ('down_13_34d', -13, False))),
        ('Return_63', 'valid_return_63', (('up_25_quarter', 25, True), ('down_25_quarter', -25, False)))):
        valid = present(column)
        add(valid_name, valid)
        for name, threshold, above in rules:
            add(name, valid & ((source[column] >= threshold) if above else (source[column] <= threshold)))
    return names, np.column_stack(masks)

def percentage(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def scaled_ratio(numerator, denominator): return None if denominator <= 0 else 100.0 * numerator / denominator
def percentage_change(current, previous):
    return None if current is None or previous in (None, 0) or not math.isfinite(previous) else 100.0 * (current / previous - 1)
