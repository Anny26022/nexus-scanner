"""Small, deterministic compiler for the public Market-Lens-style query syntax.

The compiler deliberately produces the same expression-tree format as the
criteria builder.  It has no evaluator of its own, which keeps a saved query
and a builder-created screen on one calculation path.
"""

from __future__ import annotations

import re
from typing import Any


_OPERATORS = {">": "greater", ">=": "greater_or_equal", "<": "less", "<=": "less_or_equal", "=": "equal"}
_INDICATOR_FUNCTIONS = {"rsi", "cci", "mfi", "roc", "obv", "adx", "atr", "stoch k", "stoch d",
                        "williams r", "macd", "macd signal", "macd hist", "plus di", "minus di"}

# Names deliberately mirror the public query gallery.  Values are the stable
# internal field identifiers evaluated by ``field_comparison``.
FIELD_ALIASES = {
    "market cap (in cr)": "market_cap_crore", "market cap": "market_cap_crore",
    "price to earning (p/e)": "pe_ratio", "price to earnings (p/e)": "pe_ratio", "p/e": "pe_ratio", "pe ratio": "pe_ratio",
    "debt to equity": "debt_to_equity", "earning per share (eps)": "eps_ttm", "earnings per share (eps)": "eps_ttm", "eps": "eps_ttm",
    "close price": "close", "current market price": "close", "open price": "open",
    "high price": "high", "low price": "low", "volume (in lakhs)": "volume_lakh", "volume": "volume_lakh",
    "20 dma": "sma_20", "50 dma": "sma_50", "200 dma": "sma_200",
    "52w high": "high_52w", "52w low": "low_52w",
    "return over % 1 month": "return_1m", "return over % 1 year": "return_1y",
    "return over % 3 years": "return_3y", "return over % 5 years": "return_5y",
    "return over % year to date": "return_ytd", "daily volatility": "daily_volatility",
    "annualized volatility": "annualized_volatility", "promoter holding (%)": "promoter_holding_percent",
    "public holding": "public_holding_percent", "number of shareholders": "number_of_shareholders",
    "dividend yield(%)": "dividend_yield_percent", "dividend yield (%)": "dividend_yield_percent", "dividend yield": "dividend_yield_percent", "face value": "face_value",
    "total income (in lakhs)": "total_income_in_lakhs", "total expense (in lakhs)": "total_expense_in_lakhs",
    "profit before tax (in lakhs)": "profit_before_tax_in_lakhs", "total tax expenses (in lakhs)": "total_tax_expenses_in_lakhs",
    "net profit (in lakhs)": "net_profit_in_lakhs", "total equity (in lakhs)": "total_equity_in_lakhs",
    "total assets (in lakhs)": "total_assets_in_lakhs", "current assets (in lakhs)": "current_assets_in_lakhs",
    "current liabilities (in lakhs)": "current_liabilities_in_lakhs", "non-current liabilities (in lakhs)": "non_current_liabilities_in_lakhs",
    "operating cash flow (in lakhs)": "operating_cash_flow_in_lakhs", "investing cash flow (in lakhs)": "investing_cash_flow_in_lakhs",
    "net cash flow (in lakhs)": "net_cash_flow_in_lakhs",
    "total revenue (in lakhs)": "total_revenue_in_lakhs",
    "non-current assets (in lakhs)": "non_current_assets_in_lakhs",
    "total liabilities (in lakhs)": "total_liabilities_in_lakhs",
    "interest coverage": "interest_coverage", "vwap": "vwap",
    "dividend per share (dps)": "dividend_per_share_latest",
    "all time high": "all_time_high", "all time low": "all_time_low",
}


def _split(text: str, operator: str) -> list[str]:
    """Split an expression by a word operator outside parentheses."""
    depth = 0; pieces: list[str] = []; start = 0
    for match in re.finditer(r"\(|\)|\b" + operator + r"\b", text, flags=re.I):
        token = match.group(0)
        if token == "(": depth += 1
        elif token == ")": depth -= 1
        elif depth == 0:
            pieces.append(text[start:match.start()].strip()); start = match.end()
    return pieces + [text[start:].strip()]


def _strip_outer(text: str) -> str:
    while text.startswith("(") and text.endswith(")"):
        depth = 0; closes_early = False
        for index, char in enumerate(text):
            depth += char == "("; depth -= char == ")"
            if depth == 0 and index != len(text) - 1: closes_early = True; break
        if closes_early: break
        text = text[1:-1].strip()
    return text


def _operand(value: str) -> Any:
    value = value.strip()
    try: return float(value.replace(",", ""))
    except ValueError:
        field = FIELD_ALIASES.get(value.casefold())
        if not field: raise ValueError(f"Unsupported query field: {value!r}")
        return {"field": field}


def _arguments(text: str) -> list[str]:
    """Split comma-delimited function arguments while retaining quoted text."""
    values, start, depth, quote = [], 0, 0, None
    for index, char in enumerate(text):
        if char in {"'", '"'}:
            quote = None if quote == char else char if quote is None else quote
        elif quote is None:
            depth += char == "("
            depth -= char == ")"
            if char == "," and depth == 0:
                values.append(text[start:index].strip().strip("'\"")); start = index + 1
    values.append(text[start:].strip().strip("'\""))
    return values


def _function_condition(name: str, arguments: list[str], operator: str | None = None, value: str | None = None) -> dict:
    """Compile the public query functions to the existing condition contract."""
    key = re.sub(r"[_\s]+", " ", name).strip().casefold()
    comparison = _OPERATORS.get(operator or ">=", "greater_or_equal")
    target = float(value.replace(",", "")) if value is not None else None
    if key in _INDICATOR_FUNCTIONS and key != "adx":
        if target is None:
            raise ValueError(f"{name.strip()} requires a comparison and number.")
        return {"type": "condition", "kind": "INDICATOR_COMPARE", "params": {
            "leftIndicator": key.replace(" ", "_").upper(), "leftPeriod": int(arguments[0] or 14),
            "leftOffset": 0, "op": {"greater":"GREATER", "greater_or_equal":"ABOVE",
                                      "less":"LESS", "less_or_equal":"BELOW", "equal":"EQUAL"}[comparison],
            "rightIndicator": "", "rightValue": target, "rightPeriod": 20, "rightOffset": 0, "withinDays": 1,
        }}
    if key == "adx":
        return {"type": "condition", "kind": "ADX", "params": {"period": int(arguments[0] or 14), "comparison": comparison, "value": target}}
    if key == "rvol":
        return {"type": "condition", "kind": "VOLUME_VS_AVG", "params": {"avgDays": int(arguments[0] or 20), "multiple": target, "comparison": comparison, "withinDays": 1}}
    if key == "adr":
        return {"type": "condition", "kind": "ADR_PCT", "params": {"lookbackDays": int(arguments[0] or 14), "comparison": comparison, "pct": target}}
    if key == "volume trend":
        return {"type": "condition", "kind": "AVG_VOLUME_RATIO", "params": {"recentDays": int(arguments[0]), "baseDays": int(arguments[1]), "comparison": comparison, "ratio": target}}
    if key == "earnings growth":
        return {"type": "condition", "kind": "EARNINGS_GROWTH", "params": {"metric": arguments[0], "basis": arguments[1], "comparison": comparison, "value": target}}
    if key == "days since earnings":
        if target is None:
            raise ValueError("Days Since Earnings requires a comparison and number.")
        return {"type": "condition", "kind": "DAYS_SINCE_EARNINGS", "params": {"comparison": comparison, "days": target}}
    if key == "rs rating":
        if target is None:
            raise ValueError("RS Rating requires a comparison and number.")
        return {"type": "condition", "kind": "RS_RATING", "params": {
            "window": arguments[0] if arguments else "FRONT_WEIGHTED",
            "comparison": comparison, "value": target,
        }}
    if key == "vcp legs":
        if len(arguments) < 3:
            raise ValueError("VCP Legs requires minimum legs, lookback days and maximum final-leg percent.")
        return {"type": "condition", "kind": "VCP_LEGS", "params": {
            "minLegs": int(arguments[0]), "lookbackDays": int(arguments[1]),
            "maxFinalLegPct": float(arguments[2]),
            "maxLegRatio": float(arguments[3]) if len(arguments) > 3 else .8,
            "minSwingPct": float(arguments[4]) if len(arguments) > 4 else 1.5,
        }}
    if key == "delivery pct":
        if target is None:
            raise ValueError("Delivery Pct requires a comparison and number.")
        return {"type": "condition", "kind": "DELIVERY_PERCENT", "params": {
            "comparison": comparison, "value": target,
        }}
    if key == "ma stack":
        periods = [int(part.strip()) for part in arguments[0].split(",")]
        return {"type": "condition", "kind": "MA_STACK", "params": {"periods": periods, "maType": arguments[1], "priceAbove": arguments[2].lower() == "true"}}
    if key == "ma slope":
        return {"type": "condition", "kind": "MA_SLOPE", "params": {"period": int(arguments[0]), "maType": arguments[1], "window": int(arguments[2]), "comparison": comparison, "minChangePct": target}}
    if key == "ma convergence":
        if target is None:
            raise ValueError("MA Convergence requires a maximum spread comparison.")
        if not arguments or "," not in arguments[0]:
            raise ValueError('MA Convergence periods must be a quoted comma-delimited list, for example "9,20,50,200".')
        periods = [part.strip() for part in arguments[0].split(",") if part.strip()]
        if len(periods) < 2 or not all(part.isdigit() and int(part) > 0 for part in periods) or len(set(periods)) != len(periods):
            raise ValueError("MA Convergence requires at least two positive integer periods.")
        return {"type": "condition", "kind": "MA_CONVERGENCE", "params": {
            "periods": [int(part) for part in periods],
            "maType": arguments[1] if len(arguments) > 1 else "EMA",
            "comparison": comparison,
            "maxSpreadPct": target,
            "withinDays": int(arguments[2]) if len(arguments) > 2 else 1,
        }}
    if key == "supertrend":
        return {"type": "condition", "kind": "SUPERTREND", "params": {
            "period": int(arguments[0] if arguments and arguments[0] else 10),
            "multiplier": float(arguments[1] if len(arguments) > 1 and arguments[1] else 3),
            "direction": arguments[2] if len(arguments) > 2 else "BULLISH",
            "signal": arguments[3] if len(arguments) > 3 else "STATE",
            "withinDays": int(arguments[4]) if len(arguments) > 4 else 1,
        }}
    if key == "indicator compare":
        if len(arguments) < 5:
            raise ValueError("Indicator Compare requires left indicator, period, offset, operation and target.")
        left_offset = int(arguments[2])
        if left_offset < 0:
            raise ValueError("Indicator Compare offsets must be zero or positive.")
        try:
            fixed_value = float(arguments[4])
            right_indicator, right_period, right_offset = "", 20, 0
            within_days = int(arguments[5]) if len(arguments) > 5 else 1
        except ValueError:
            right_indicator = arguments[4]
            fixed_value = 0.0
            right_period = int(arguments[5]) if len(arguments) > 5 else 20
            right_offset = int(arguments[6]) if len(arguments) > 6 else 0
            within_days = int(arguments[7]) if len(arguments) > 7 else 1
        if right_offset < 0 or within_days <= 0:
            raise ValueError("Indicator Compare offsets must be zero or positive and withinDays must be positive.")
        return {"type": "condition", "kind": "INDICATOR_COMPARE", "params": {
            "leftIndicator": arguments[0], "leftPeriod": int(arguments[1]), "leftOffset": left_offset,
            "op": arguments[3], "rightIndicator": right_indicator, "rightValue": fixed_value,
            "rightPeriod": right_period, "rightOffset": right_offset, "withinDays": within_days,
        }}
    if key == "divergence":
        if len(arguments) < 9:
            raise ValueError("Divergence requires oscillator, period, direction, variant, pivot gap, left/right pivots, lookback and withinDays.")
        return {"type": "condition", "kind": "DIVERGENCE", "params": {
            "oscillator": arguments[0], "oscPeriod": int(arguments[1]), "direction": arguments[2],
            "variant": arguments[3], "maxBarDifference": int(arguments[4]), "pivotLeft": int(arguments[5]),
            "pivotRight": int(arguments[6]), "lookbackDays": int(arguments[7]), "withinDays": int(arguments[8]),
            "invalidateOnBreak": arguments[9].casefold() == "true" if len(arguments) > 9 else True,
        }}
    raise ValueError(f"Unsupported query function: {name!r}")


def _leaf(text: str) -> dict:
    function = re.match(r"^(.+?)\((.*)\)\s*(>=|<=|>|<|=)\s*(.+)$", text.strip())
    field_match = re.match(r"^(.+?)\s*(>=|<=|>|<|=)\s*(.+)$", text.strip())
    known_field = field_match and field_match.group(1).strip().casefold() in FIELD_ALIASES
    if function and not known_field:
        name, arguments, operator, value = function.groups()
        return _function_condition(name, _arguments(arguments), operator, value)
    if field_match:
        special = field_match.group(1).strip().casefold()
        if special in {"days since earnings", "rs rating", "delivery pct"}:
            return _function_condition(special, [], field_match.group(2), field_match.group(3))
    bare_function = re.match(r"^(.+?)\((.*)\)$", text.strip())
    # A parenthesized field alias may appear on the right side of an ordinary
    # field comparison (for example ``Close Price > Non-current assets (in
    # lakhs)``). Do not reinterpret that whole clause as a bare function.
    if bare_function and not field_match:
        return _function_condition(bare_function.group(1), _arguments(bare_function.group(2)))
    match = field_match
    if not match: raise ValueError(f"Expected a comparison in query clause: {text!r}")
    left, operator, right = match.groups()
    left_value = _operand(left)
    if not isinstance(left_value, dict): raise ValueError("The left side of a query comparison must be a field.")
    return {"type": "condition", "condition": "field_comparison", "field": left_value["field"], "comparison": _OPERATORS[operator], "value": _operand(right)}


def compile_query(query: str) -> dict:
    """Compile ``Field > number AND …`` into a scanner expression tree."""
    text = _strip_outer(str(query or "").strip())
    if not text: raise ValueError("Query is empty.")
    for operator in ("OR", "AND"):
        parts = _split(text, operator)
        if len(parts) > 1:
            return {"type": "group", "op": operator, "children": [compile_query(part) for part in parts]}
    return _leaf(text)
