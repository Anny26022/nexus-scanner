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
        json.dump(data, handle, indent=2, ensure_ascii=False, allow_nan=False)
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


def generate_market_breadth(
    universe_rows,
    ohlcv_dir,
    index_csv,
    methodology,
    output_path,
    snapshot_path,
    generated_at=None,
):
    """Generate the versioned breadth series and its exact universe snapshot."""
    methodology.validate()
    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    snapshot = build_universe_snapshot(universe_rows, methodology, generated_at)
    _save_json(snapshot_path, snapshot)

    accumulator = BreadthAccumulator(methodology)
    missing_history = []
    invalid_history = []
    processed_symbols = []
    ohlcv_root = Path(ohlcv_dir)

    for stock in snapshot["eligible"]:
        symbol = stock["symbol"]
        csv_path = symbol_csv_path(ohlcv_root, symbol)
        if not csv_path.exists():
            missing_history.append(symbol)
            continue
        try:
            prepared = prepare_history(pd.read_csv(csv_path), methodology)
        except Exception as error:
            invalid_history.append({"symbol": symbol, "error": str(error)})
            continue
        if prepared.empty:
            invalid_history.append({"symbol": symbol, "error": "empty normalized history"})
            continue
        accumulator.update(prepared)
        processed_symbols.append(symbol)

    records = enrich_records(
        accumulator.records(),
        methodology,
        load_index_closes(index_csv),
    )
    if methodology.output_sessions:
        records = records[-methodology.output_sessions:]
    rounded_records = [
        {key: _round_value(value, methodology.rounding_digits) for key, value in row.items()}
        for row in records
    ]

    artifact = {
        "generated_at": generated_at,
        "methodology": methodology.to_dict(),
        "table_schema": TRADINGVIEW_TABLE_SCHEMA,
        "table_notes": {
            "selected_ma_type": methodology.default_ma_type,
            "default_index_symbol": "NIFTY",
            "all_index_history_artifact": "all_indices_history_v2.json.gz",
        },
        "source": {
            "universe": "Dhan ScanX customscan/fetchdt snapshot",
            "equity_history": "Dhan openweb-ticks getDataH normalized OHLCV cache",
            # Publication metadata must be portable across runners. The
            # artifact name identifies the selected index history without
            # persisting an absolute workspace path.
            "index_history": Path(index_csv).name,
        },
        "quality": {
            "eligible_symbols": snapshot["eligible_count"],
            "processed_symbols": len(processed_symbols),
            "missing_history_count": len(missing_history),
            "missing_history_symbols": missing_history,
            "invalid_history_count": len(invalid_history),
            "invalid_history": invalid_history,
            "record_count": len(rounded_records),
        },
        "records": rounded_records,
    }
    _save_json(output_path, artifact)
    return artifact, snapshot
