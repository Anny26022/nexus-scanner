"""Local frontend bridge to the EDL scanner; JSON stdin/stdout, no network IO."""
from __future__ import annotations

from collections import Counter
from datetime import date
import json
from pathlib import Path
import sys
import re

import pandas as pd

ROOT = Path(__file__).resolve().parents[1] / "DO NOT DELETE EDL PIPELINE"
sys.path[:0] = [str(ROOT), str(ROOT / "src")]
from screen_trend_conditions import _load_context, _load_delivery_history, _resolve_universe
from edl_pipeline.scanner.context import normalize_condition_spec
from edl_pipeline.scanner.context import CONTEXT_CONDITION_REGISTRY
from edl_pipeline.scanner.presets import get_preset
from edl_pipeline.scanner.query import compile_query
from edl_pipeline.scanner.trend import evaluate_history, normalize_history, _comparison, _evaluate_expression, _leaf_results
from edl_pipeline.scanner.financials import finite_number, financial_value


LEGACY_PRESETS = {
    "preset_persistent_momentum": "lib-persistent-momentum", "preset_easy_money": "lib-easy-money",
    "preset_relative_strength_leaders": "lib-rs-leaders", "preset_stage_2_uptrend": "lib-stage-two",
    "preset_momentum_burst": "lib-momentum-burst", "preset_52_week_high_breakout": "lib-52w-high-breakout",
    "preset_vcp_contraction": "lib-vcp", "preset_earnings_growth_momentum": "lib-earnings-momentum",
}


def leaf(kind, **params):
    return {"type": "condition", "kind": kind, "params": params}


def group(op, *children):
    return {"type": "group", "op": op, "children": list(children)}


def band(kind, field, low, high, **params):
    return group("AND", leaf(kind, comparison="ABOVE", **{field: low}, **params),
                 leaf(kind, comparison="less_or_equal", **{field: high}, **params))


def translate(identifier, p):
    if identifier.startswith("lib-") or identifier in LEGACY_PRESETS:
        preset = get_preset(LEGACY_PRESETS.get(identifier, identifier))
        return {"type": "preset", "expression": preset["expression"]}
    if identifier.isupper():
        p = dict(p)
        for field in ("values", "periods"):
            if isinstance(p.get(field), str):
                values = [v.strip() for v in p[field].split(",") if v.strip()]
                p[field] = [int(v) for v in values] if field == "periods" else values
        return leaf(identifier, **p)
    if identifier == "trend_price_vs_ma":
        if p["operator"] == "within_pct":
            return {"type": "snapshot", "field": f"distance_from_{p['maType'].lower()}{p['maPeriod']}_percent", "abs_max": p["thresholdPct"]}
        return leaf("PRICE_VS_" + p["maType"], period=int(p["maPeriod"]), comparison=p["operator"].upper(), persistDays=1)
    if identifier == "trend_ma_stack":
        order = p["stackOrder"]
        return leaf("MA_STACK", periods=[200, 50, 20] if order == "bearish_stack" else [10, 20, 50] if order == "10_above_20_above_50" else [20, 50, 200], maType="SMA" if order == "10_above_20_above_50" else "EMA", priceAbove=False)
    if identifier == "trend_ma_slope":
        return leaf("MA_SLOPE", period=int(p["targetMa"]), maType="SMA", overDays=20, comparison="ABOVE", minChangePct=p["minSlopePct"])
    if identifier == "trend_persistent_momentum":
        return leaf("PRICE_VS_EMA", period=20, comparison="ABOVE", persistDays=p["minDaysAboveEMA"])
    if identifier == "trend_ema_reclaim":
        return leaf("EMA_SHAKEOUT", period=int(str(p["reclaimedEma"]).split()[-1]), withinDays=p["reclaimedWithin"])
    if identifier == "trend_pct_days_above_ma":
        return leaf("PCT_DAYS_ABOVE_MA", period=50, maType="SMA", overDays=50, comparison="ABOVE", pct=p["minPctDays"])
    if identifier == "mom_rvol":
        return group("AND", leaf("VOLUME_VS_AVG", avgDays=20, multiple=p["minRvol"], withinDays=1), {"type":"snapshot", "field":"relative_volume_20", "max":p["maxRvol"]})
    if identifier == "mom_return":
        return band("PRICE_CHANGE_PCT", "pct", p["minReturn"], p["maxReturn"], overDays=int(p["period"][:-1]))
    if identifier == "mom_consecutive_up":
        return leaf("CONSECUTIVE_UP_DAYS", minDays=p["minConsecutiveDays"], withinDays=1)
    if identifier == "mom_gap":
        return leaf("GAP_UP" if p["gapType"] == "Gap Up" else "GAP_DOWN", minGapPct=p["minGapPct"], withinDays=1)
    if identifier == "mom_delivery_vol":
        return leaf("DELIVERY_PCT_SPIKE", minDeliverablePct=p["minDeliveryPct"], withinDays=1)
    if identifier == "range_52w_proximity":
        return leaf("PCT_FROM_52W_HIGH" if p["target"] == "High" else "PCT_FROM_52W_LOW", comparison="BELOW", pct=p["maxDistancePct"])
    if identifier == "range_contraction":
        return leaf("RANGE_CONTRACTION", recentDays=p["shortPeriod"], priorDays=60, priorMode="PRIOR", maxRatio=p["maxRatio"])
    if identifier == "range_inside_bar":
        return leaf("INSIDE_BAR", timeframe=p["timeframe"].upper(), consecutive=p["consecutive"])
    if identifier in {"rs_rating", "rs_1month", "rs_3month"}:
        return leaf("RS_RATING", window={"rs_rating":"FRONT_WEIGHTED", "rs_1month":"ONE_MONTH", "rs_3month":"THREE_MONTH"}[identifier], comparison="ABOVE", value=p["minRsRating"])
    if identifier == "rs_divergence":
        return group("AND", leaf("RELATIVE_STRENGTH", benchmark="NIFTY_50", overDays=60, comparison="ABOVE", value=p["minRsVsNifty"]), leaf("PCT_FROM_52W_HIGH", comparison="ABOVE", pct=p["minBelowHigh"]))
    if identifier == "fund_earnings_growth":
        return leaf("EARNINGS_GROWTH", metric="NET_PROFIT", basis="YOY", comparison="ABOVE", pct=p["minGrowthPct"], reportType="PREFER_CONSOLIDATED", maxAgeDays=200)
    if identifier == "fund_pe_ratio":
        return band("PE_RATIO", "value", p["minPe"], p["maxPe"], reportType="PREFER_CONSOLIDATED")
    if identifier == "liq_market_cap":
        return band("MARKETCAP", "valueCr", p["minMarketCap"], p["maxMarketCap"])
    if identifier == "liq_turnover":
        return leaf("AVG_TURNOVER", comparison="ABOVE", lookbackDays=50, valueCr=p["minTurnoverCr"])
    if identifier == "misc_exclude_circuit":
        return {"type": "snapshot", "field": "circuit_limit", "exclude":p["circuitBands"]}
    simple = {
        "fund_roe": {"field":"roe_percent", "min":p.get("minRoe")},
        "fund_free_float": {"field":"free_float_percent", "min":p.get("minFloat"), "max":p.get("maxFloat")},
        "fund_stock_price": {"field":"close", "strict_min":p.get("minPrice")},
        "misc_fno_only": {"field":"fno_eligible", "equal":p.get("isFno") == "true"},
    }
    if identifier in simple:
        return {"type":"snapshot", **simple[identifier]}
    raise ValueError(f"Unsupported filter: {identifier}")


def frontend_expression(node):
    if node["type"] == "group":
        return group("OR" if node["operator"] == "any" else "AND", *[frontend_expression(c) for c in node["children"]])
    c = node["condition"]
    if c.get("isNegated"):
        return {"type":"not", "child":translate(c["conditionId"], c["parameters"])}
    return translate(c["conditionId"], c["parameters"])


def snapshot_rule(s, spec, as_of):
    """Only use materialized metrics whose period/date matches the request."""
    if s.get("as_of_date") != as_of:
        return None
    kind = spec["condition"]
    if spec.get("fired_within", 1) != 1:
        return None
    value = None
    if kind == "price_vs_sma" and int(spec["persist_days"]) == 1:
        value = finite_number(s.get(f"sma{int(spec['period'])}"))
        return None if value is None else (s["close"] > value if spec["comparison"] == "above" else s["close"] < value)
    if kind == "price_change_percent":
        value = finite_number(s.get({1:"change_percent", 5:"perf_1w", 21:"perf_1m", 63:"perf_3m", 126:"perf_6m", 252:"perf_12m"}.get(int(spec["window"]), "")))
    elif kind in {"gap_up", "gap_down"}:
        value = finite_number(s.get("gap_percent"))
        return None if value is None else (value >= spec["minimum_gap_percent"] if kind == "gap_up" else value <= -spec["minimum_gap_percent"])
    elif kind == "relative_volume" and int(spec["average_window"]) == 20:
        value = finite_number(s.get("relative_volume_20"))
        return None if value is None else value >= spec["multiple"]
    elif kind == "delivery_percent_spike":
        value = finite_number(s.get("delivery_percent")) if s.get("delivery_as_of_date") == as_of else None
        return None if value is None else value >= spec["minimum_delivery_percent"]
    elif kind == "average_turnover" and str(spec.get("window_minutes", "")) in {"", "daily"}:
        value = finite_number(s.get(f"daily_rupee_turnover_{int(spec['lookback_days'])}_cr"))
        if value is not None:
            return _comparison(value, spec["comparison"], spec["value_crore"])
    elif kind == "adr_percent":
        value = finite_number(s.get(f"adr_percent_{int(spec['lookback_days'])}"))
    elif kind == "atr_percent" and int(spec["period"]) == 14:
        value = finite_number(s.get("atr_percent_14"))
    elif kind == "inside_bar" and spec.get("timeframe", "daily") == "daily" and int(spec.get("consecutive", 1)) == 1:
        return s.get("is_inside_day") if isinstance(s.get("is_inside_day"), bool) else None
    elif kind in {"percent_from_52w_high", "percent_from_52w_low"}:
        value = finite_number(s.get("distance_from_52w_high_percent" if kind.endswith("high") else "distance_from_52w_low_percent"))
        value = abs(value) if value is not None else None
    elif kind == "new_high":
        field = {20:"breakout_above_20d_high", 50:"breakout_above_50d_high", 252:"breakout_above_52w_high"}.get(int(spec["lookback_days"]))
        return s.get(field) if field and isinstance(s.get(field), bool) else None
    elif kind == "ma_stack" and spec.get("ma_type", "sma") == "sma":
        values = [finite_number(s.get(f"sma{int(p)}")) for p in spec["periods"]]
        if any(v is None for v in values):
            return None
        return all(a > b for a,b in zip(values, values[1:])) and (not spec.get("price_above_fastest", True) or s["close"] > values[0])
    if value is not None:
        return _comparison(value, spec["comparison"], spec["value"])
    return None


def preset_baseline(s):
    cap, price, turnover = [finite_number(s.get(k)) for k in ("market_cap_crore", "close", "daily_rupee_turnover_50_cr")]
    if cap is not None and cap <= 1000:
        return False
    if price is not None and price <= 10:
        return False
    if turnover is not None and turnover <= 5:
        return False
    return None if any(v is None for v in (cap,price,turnover)) else True


def combine(values, op):
    if op == "AND":
        return False if False in values else None if None in values else True
    return True if True in values else None if None in values else False


def _needs_delivery(expression):
    """Whether an expression needs the dated delivery-history side input."""
    serialized = json.dumps(expression).lower()
    return any(marker in serialized for marker in ("delivery_pct_spike", "delivery_percent"))


def evaluate(node, s, frame, context, as_of, diagnostics, delivery):
    if node["type"] == "group":
        if not node["children"]:
            return True
        return combine([evaluate(c,s,frame,context,as_of,diagnostics,delivery) for c in node["children"]], node["op"])
    if node["type"] == "not":
        value = evaluate(node["child"],s,frame,context,as_of,diagnostics,delivery)
        return None if value is None else not value
    if node["type"] == "preset":
        baseline = preset_baseline(s) if s.get("as_of_date") == as_of else None
        if baseline is False:
            return False
        if baseline is None:
            diagnostics.add(("preset_baseline", "dated_baseline_inputs_unavailable"))
        return combine([baseline,evaluate(node["expression"],s,frame,context,as_of,diagnostics,delivery)], "AND")
    if node["type"] == "snapshot":
        value = s.get(node["field"]) if s.get("as_of_date") == as_of else None
        if node["field"] == "relative_volume_20" and frame is not None:
            if len(frame) < 21:
                diagnostics.add((node["field"], "insufficient_history"))
                return None
            if frame["Date"].iloc[-1].strftime("%Y-%m-%d") != as_of:
                diagnostics.add((node["field"], "stock_history_not_aligned_to_screen_date"))
                return None
            average = frame["Volume"].iloc[-21:-1].mean()
            value = finite_number(frame["Volume"].iloc[-1] / average) if average > 0 else None
        if value is None:
            diagnostics.add((node["field"], "dated_snapshot_field_unavailable"))
            return None
        if "equal" in node:
            return value == node["equal"]
        if "exclude" in node:
            return str(value).strip().rstrip("%") not in node["exclude"]
        value = finite_number(value)
        if value is None:
            return None
        return all((value >= node["min"] if node.get("min") is not None else True,
                    value <= node["max"] if node.get("max") is not None else True,
                    value > node["strict_min"] if node.get("strict_min") is not None else True,
                    abs(value) <= node["abs_max"] if node.get("abs_max") is not None else True))
    spec = normalize_condition_spec(node)
    diagnostic_kind = str(node.get("kind") or spec["condition"])
    history_context_conditions = {"relative_strength", "rs_new_high", "average_turnover", "adr_percent",
                                  "price_range", "listing_age_days", "days_since_earnings", "absolute_volume",
                                  "market_cap", "free_float_market_cap", "pe_ratio"}
    requires_aligned_history = spec["condition"] not in CONTEXT_CONDITION_REGISTRY or spec["condition"] in history_context_conditions
    if spec["condition"] == "field_comparison":
        history_fields = {"close", "open", "high", "low", "volume_lakh", "sma_20", "sma_50", "sma_200",
                          "high_52w", "low_52w", "return_1m", "return_1y", "return_3y", "return_5y",
                          "return_ytd", "daily_volatility", "annualized_volatility", "market_cap_crore"}
        operands = {str(spec.get("field", "")).lower()}
        if isinstance(spec.get("value"), dict):
            operands.add(str(spec["value"].get("field", "")).lower())
        requires_aligned_history = bool(operands & history_fields)
    if frame is not None and requires_aligned_history and (frame.empty or frame["Date"].iloc[-1].strftime("%Y-%m-%d") != as_of):
        diagnostics.add((diagnostic_kind, "stock_history_not_aligned_to_screen_date"))
        return None
    if frame is None:
        value = snapshot_rule(s, spec, as_of)
        if value is not None:
            return value
        if spec["condition"] in {"listing_age_days", "days_since_earnings"}:
            marker = pd.to_datetime(s.get("listing_date" if spec["condition"] == "listing_age_days" else "latest_earnings_date"), errors="coerce")
            benchmark = context.get("benchmarks", {}).get("NIFTY_50")
            if s.get("as_of_date") == as_of and not pd.isna(marker) and benchmark is not None and not benchmark.empty and marker >= benchmark["Date"].min():
                sessions = int(((benchmark["Date"] > marker) & (benchmark["Date"] <= pd.Timestamp(as_of))).sum())
                return _comparison(sessions, spec["comparison"], spec["days"])
            diagnostics.add((diagnostic_kind, "session_calendar_or_dated_marker_unavailable"))
            return None
        if spec["condition"] not in CONTEXT_CONDITION_REGISTRY and spec["condition"] != "field_comparison":
            diagnostics.add((diagnostic_kind, "stock_ohlcv_history_unavailable"))
            return None
        close = finite_number(s.get("close"))
        if s.get("as_of_date") != as_of or (requires_aligned_history and close is None):
            diagnostics.add((diagnostic_kind, "stock_history_unavailable_for_date"))
            return None
        # Snapshot-only context fields (for example EPS or dividend yield) do
        # not need a stock history file.  A valid one-row carrier lets the
        # shared evaluator read the dated stock snapshot without inventing a
        # market value; history-dependent operands are rejected above.
        close = close if close is not None else 1.0
        rows = [{"Date":as_of,"Open":s.get("open") or close,"High":s.get("high") or close,"Low":s.get("low") or close,"Close":close,"Volume":s.get("volume") or 0}]
    else:
        rows = frame
    if frame is not None:
        expression = _evaluate_expression(frame, node, delivery, {**context,"stock":s,"delivery_history":delivery,"screen_date":as_of})
        outcome = {"status":expression["status"],"conditions":_leaf_results(expression)}
    else:
        outcome = evaluate_history(rows,node,as_of,delivery,{**context,"stock":s,"screen_date":as_of})
    if outcome["status"] == "unavailable":
        reason = outcome["conditions"][0]["details"]["reason"]
        diagnostics.add((diagnostic_kind, reason))
        return None
    return outcome["status"] == "match"


def stock_row(s, ratings):
    fields = {"listingDate":"listing_date", "series":"listing_series", "changePct":"change_percent", "rvol":"relative_volume_20", "marketCapCrore":"market_cap_crore", "peRatio":"pe_ratio", "epsTtm":"eps_ttm", "dividendYieldPct":"dividend_yield_percent", "rsi14":"rsi14", "adr20Pct":"adr_percent_20", "atr14":"atr14", "dist52wHighPct":"distance_from_52w_high_percent", "dist52wLowPct":"distance_from_52w_low_percent", "distAthPct":"percent_from_ath", "earningsDate":"latest_earnings_date", "deliveryPct":"delivery_percent", "isFno":"fno_eligible", "circuitLimit":"circuit_limit", "roePct":"roe_percent", "rocePct":"roce_percent", "opmTtmPct":"operating_margin_ttm_percent", "debtToEquity":"debt_to_equity", "pegRatio":"peg_ratio", "salesGrowth5yPct":"sales_growth_5_years_percent", "epsLastYear":"eps_last_year", "epsTwoYearsBack":"eps_2_years_back", "surveillanceAvailable":"surveillance_available", "surveillanceAsOfDate":"surveillance_as_of_date", "surveillanceFetchedAt":"surveillance_fetched_at", "isAsm":"is_asm", "asmStage":"asm_stage", "isGsm":"is_gsm", "gsmStage":"gsm_stage"}
    fields["vwapAsOfDate"] = "vwap_as_of_date"
    fields.update({
        "promoterHoldingPct": "promoter_holding_percent",
        "publicHoldingPct": "public_holding_percent",
        "numberOfShareholders": "number_of_shareholders",
        "faceValue": "face_value",
        "totalIncomeLakh": "total_income_in_lakhs",
        "totalExpenseLakh": "total_expense_in_lakhs",
        "profitBeforeTaxLakh": "profit_before_tax_in_lakhs",
        "totalTaxExpensesLakh": "total_tax_expenses_in_lakhs",
        "netProfitLakh": "net_profit_in_lakhs",
        "totalEquityLakh": "total_equity_in_lakhs",
        "totalAssetsLakh": "total_assets_in_lakhs",
        "currentAssetsLakh": "current_assets_in_lakhs",
        "currentLiabilitiesLakh": "current_liabilities_in_lakhs",
        "nonCurrentLiabilitiesLakh": "non_current_liabilities_in_lakhs",
        "operatingCashFlowLakh": "operating_cash_flow_in_lakhs",
        "investingCashFlowLakh": "investing_cash_flow_in_lakhs",
        "netCashFlowLakh": "net_cash_flow_in_lakhs",
        "totalRevenueLakh": "total_revenue_in_lakhs",
        "nonCurrentAssetsLakh": "non_current_assets_in_lakhs",
        "totalLiabilitiesLakh": "total_liabilities_in_lakhs",
        "interestCoverage": "interest_coverage",
        "dividendPerShare": "dividend_per_share_latest",
        "vwap": "vwap",
        "allTimeHigh": "all_time_high",
        "allTimeLow": "all_time_low",
        "return5yPct": "return_5y",
    })
    row = {k:s.get(v) for k,v in fields.items()}
    row.update({k:s.get(k) for k in ("symbol","name","open","high","low","close","volume")})
    symbol_ratings = ratings.get(s["symbol"], {})
    row.update(sector=s.get("sector") or "Unclassified", industry=s.get("industry") or "Unclassified", rupeeVolumeCrore=(s.get("rupee_volume") or 0)/1e7,
               rsRating=symbol_ratings.get("front_weighted"), rsRating1m=symbol_ratings.get("one_month"),
               rsRating3m=symbol_ratings.get("three_month"), rsRating6m=symbol_ratings.get("six_month"),
               rsRating12m=symbol_ratings.get("twelve_month"),
               daysSinceEarnings=None, fnoBan=False)
    for ma in ("sma20","sma50","sma200","ema20","ema50","ema200"):
        row[ma]=s.get(ma)
    row["dataCompleteness"] = round(100 * sum(v is not None for v in row.values()) / len(row))
    return row


def page_response(response, request):
    sort = request.get("sort") or {}
    field = sort.get("field", "symbol")
    rows = sorted(response["rows"], key=lambda r:(r.get(field) is not None,r.get(field) if r.get(field) is not None else 0), reverse=sort.get("direction")=="desc")
    page = max(1, int(request.get("page", 1)))
    size = max(1, min(100, int(request.get("pageSize", 15))))
    return {**response,"rows":rows[(page-1)*size:page*size],"page":page,"pageSize":size}


def run(request, root=ROOT, cache=None):
    dataset_revision = request.get('datasetRevision')
    if dataset_revision:
        if not isinstance(dataset_revision,str) or not re.fullmatch(r'[a-f0-9]{64}',dataset_revision):
            raise ValueError('Invalid dataset revision')
        root = root/'.scanner_cache/revisions'/dataset_revision
        if not (root/'scanner_revision.json').exists():
            raise ValueError('Requested dataset revision is unavailable. Refresh the dataset.')
    as_of = request["asOfDate"]
    date.fromisoformat(as_of)
    if dataset_revision and cache is None:
        from scanner_cache import ScannerCache
        cache = ScannerCache()
    if cache is not None:
        cache.refresh(root)
        key = json.dumps({k:v for k,v in request.items() if k not in {"page","pageSize","sort"}},sort_keys=True)
        if key in cache.results:
            return page_response(cache.results[key], request)
        if as_of not in cache.contexts:
            cache.contexts[as_of] = _load_context(root, as_of)
        context = cache.contexts[as_of]
    else:
        context = _load_context(root, as_of)
    if context.get("financial_history_as_of") and as_of > context["financial_history_as_of"]:
        raise ValueError("Requested date is after the latest published NSE session.")
    if as_of != context.get("financial_history_as_of") and not (root/"ohlcv_data").is_dir():
        raise ValueError("Historical screening requires the local stock OHLCV cache; it is absent in this checkout.")
    universe = {"mainboard":"UNIVERSE", "nifty50":"NIFTY50", "nifty500":"NIFTY500", "midsmall400":"MIDSMALL400", "custom":"UNIVERSE"}[request["universe"]]
    explicit = request.get("customSymbols") if request["universe"] == "custom" else None
    if request["universe"] == "custom" and not explicit:
        raise ValueError("Custom universe requires at least one symbol")
    selected = _resolve_universe(context, universe, explicit)
    wanted = set(selected) if selected is not None else None
    stocks = [s for symbol,s in context["stocks"].items() if (wanted is None or symbol in wanted) and s.get("default_screener_eligible",True)]
    text_query = str(request.get("textQuery") or "").strip()
    expression = compile_query(text_query) if text_query else frontend_expression(request["expressionTree"])
    # Both public delivery conditions need dated history.  The spike condition
    # is named ``DELIVERY_PCT_SPIKE`` while the latest-session condition uses
    # ``DELIVERY_PERCENT``; checking only the latter quietly made spike
    # screens unavailable.
    delivery = _load_delivery_history(root/"delivery_history_data", selected, root/"eod2_delivery_history_data") if _needs_delivery(expression) else {}
    matched, counts, unresolved = [], Counter(), 0
    for s in stocks:
        path = root/"ohlcv_data"/f"{s['symbol']}.csv"
        frame = cache.frame(root, s['symbol'], as_of) if cache is not None else normalize_history(pd.read_csv(path), as_of) if path.exists() else None
        diagnostics=set()
        value=evaluate(expression,s,frame,context,as_of,diagnostics,delivery.get(s["symbol"],[]))
        if value is True and frame is None and finite_number(s.get("close")) is None:
            value=None
            diagnostics.add(("close", "current_stock_price_unavailable"))
        counts.update(diagnostics)
        if value is None:
            unresolved += 1
        if value is True:
            row=stock_row(s,context["rs_ratings"] if context.get("rs_ratings_as_of")==as_of else {})
            row["fnoBan"]=bool(context["fno_ban_symbols"].get(s["symbol"])) if context.get("fno_ban_trade_date")==as_of else None
            if "financial_history" in context:
                row["peRatio"] = financial_value(context, s, {"condition":"pe_ratio"}, date.fromisoformat(as_of), finite_number(s.get("market_cap_crore")))[0]
            if frame is not None:
                history=frame[pd.to_datetime(frame["Date"])<=pd.Timestamp(as_of)]
                if history.empty:
                    continue
                last=history.iloc[-1]
                for field in ("open","high","low","close","volume"):
                    row[field]=float(last[field.title()])
                row["rvol"] = None
                if len(history) >= 21:
                    avg = history["Volume"].iloc[-21:-1].mean()
                    row["rvol"] = finite_number(last["Volume"] / avg) if avg > 0 else None
                row["changePct"] = finite_number((last["Close"] / history["Close"].iloc[-2] - 1) * 100) if len(history) >= 2 else None
                if s.get("as_of_date") != as_of:
                    # A current row must not be displayed as historical metrics.
                    for field in (
                        "marketCapCrore","peRatio","rvol","rsi14","adr20Pct","atr14",
                        "dist52wHighPct","dist52wLowPct","distAthPct","deliveryPct",
                        "sma20","sma50","sma200","roePct","rocePct","opmTtmPct",
                        "debtToEquity","pegRatio","salesGrowth5yPct","epsLastYear",
                        "epsTwoYearsBack","totalRevenueLakh","nonCurrentAssetsLakh",
                        "totalLiabilitiesLakh","interestCoverage","dividendPerShare",
                        "vwap","vwapAsOfDate","allTimeHigh","allTimeLow","return5yPct",
                        "promoterHoldingPct","publicHoldingPct","numberOfShareholders","faceValue",
                        "totalIncomeLakh","totalExpenseLakh","profitBeforeTaxLakh","totalTaxExpensesLakh",
                        "netProfitLakh","totalEquityLakh","totalAssetsLakh","currentAssetsLakh",
                        "currentLiabilitiesLakh","nonCurrentLiabilitiesLakh","operatingCashFlowLakh",
                        "investingCashFlowLakh","netCashFlowLakh","epsTtm","dividendYieldPct",
                    ):
                        row[field]=None
            # stock_row starts from the current snapshot. Recalculate after
            # history substitution and current-only field sanitization so the
            # percentage describes the row that is actually returned.
            row.pop("dataCompleteness", None)
            row["dataCompleteness"] = round(100 * sum(value is not None for value in row.values()) / len(row))
            matched.append(row)
    sort=request.get("sort") or {}
    field=sort.get("field","symbol")
    matched.sort(key=lambda r:(r.get(field) is not None,r.get(field) if r.get(field) is not None else 0),reverse=sort.get("direction")=="desc")
    page=max(1,int(request.get("page",1)))
    size=max(1,min(100,int(request.get("pageSize",15))))
    warnings=[]
    if not (root/"ohlcv_data").is_dir():
        warnings.append("Stock OHLCV cache is absent. Snapshot metrics are evaluated; history-dependent conditions are unavailable.")
    if unresolved:
        warnings.append(f"{unresolved} equities could not be resolved because required data is unavailable.")
    response = {"resolvedSession":{"date":as_of,"sessionId":f"NSE-{as_of.replace('-','')}-FINAL","status":"closed","isHistorical":as_of!=context.get("financial_history_as_of")},"immutableRevision":dataset_revision or f"local_{as_of}","rows":matched,"matchCount":len(matched),"totalUniverseCount":len(stocks),"page":page,"pageSize":size,"perConditionCoverage":{},"unavailableDiagnostics":[{"conditionId":kind,"reason":reason,"affectedCount":count} for (kind,reason),count in counts.items()],"warnings":warnings}
    if cache is not None:
        cache.remember(key, response)
        cache.save_frames(root)
    return page_response(response, request)


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin)),allow_nan=False))
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error":str(error)}))
        sys.exit(1)
