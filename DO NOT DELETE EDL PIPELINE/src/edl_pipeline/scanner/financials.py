"""Dated statement selection for scanner P/E and quarterly growth."""
from datetime import date
import calendar
import math


STATEMENT_METRICS = {
    "REVENUE": "revenue", "SALES": "sales", "NET_PROFIT": "net_profit",
    "EPS": "eps", "OPM": "opm", "EBITDA": "ebitda",
    "OPERATING_PROFIT": "operating_profit", "PROFIT_BEFORE_TAX": "profit_before_tax",
    "EXPENSES": "expenses", "INTEREST": "interest", "DEPRECIATION": "depreciation",
    "OTHER_INCOME": "other_income", "TAX_PAYMENT_ABSOLUTE": "tax_expenses",
}
HISTORY_SOURCES = {
    "quarterly": "incomeStat_cq", "annual": "incomeStat_cy",
    "balance_sheet": "bs_c", "cash_flow": "cF_c",
}


def normalize_statement_history(raw, observed_on):
    """Retain consolidated period-aligned series; observation is not filing date."""
    history = {"source": "ScanX", "report_type": "CONSOLIDATED",
               "amount_unit": "INR_CRORE", "metric_units": {"eps": "INR_PER_SHARE", "opm": "PERCENT"},
               "observed_on": observed_on}
    for frequency, source in HISTORY_SOURCES.items():
        statement = raw.get(source) or {}
        periods = str(statement.get("YEAR") or "").split("|")
        columns = {key: str(value if value is not None else "").split("|") for key, value in statement.items() if key != "YEAR"}
        rows = {}
        for index, period in enumerate(periods):
            try:
                if len(period) != 6 or not period.isdigit():
                    continue
                year, month = int(period[:4]), int(period[4:])
                if year < 1900 or (frequency == "quarterly" and month not in (3, 6, 9, 12)):
                    continue
                end = date(year, month, calendar.monthrange(year, month)[1]).isoformat()
            except ValueError:
                continue
            # A duplicate period or a shorter column cannot be aligned safely.
            if periods.count(period) != 1:
                continue
            row = {"period_end": end}
            for key, values in columns.items():
                if frequency in {"quarterly", "annual"} and key not in STATEMENT_METRICS:
                    continue
                name = STATEMENT_METRICS.get(key, key.lower())
                row[name] = finite_number(values[index]) if len(values) == len(periods) else None
            rows[end] = row
        history[frequency] = sorted(rows.values(), key=lambda row: row["period_end"])
    return history


def statement_reference(history, frequency, metric, offset=0):
    """Offset means calendar quarters/years, never the next available old row."""
    rows = history.get(frequency) or []
    if not rows:
        return None
    latest = date.fromisoformat(rows[-1]["period_end"])
    step = 3 if frequency == "quarterly" else 12
    year, month_index = divmod(latest.year * 12 + latest.month - 1 - step * offset, 12)
    month = month_index + 1
    end = date(year, month, calendar.monthrange(year, month)[1]).isoformat()
    row = next((row for row in rows if row["period_end"] == end), {})
    return finite_number(row.get(metric))


def statement_summary(history):
    summary = {}
    for metric in ("revenue", "sales", "net_profit"):
        values = [statement_reference(history, "quarterly", metric, index) for index in range(8)]
        latest = math.fsum(values[:4]) if all(value is not None for value in values[:4]) else None
        prior = math.fsum(values[4:]) if all(value is not None for value in values[4:]) else None
        summary[f"ttm_{metric}_crore"] = latest
        summary[f"ttm_{metric}_growth_percent"] = ((latest - prior) / abs(prior) * 100
            if latest is not None and prior not in (None, 0) else None)
    summary["opm_5_years_ago_percent"] = statement_reference(history, "annual", "opm", 5)
    return summary


def historical_field_value(stock, field, as_of):
    history = stock.get("financial_statement_history") or {}
    observed = history.get("observed_on")
    try:
        if not observed or date.fromisoformat(observed) > as_of:
            return None, "statement_history_not_observed_on_screen_date"
    except (TypeError, ValueError):
        return None, "statement_history_observation_date_unavailable"
    # Period ends identify reports, not when their numbers became public.
    # Never reinterpret today's series as a past point-in-time snapshot.
    if any(row["period_end"] > as_of.isoformat() for rows in
           (history.get("quarterly", []), history.get("annual", [])) for row in rows):
        return None, "statement_history_contains_future_period"
    if field.startswith("financial:"):
        parts = field.split(":")
        if len(parts) != 4:
            return None, "invalid_statement_reference"
        _, frequency, metric, offset = parts
        if frequency not in {"annual", "quarterly"} or metric not in STATEMENT_METRICS.values() or not offset.isdigit() or int(offset) > 100:
            return None, "invalid_statement_reference"
        value = statement_reference(history, frequency, metric, int(offset))
    else:
        value = statement_summary(history).get(field)
    return (value, None) if value is not None else (None, "statement_period_or_value_unavailable")


def statement_rows(context, stock, spec, as_of):
    rows = context.get("financial_history", {}).get(stock.get("symbol"), [])
    # The ledger contains current numeric revisions. Historical use requires
    # an explicit observation date; a filing timestamp alone is insufficient.
    current = context.get("financial_history_as_of") == as_of.isoformat()
    eligible = [r for r in rows if str(r.get("filing_date", ""))[:10] <= as_of.isoformat()
                and (current or (r.get("observed_on") and str(r["observed_on"])[:10] <= as_of.isoformat()))]
    requested = str(spec.get("report_type", "PREFER_CONSOLIDATED")).upper()
    if requested not in {"PREFER_CONSOLIDATED", "CONSOLIDATED", "STANDALONE"}:
        raise ValueError("Unsupported financial report type")
    types = [requested] if requested != "PREFER_CONSOLIDATED" else ["CONSOLIDATED", "STANDALONE"]
    for report_type in types:
        by_quarter = {}
        for row in sorted(eligible, key=lambda r: str(r.get("filing_date", ""))):
            if row.get("report_type") == report_type:
                by_quarter[row["quarter_end"]] = row
        if by_quarter:
            return sorted(by_quarter.values(), key=lambda r: r["quarter_end"])
    return []


def quarter_index(value):
    d = date.fromisoformat(value)
    return d.year * 4 + (d.month - 1) // 3


def finite_number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def financial_value(context, stock, spec, as_of, market_cap):
    """Return value, details, reason; never fill gaps with another statement."""
    rows = statement_rows(context, stock, spec, as_of)
    if not rows:
        return None, {}, "dated_financial_statement_unavailable"
    latest = rows[-1]
    details = {"report_type": latest["report_type"], "filing_date": latest["filing_date"], "quarter_end": latest["quarter_end"]}
    if spec["condition"] == "pe_ratio":
        selected = rows[-4:]
        quarters = [quarter_index(r["quarter_end"]) for r in selected]
        profits = [finite_number(r.get("net_profit")) for r in selected]
        if len(selected) != 4 or quarters != list(range(quarters[-1] - 3, quarters[-1] + 1)) or any(v is None for v in profits):
            return None, details, "four_consecutive_announced_quarters_unavailable"
        total = sum(profits)
        if total <= 0 or market_cap is None:
            return None, details, "positive_ttm_profit_or_market_cap_unavailable"
        return market_cap / total, {**details, "ttm_net_profit_crore": total}, None
    metric = {"revenue": "revenue", "net_profit": "net_profit", "pbt": "profit_before_tax", "eps": "eps", "opm": "opm"}.get(str(spec.get("metric", "net_profit")).lower())
    if metric is None:
        raise ValueError("Unsupported earnings metric")
    basis = str(spec.get("basis", "yoy")).lower()
    if basis not in {"qoq", "yoy"}:
        raise ValueError("Unsupported earnings basis")
    prior_quarter = quarter_index(latest["quarter_end"]) - (1 if basis == "qoq" else 4)
    prior = next((r for r in rows if quarter_index(r["quarter_end"]) == prior_quarter), {})
    value, base = finite_number(latest.get(metric)), finite_number(prior.get(metric))
    age = (as_of - date.fromisoformat(str(latest["filing_date"])[:10])).days
    if age > int(spec.get("maximum_filing_age_days", 200)):
        return None, details, "earnings_filing_too_old"
    if value is None or base in {None, 0}:
        return None, details, "comparison_quarter_unavailable"
    return (value - base) / abs(base) * 100, {**details, "filing_age_days": age, "metric": metric, "basis": basis}, None
