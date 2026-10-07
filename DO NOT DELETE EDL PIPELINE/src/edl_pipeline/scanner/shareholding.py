"""Dated ScanX shareholding observations for point-in-time scanner snapshots.

ScanX's ``sHp`` payload contains a period-labelled ownership series, while the
canonical stock artifact intentionally exposes only its latest values.  Keep
the source series separately and require that the pipeline had observed it by
the requested screen date.  ``YEAR`` is a reporting-period label, not a filing
timestamp, so it is never presented as a public filing date.
"""

from __future__ import annotations

import calendar
import math
from datetime import date
from typing import Iterable


SHAREHOLDING_FIELDS = {
    "PROMOTER": "promoter_holding_percent",
    "FII": "fii_holding_percent",
    "DII": "dii_holding_percent",
    "PUBLIC": "public_holding_percent",
    "NO_OF_SHARE_HOLDERS": "number_of_shareholders",
}

SHAREHOLDING_CHANGE_FIELDS = {
    "fii_percent_change_qoq": "fii_holding_percent",
    "dii_percent_change_qoq": "dii_holding_percent",
}


def _iso_date(value) -> str | None:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except (TypeError, ValueError):
        return None


def _period_end(value) -> str | None:
    """Normalize ScanX YYYYMM labels and reject its known placeholder dates."""
    text = str(value or "").strip()
    if len(text) != 6 or not text.isdigit():
        return None
    year, month = int(text[:4]), int(text[4:])
    if year < 2000 or not 1 <= month <= 12:
        return None
    return date(year, month, calendar.monthrange(year, month)[1]).isoformat()


def _number(value, integer=False):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if integer and number.is_integer() else number


def _pipe_value(source: dict, key: str, index: int):
    values = str(source.get(key) or "").split("|")
    return _number(values[index], integer=key == "NO_OF_SHARE_HOLDERS") if index < len(values) else None


def observations_from_fundamentals(fundamentals: Iterable[dict], observed_on: str) -> list[dict]:
    """Extract one normalized row per symbol and valid reporting period."""
    observed_on = _iso_date(observed_on)
    if not observed_on:
        raise ValueError("observed_on must be an ISO calendar date")
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for fundamental in fundamentals:
        if not isinstance(fundamental, dict):
            continue
        symbol = str(fundamental.get("Symbol") or fundamental.get("symbol") or "").upper()
        holdings = fundamental.get("sHp") or {}
        if not symbol or not isinstance(holdings, dict):
            continue
        periods = str(holdings.get("YEAR") or "").split("|")
        for index, label in enumerate(periods):
            period_end = _period_end(label)
            key = (symbol, period_end or "")
            if not period_end or key in seen:
                continue
            values = {
                output: _pipe_value(holdings, source, index)
                for source, output in SHAREHOLDING_FIELDS.items()
            }
            if not any(value is not None for value in values.values()):
                continue
            rows.append({
                "symbol": symbol,
                "isin": fundamental.get("isin") or fundamental.get("ISIN"),
                "period_end": period_end,
                "observed_on": observed_on,
                "source": "ScanX sHp ownership history (period end; filing date unavailable)",
                **values,
            })
            seen.add(key)
    return sorted(rows, key=lambda item: (item["symbol"], item["period_end"]))


def select_observation(observations: Iterable[dict], symbol: str, as_of_date: str) -> dict | None:
    """Return the latest source record seen no later than ``as_of_date``.

    A reporting period does not establish the actual publication date.  The
    observed-on bound is therefore mandatory: a record first downloaded today
    cannot change an older scanner snapshot.
    """
    as_of = _iso_date(as_of_date)
    if not as_of:
        return None
    candidates = [
        item for item in observations
        if str(item.get("symbol") or "").upper() == str(symbol).upper()
        and (period_end := _iso_date(item.get("period_end"))) is not None
        and (observed_on := _iso_date(item.get("observed_on"))) is not None
        and period_end <= as_of and observed_on <= as_of
    ]
    if not candidates:
        return None
    latest = max(candidates, key=lambda item: (str(item["period_end"]), str(item["observed_on"])))
    period = date.fromisoformat(_iso_date(latest["period_end"]))
    # QoQ means adjacent completed quarters, not whichever older row exists.
    previous = None
    if period.month in (3, 6, 9, 12) and period.day == calendar.monthrange(period.year, period.month)[1]:
        year, month_index = divmod(period.year * 12 + period.month - 1 - 3, 12)
        month = month_index + 1
        previous_end = date(year, month, calendar.monthrange(year, month)[1]).isoformat()
        prior_rows = [item for item in candidates if _iso_date(item["period_end"]) == previous_end]
        if prior_rows:
            previous = max(prior_rows, key=lambda item: str(item["observed_on"]))
    selected = dict(latest)
    for change, field in SHAREHOLDING_CHANGE_FIELDS.items():
        current = _number(latest.get(field))
        prior = _number(previous.get(field)) if previous else None
        selected[change] = round(current - prior, 4) if current is not None and prior is not None else None
    return selected
