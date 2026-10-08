"""End-to-end breadth artifact generation."""

from datetime import datetime, timezone
import json
import math
import numbers
from pathlib import Path
from tempfile import NamedTemporaryFile

import pandas as pd

from .aggregates import BreadthAccumulator
from .indicators import prepare_history
from .mbi import enrich_records
from .universe import build_universe_snapshot
from ohlcv_utils import symbol_csv_path


TRADINGVIEW_TABLE_SCHEMA = [
    {"label": "Date", "field": "date", "available": True},
    {"label": "4.5R", "field": "ratio_4_5", "available": True},
    {"label": "XP", "field": "xp", "available": True, "note": "public-formula proxy"},
    {
        "label": "EM",
        "field": "em",
        "available": False,
        "note": "proprietary source series is not publicly available",
    },
    {"label": "4.5Chg", "field": "change_4_5", "available": True},
    {"label": "20R(s)", "field": "ratio_20", "available": True},
    {"label": "20Chg", "field": "change_20", "available": True},
    {"label": "50R(s)", "field": "ratio_50", "available": True},
    {"label": "50Chg", "field": "change_50", "available": True},
    {"label": "52WH", "field": "new_52w_high_pct", "available": True},
    {"label": "52WL", "field": "new_52w_low_pct", "available": True},
    {"label": "4.5+", "field": "up_4_5_pct", "available": True},
    {"label": "4.5-", "field": "down_4_5_pct", "available": True},
    {"label": "10+", "field": "above_10_pct", "available": True},
    {"label": "20+", "field": "above_20_pct", "available": True},
    {"label": "50+", "field": "above_50_pct", "available": True},
    {"label": "200+", "field": "above_200_pct", "available": True},
    {"label": "Index", "field": "index_change_pct", "available": True},
]


def _save_json(path, data):
    """Write JSON atomically without coupling the calculation package to HTTP helpers."""
    resolved = Path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=resolved.parent,
        prefix=f".{resolved.name}.",
        suffix=".tmp",
    ) as handle:
        json.dump(data, handle, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        temporary = Path(handle.name)
    try:
        temporary.replace(resolved)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def load_index_closes(path):
    resolved = Path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Required index history is missing: {resolved}")
    frame = pd.read_csv(resolved)
    if "Date" not in frame or "Close" not in frame:
        raise ValueError(f"Required index history has no Date/Close columns: {resolved}")
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
    frame["Close"] = pd.to_numeric(frame["Close"], errors="coerce")
    frame["Close"] = frame["Close"].where(
        frame["Close"].map(lambda value: pd.isna(value) or math.isfinite(value))
    )
    frame = frame.dropna(subset=["Date", "Close"]).drop_duplicates("Date", keep="last")
    if frame.empty:
        raise ValueError(f"Required index history has no valid rows: {resolved}")
    return dict(zip(frame["Date"], frame["Close"]))


def _round_value(value, digits):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        if pd.isna(value) or not math.isfinite(float(value)):
            return None
        return round(float(value), digits)
    if isinstance(value, dict):
        return {key: _round_value(item, digits) for key, item in value.items()}
    return value


def _metadata_by_symbol(rows):
    """Use the same highest-market-cap duplicate selection as the universe snapshot."""
    result = {}
    for row in rows:
        symbol = str(row.get("Sym") or row.get("Symbol") or row.get("symbol") or "").strip()
        if not symbol:
            continue
        try:
            market_cap = float(row.get("Mcap", row.get("Market Cap(Cr.)", float("-inf"))))
        except (TypeError, ValueError):
            market_cap = float("-inf")
        previous = result.get(symbol)
        if previous is not None and market_cap <= previous["_market_cap"]:
            continue
        memberships = (row.get("index_memberships") or row.get("indexMemberships") or row.get("index_membership") or row.get("Index Memberships") or row.get("Index") or row.get("indices") or [])
        if isinstance(memberships, str):
            memberships = [item.strip() for item in memberships.split(",") if item.strip()]
        result[symbol] = {"sector": str(row.get("Sector") or row.get("sector") or "Unclassified"), "memberships": {str(item).upper().replace(" ", "") for item in memberships}, "_market_cap": market_cap}
    for metadata in result.values():
        metadata.pop("_market_cap", None)
    return result

UNIVERSE_MEMBERSHIPS = {
    "nifty50": {"NIFTY50"},
    "nifty500": {"NIFTY500"},
    "niftymidsmall400": {"NIFTYMIDSMALLCAP400", "NIFTYMIDSMALL400"},
}

def _round_records(records, digits):
    return [{key: _round_value(value, digits) for key, value in row.items()} for row in records]

def generate_market_breadth(
    universe_rows, ohlcv_dir, index_csv, methodology, output_path, snapshot_path,
    generated_at=None, sector_output_path=None, contribution_output_path=None, benchmark_panels=None,
):
    """Generate all-active, named-universe, sector and audit breadth artifacts."""
    methodology.validate(); generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    snapshot = build_universe_snapshot(universe_rows, methodology, generated_at); _save_json(snapshot_path, snapshot)
    metadata = _metadata_by_symbol(universe_rows)
    accumulators = {"all_active": BreadthAccumulator(methodology, include_contributions=True)}
    for key in UNIVERSE_MEMBERSHIPS: accumulators[key] = BreadthAccumulator(methodology, include_contributions=True)
    sectors = {}
    missing_history=[]; invalid_history=[]; processed_symbols=[]; root=Path(ohlcv_dir)
    for stock in snapshot["eligible"]:
        symbol=stock["symbol"]; csv_path=symbol_csv_path(root,symbol)
        if not csv_path.exists(): missing_history.append(symbol); continue
        try: prepared=prepare_history(pd.read_csv(csv_path), methodology)
        except Exception as error: invalid_history.append({"symbol":symbol,"error":str(error)}); continue
        if prepared.empty: invalid_history.append({"symbol":symbol,"error":"empty normalized history"}); continue
        processed_symbols.append(symbol); accumulators["all_active"].update(prepared,symbol)
        info=metadata.get(symbol,{})
        memberships=info.get("memberships",set())
        for key, required in UNIVERSE_MEMBERSHIPS.items():
            if memberships & required: accumulators[key].update(prepared,symbol)
        sector=info.get("sector") or "Unclassified"
        if sector != "Unclassified":
            sectors.setdefault(sector,BreadthAccumulator(methodology)).update(prepared,symbol)
    closes=load_index_closes(index_csv)
    def enriched(accumulator):
        rows=enrich_records(accumulator.records(),methodology,closes)
        return _round_records(rows[-methodology.output_sessions:] if methodology.output_sessions else rows, methodology.rounding_digits)
    universe_records={key: enriched(value) for key,value in accumulators.items()}
    records=universe_records["all_active"]
    universe_payload={key:{"label": {"all_active":"All Active","nifty50":"Nifty 50","nifty500":"Nifty 500","niftymidsmall400":"Nifty MidSmall 400"}[key],"records":value,"available":bool(value)} for key,value in universe_records.items()}
    artifact={"schema_version":3,"generated_at":generated_at,"methodology":methodology.to_dict(),"table_schema":TRADINGVIEW_TABLE_SCHEMA,"table_notes":{"selected_ma_type":methodology.default_ma_type,"default_index_symbol":"NIFTY","all_index_history_artifact":"all_indices_history_v2.json.gz","sector_history_artifact":"sector_breadth_v2.json.gz","contribution_artifact":"market_breadth_contributions_v2.json.gz"},"source":{"universe":"Dhan ScanX customscan/fetchdt snapshot","equity_history":"Dhan openweb-ticks getDataH normalized OHLCV cache","index_history":Path(index_csv).name},"quality":{"eligible_symbols":snapshot["eligible_count"],"processed_symbols":len(processed_symbols),"missing_history_count":len(missing_history),"missing_history_symbols":missing_history,"invalid_history_count":len(invalid_history),"invalid_history":invalid_history,"record_count":len(records)},"records":records,"universes":universe_payload,"benchmark_panels":benchmark_panels or {}}
    _save_json(output_path,artifact)
    if sector_output_path:
        sector_artifact={"schema_version":1,"generated_at":generated_at,"methodology":methodology.to_dict(),"sectors":[{"sector":sector,"records":enriched(acc)} for sector,acc in sorted(sectors.items())]}
        _save_json(sector_output_path,sector_artifact)
    if contribution_output_path:
        contribution_artifact={"schema_version":1,"generated_at":generated_at,"universes":{key:{"records":value.contribution_records()[-methodology.output_sessions:] if methodology.output_sessions else value.contribution_records()} for key,value in accumulators.items()}}
        _save_json(contribution_output_path,contribution_artifact)
    return artifact,snapshot
