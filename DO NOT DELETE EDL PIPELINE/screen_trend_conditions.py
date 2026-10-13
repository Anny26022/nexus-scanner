"""Run a daily trend screen against the locally cached OHLCV universe."""

import argparse
import csv
import gzip
import io
import json
from collections import deque
from pathlib import Path
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.scanner.history import load_snapshot
from edl_pipeline.scanner.context import normalize_condition_spec
from edl_pipeline.scanner.presets import get_preset, list_presets, validate_preset_library
from edl_pipeline.scanner.query import compile_query
from edl_pipeline.scanner.trend import CONDITION_REGISTRY, evaluate_universe, evaluate_universe_range


def _read_json(path):
    if not path.exists():
        return None
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _benchmark_keys(index):
    values = (index.get("symbol"), index.get("name"))
    keys = {str(value).upper().replace(" ", "_") for value in values if value}
    if "NIFTY_50" in keys or "NIFTY50" in keys:
        keys.add("NIFTY_50")
    if "NIFTY_MIDSMALLCAP_400" in keys or "NIFTY_MIDSMALL_400" in keys:
        keys.add("NIFTY_MIDSMALL400")
    return keys


def _load_context(root, as_of_date=None, stock_path=None, index_path=None, breadth_path=None):
    stocks = _read_json(stock_path or (root / "all_stocks_fundamental_analysis.json.gz")) or []
    index_artifact = _read_json(index_path or (root / "all_indices_history_v2.json.gz")) or {}
    benchmarks = {}
    for index in index_artifact.get("indices", []):
        records = pd.DataFrame(index.get("records", []))
        if records.empty or not {"date", "close"}.issubset(records):
            continue
        records["Date"] = pd.to_datetime(records["date"], errors="coerce")
        records["close"] = pd.to_numeric(records["close"], errors="coerce")
        records = records.dropna(subset=("Date", "close"))
        for key in _benchmark_keys(index):
            benchmarks[key] = records
    breadth_artifact = _read_json(breadth_path or (root / "market_breadth_v2.json.gz")) or {}
    records = breadth_artifact.get("records") or []
    latest = records[-1:] or []
    current_session = latest[0].get("date") if latest else None
    saved = load_snapshot(root / "scanner_history_data", as_of_date)
    if saved:
        stocks = saved.get("stocks") or []
        for stock in stocks:
            stock["as_of_date"] = as_of_date
        latest = [saved["breadth"]] if saved.get("breadth") else []
    from edl_pipeline.breadth.gates import gate_metrics
    breadth = {}
    source_universes = breadth_artifact.get("universes") or {"all_active": {"records": records}}
    for key, payload in source_universes.items():
        rows = payload.get("records", []) if isinstance(payload, dict) else []
        if rows:
            breadth[key] = gate_metrics(rows[-1])
    if saved:
        saved_universes = saved.get("breadth_universes") or {}
        if saved_universes:
            breadth = {key: gate_metrics(row) for key, row in saved_universes.items()}
        elif saved.get("breadth"):
            # Older snapshots predate named breadth universes. They remain
            # point-in-time safe for their all-active breadth value.
            breadth = {"all_active": gate_metrics(saved["breadth"])}
        else:
            breadth = {}
    else:
        latest = [breadth_artifact.get("records", [])[-1]] if breadth_artifact.get("records") else latest
    ban = (saved or {}).get("fno_ban") or _read_json(root / "nse_fno_ban.json") or _read_json(root / "nse_fno_ban.json.gz") or {}
    fno_ban_symbols = {str(symbol).upper(): True for symbol in ban.get("symbols", [])}
    rs_artifact = _read_json(root / "rs_rating_daily.json") or _read_json(root / "rs_rating_daily.json.gz") or {}
    financials = _read_json(root / "quarterly_financial_history.json.gz") or _read_json(root / "quarterly_financial_history.json")
    financial_history = {}
    if financials is not None:
        for row in financials.get("records", []):
            financial_history.setdefault(row.get("symbol"), []).append(row)
    context_financials = {"financial_history": financial_history, "financial_history_as_of": current_session} if financials is not None else {}
    return {**context_financials, "stocks": {item.get("symbol"): item for item in stocks if item.get("symbol")}, "benchmarks": benchmarks, "breadth": breadth, "breadth_as_of": latest[0].get("date") if latest else None, "fno_ban_symbols": fno_ban_symbols, "fno_ban_available": ban.get("available", False), "fno_ban_trade_date": ban.get("trade_date"), "rs_ratings": rs_artifact.get("ratings", rs_artifact), "rs_ratings_as_of": rs_artifact.get("as_of_date"), "membership_snapshot_available": bool(saved) or not as_of_date or as_of_date == current_session}


def _symbols_from_text(value):
    return {part.strip().upper() for part in str(value or "").replace("\n", ",").split(",") if part.strip()}


def _resolve_universe(context, universe, explicit_symbols):
    """Resolve the bundle's named stock universes against dated membership data."""
    if explicit_symbols:
        return sorted(explicit_symbols)
    universe = str(universe or "UNIVERSE").upper()
    if universe == "UNIVERSE":
        return None
    if not context.get("membership_snapshot_available"):
        raise ValueError("The requested historical date has no dated index-membership snapshot.")
    targets = {
        "NIFTY50": {"NIFTY 50", "NIFTY50"},
        "MIDSMALL400": {"NIFTY MIDSMALLCAP 400", "NIFTY MIDSMALL 400", "MIDSMALL400"},
        "NIFTY500": {"NIFTY 500", "NIFTY500"},
    }.get(universe)
    if targets is None:
        raise ValueError(f"Unsupported scan universe: {universe}")
    return sorted(
        symbol for symbol, stock in context.get("stocks", {}).items()
        if {str(value).upper() for value in stock.get("index_memberships", [])} & targets
    )


def _range_sessions(root, start, end):
    path = root / "indices_ohlcv_data" / "NIFTY.csv"
    if not path.exists():
        raise ValueError("Range screens need the cached NIFTY index history.")
    dates = pd.to_datetime(pd.read_csv(path)["Date"], errors="coerce").dropna().dt.strftime("%Y-%m-%d")
    return [value for value in dates if start <= value <= end]


def _requires_delivery(expression):
    """Avoid opening delivery caches unless a delivery rule is actually used."""
    if isinstance(expression, list):
        return any(_requires_delivery(item) for item in expression)
    if not isinstance(expression, dict):
        return False
    try:
        if normalize_condition_spec(expression).get("condition") in {"delivery_percent_spike", "delivery_percent"}:
            return True
    except (TypeError, ValueError):
        pass
    return any(_requires_delivery(value) for key, value in expression.items() if key in {"conditions", "children", "expression", "child"})


def _delivery_records(records, allowed=None, windows=None):
    """Filter an evaluation view; never infer record dates from filenames."""
    for item in records:
        symbol = str(item.get("symbol") or "").upper() if isinstance(item, dict) else ""
        day = str(item.get("date") or "") if isinstance(item, dict) else ""
        if (symbol and day and (allowed is None or symbol in allowed)
                and (windows is None or day in windows.get(symbol, ()))):
            yield item


def _load_delivery_history(path, symbols=None, eod2_path=None, *, windows=None, cached_records=None, csv_payloads=None):
    """Load official delivery first; EOD2 fills only historical gaps by date.

    Optional windows bound evaluation only. Cached records reuse payloads
    already read while freezing the complete, unchanged backend history.
    """
    allowed = set(symbols) if symbols else None
    history = {}
    paths = (
        sorted([*path.glob("????-??-??.json"), *path.glob("????-??-??.json.gz")])
        if path.is_dir() else [path]
    )
    for item_path in paths:
        if not item_path.exists():
            continue
        try:
            if cached_records is not None and item_path in cached_records:
                records = cached_records[item_path]
            else:
                opener = gzip.open if item_path.suffix == ".gz" else open
                with opener(item_path, "rt", encoding="utf-8") as handle:
                    records = json.load(handle).get("records", [])
        except (OSError, ValueError, AttributeError):
            continue
        for item in _delivery_records(records, allowed, windows):
            symbol = str(item["symbol"]).upper()
            history.setdefault(symbol, {})[str(item["date"])] = item
    # The EOD2 bootstrap is weekly and historical.  It never replaces a date
    # for which the direct official NSE cache has a record.
    if eod2_path and eod2_path.is_dir():
        files = ([eod2_path / f"{symbol}.csv" for symbol in allowed] if allowed else eod2_path.glob("*.csv"))
        for item_path in files:
            symbol = item_path.stem.upper()
            if not item_path.exists():
                continue
            try:
                source = (io.StringIO(csv_payloads[item_path].decode("utf-8"), newline="")
                          if csv_payloads is not None and item_path in csv_payloads
                          else item_path.open(newline="", encoding="utf-8"))
                with source as handle:
                    if windows is not None and all(day in history.get(symbol, {}) for day in windows.get(symbol, ())):
                        # Keep UTF-8/parser failures fatal even when no fallback
                        # row is needed. Avoid Python dictionaries, not checks.
                        deque(csv.reader(handle), maxlen=0)
                        continue
                    for row in csv.DictReader(handle):
                        symbol = item_path.stem.upper()
                        day = str(row.get("Date") or "")
                        value = row.get("delivery_percent")
                        if not day or value in {None, ""}:
                            continue
                        if windows is not None and day not in windows.get(symbol, ()):
                            continue
                        history.setdefault(symbol, {}).setdefault(day, {
                            "symbol": symbol, "date": day, "series": row.get("Series") or "EQ",
                            "traded_quantity": row.get("traded_quantity"),
                            "deliverable_quantity": row.get("deliverable_quantity"),
                            "delivery_percent": value, "source": "eod2",
                        })
            except OSError:
                continue
    return {symbol: list(by_date.values()) for symbol, by_date in history.items()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, help="JSON request with a non-empty conditions array or preset ID")
    parser.add_argument("--preset", help="Run a vendored preset by lib-* ID or exact name")
    parser.add_argument("--query", help="Compile and run a Market-Lens-style text query")
    parser.add_argument("--output", type=Path, help="Write JSON result here; otherwise print it")
    parser.add_argument("--as-of-date", help="Use the latest session on or before YYYY-MM-DD")
    parser.add_argument("--as-of-from", help="Run independently for each NIFTY session from YYYY-MM-DD")
    parser.add_argument("--as-of-to", help="Run independently for each NIFTY session through YYYY-MM-DD")
    parser.add_argument("--symbols", help="Comma/newline-separated symbol universe")
    parser.add_argument("--universe", choices=("UNIVERSE", "NIFTY50", "MIDSMALL400", "NIFTY500"))
    parser.add_argument("--delivery-history", type=Path, help="JSON delivery-history artifact with a records array")
    parser.add_argument("--stock-snapshot", type=Path, help="Canonical stock snapshot (.json or .json.gz)")
    parser.add_argument("--index-history", type=Path, help="Index history artifact (.json or .json.gz)")
    parser.add_argument("--breadth", type=Path, help="Market breadth artifact (.json or .json.gz)")
    parser.add_argument("--fno-ban", type=Path, help="Official NSE F&O ban snapshot JSON")
    parser.add_argument("--rs-ratings", type=Path, help="Daily RS-rating snapshot JSON")
    parser.add_argument("--include-non-matches", action="store_true")
    parser.add_argument("--list-conditions", action="store_true")
    parser.add_argument("--list-presets", action="store_true")
    args = parser.parse_args(argv)
    if args.list_conditions:
        print(json.dumps(CONDITION_REGISTRY, indent=2, sort_keys=True))
        return 0
    if args.list_presets:
        print(json.dumps(list_presets(), indent=2, ensure_ascii=False))
        return 0
    if sum(bool(value) for value in (args.request, args.preset, args.query)) > 1:
        parser.error("Use exactly one of --request, --preset, or --query")
    if not args.request and not args.preset and not args.query:
        parser.error("--request, --preset, or --query is required unless listing definitions")
    request = json.loads(args.request.read_text()) if args.request else {}
    preset_id = args.preset or request.get("preset") or request.get("preset_id")
    preset = get_preset(preset_id) if preset_id else None
    if preset and (request.get("expression") or request.get("conditions")):
        parser.error("A preset request must not also supply expression or conditions")
    conditions = compile_query(args.query) if args.query else (preset or {}).get("expression") or request.get("expression", request.get("conditions"))
    if not conditions:
        parser.error("request.expression or request.conditions must be non-empty")
    validate_preset_library(CONDITION_REGISTRY)
    as_of_date = args.as_of_date or request.get("as_of_date")
    context = _load_context(ROOT, as_of_date, args.stock_snapshot, args.index_history, args.breadth)
    if args.fno_ban:
        artifact = _read_json(args.fno_ban) or {}
        context["fno_ban_symbols"] = {str(symbol).upper(): True for symbol in artifact.get("symbols", [])}
        context["fno_ban_available"] = artifact.get("available", True)
        context["fno_ban_trade_date"] = artifact.get("trade_date")
    if args.rs_ratings:
        artifact = _read_json(args.rs_ratings) or {}
        context["rs_ratings"] = artifact.get("ratings", artifact)
        context["rs_ratings_as_of"] = artifact.get("as_of_date")
    explicit_symbols = _symbols_from_text(args.symbols or request.get("symbols"))
    universe = args.universe or request.get("scan_universe") or request.get("scanUniverse") or "UNIVERSE"
    selected_symbols = _resolve_universe(context, universe, explicit_symbols)
    delivery_history = {}
    if _requires_delivery(conditions):
        delivery_path = args.delivery_history or (ROOT / "delivery_history_data")
        delivery_history = _load_delivery_history(
            delivery_path, selected_symbols,
            None if args.delivery_history else ROOT / "eod2_delivery_history_data",
        )
    include_non_matches = args.include_non_matches or bool(request.get("include_non_matches"))
    from_date = args.as_of_from or request.get("as_of_from") or request.get("asOfFrom")
    to_date = args.as_of_to or request.get("as_of_to") or request.get("asOfTo")
    if bool(from_date) != bool(to_date):
        parser.error("--as-of-from and --as-of-to must be supplied together")
    if from_date:
        dates = _range_sessions(ROOT, from_date, to_date)
        result = evaluate_universe_range(
            ROOT / "ohlcv_data", conditions, dates, include_non_matches, delivery_history,
            lambda session: _load_context(ROOT, session, args.stock_snapshot, args.index_history, args.breadth),
            selected_symbols,
        )
    else:
        result = evaluate_universe(
            ROOT / "ohlcv_data", conditions, as_of_date, include_non_matches,
            delivery_history, context, selected_symbols,
        )
    if preset:
        result["preset"] = {
            "id": preset["id"], "name": preset["name"], "category": preset["category"],
            "horizon": preset["horizon"], "description": preset["description"],
            "rules": preset["rules"],
        }
    rendered = json.dumps(result, indent=2, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
