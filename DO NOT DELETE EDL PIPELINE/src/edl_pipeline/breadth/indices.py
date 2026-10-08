"""Publish normalized history for every index fetched by the EDL pipeline."""

from datetime import datetime, timezone
from collections import Counter
import json
import math
import numbers
from pathlib import Path
from tempfile import NamedTemporaryFile

import pandas as pd


INDEX_COLUMNS = ("Open", "High", "Low", "Close", "Volume")


def safe_index_symbol(symbol, index_id=None, disambiguate=False):
    """Match the filename normalization used by fetch_indices_ohlcv.py."""
    safe_symbol = "".join(
        character if character.isalnum() else "_"
        for character in str(symbol)
    )
    safe_index_id = "".join(
        character if character.isalnum() else "_"
        for character in str(index_id)
    )
    return (
        f"{safe_symbol}__{safe_index_id}"
        if disambiguate
        else safe_symbol
    )


def _round_value(value, digits):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        if pd.isna(value) or not math.isfinite(float(value)):
            return None
        return round(float(value), digits)
    return value


def _save_json(path, data):
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


def _normalize_index_history(path, output_sessions, rounding_digits):
    frame = pd.read_csv(path)
    required = {"Date", "Close"}
    if not required.issubset(frame.columns):
        missing = ", ".join(sorted(required - set(frame.columns)))
        raise ValueError(f"missing required columns: {missing}")

    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
    for column in INDEX_COLUMNS:
        if column not in frame:
            frame[column] = None
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
        frame[column] = frame[column].where(
            frame[column].map(lambda value: pd.isna(value) or math.isfinite(value))
        )
    frame = (
        frame.dropna(subset=["Date", "Close"])
        .drop_duplicates("Date", keep="last")
        .sort_values("Date")
    )
    frame["Change"] = frame["Close"].diff()
    frame["ChangePct"] = frame["Close"].pct_change(fill_method=None) * 100.0
    if output_sessions:
        frame = frame.tail(output_sessions)

    records = []
    for row in frame.itertuples(index=False):
        records.append(
            {
                "date": row.Date,
                "open": _round_value(row.Open, rounding_digits),
                "high": _round_value(row.High, rounding_digits),
                "low": _round_value(row.Low, rounding_digits),
                "close": _round_value(row.Close, rounding_digits),
                "volume": _round_value(row.Volume, rounding_digits),
                "change": _round_value(row.Change, rounding_digits),
                "change_pct": _round_value(row.ChangePct, rounding_digits),
            }
        )
    return records


def generate_all_index_history(
    index_rows,
    indices_dir,
    output_path,
    output_sessions=250,
    rounding_digits=6,
    generated_at=None,
):
    """Write table-ready OHLCV and return history for every available index."""
    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    indices_root = Path(indices_dir)
    processed = []
    missing_history = []
    invalid_history = []

    safe_symbol_counts = Counter(
        safe_index_symbol(index.get("Symbol") or "") for index in index_rows
    )

    for index in sorted(
        index_rows,
        key=lambda item: (
            str(item.get("Symbol") or ""),
            str(item.get("IndexID") or ""),
        ),
    ):
        symbol = str(index.get("Symbol") or "").strip()
        if not symbol:
            invalid_history.append({"symbol": None, "error": "missing symbol"})
            continue
        safe_symbol = safe_index_symbol(symbol)
        csv_path = indices_root / (
            f"{safe_index_symbol(symbol, index.get('IndexID'), safe_symbol_counts[safe_symbol] > 1)}.csv"
        )
        if not csv_path.exists():
            missing_history.append(symbol)
            continue
        try:
            records = _normalize_index_history(
                csv_path,
                output_sessions,
                rounding_digits,
            )
        except Exception as error:
            invalid_history.append({"symbol": symbol, "error": str(error)})
            continue
        if not records:
            invalid_history.append({"symbol": symbol, "error": "empty normalized history"})
            continue

        processed.append(
            {
                "symbol": symbol,
                "name": index.get("IndexName") or symbol,
                "index_id": index.get("IndexID"),
                "exchange": index.get("Exchange"),
                "segment": index.get("Segment"),
                "instrument": index.get("Instrument"),
                "current_snapshot": _round_value({
                    "open": index.get("Open"),
                    "high": index.get("High"),
                    "low": index.get("Low"),
                    "ltp": index.get("Ltp"),
                    "change": index.get("Chng"),
                    "change_pct": index.get("PChng"),
                    "volume": index.get("Volume"),
                    "high_52w": index.get("52W_High"),
                    "low_52w": index.get("52W_Low"),
                }, rounding_digits),
                "records": records,
            }
        )

    artifact = {
        "generated_at": generated_at,
        "source": {
            "universe": "Dhan ScanX IDX snapshot",
            "history": "Dhan openweb-ticks getDataH normalized index OHLCV cache",
        },
        "output_sessions_per_index": output_sessions,
        "quality": {
            "available_indices": len(index_rows),
            "processed_indices": len(processed),
            "missing_history_count": len(missing_history),
            "missing_history_symbols": missing_history,
            "invalid_history_count": len(invalid_history),
            "invalid_history": invalid_history,
        },
        "indices": processed,
    }
    _save_json(output_path, artifact)
    return artifact
