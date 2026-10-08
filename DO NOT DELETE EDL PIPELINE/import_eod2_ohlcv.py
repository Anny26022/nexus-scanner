"""Optionally seed the local OHLCV cache from a checked-out EOD2 data repo.

EOD2 is a historical bootstrap only.  The normal ScanX/NSE sync continues to
own newer candles.  Matching by ISIN (rather than filenames or current ticker)
also keeps renamed securities attached to their own history.
"""

import csv
import io
import json
import os
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from multiprocessing import get_context
from pathlib import Path

from ohlcv_utils import OHLCV_FIELDS, merge_rows_by_date, read_ohlcv_csv, symbol_csv_path
from pipeline_utils import BASE_DIR, load_json, save_json


MASTER_FILE = "master_isin_map.json"
REPORT_FILE = "eod2_ohlcv_import_report.json"
DELIVERY_FIELDS = ["Date", "Series", "traded_quantity", "deliverable_quantity", "delivery_percent"]
FIELD_POLICIES = {
    "price_policy": "split_and_bonus_adjusted",
    "volume_policy": "exchange_traded_quantity_unadjusted",
    "delivery_policy": "exchange_reported_unadjusted",
}


def resolve_eod2_data_dir(value):
    """Accept either the eod2_data checkout or an EOD2 checkout containing it."""
    if not value:
        return None
    root = Path(value).expanduser()
    for candidate in (root, root / "src" / "eod2_data"):
        if (candidate / "daily").is_dir() and (candidate / "isin_symbol_map.json").is_file():
            return candidate
    raise ValueError(f"EDL_EOD2_DATA_DIR is not an EOD2 data checkout: {root}")


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def source_rows(path, start_date, end_date):
    """Read valid OHLCV rows (and, when present, their EOD2 delivery fields)."""
    rows = []
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            for item in csv.DictReader(handle):
                try:
                    session = date.fromisoformat(str(item.get("Date", "")))
                except ValueError:
                    continue
                if session < start_date or session > end_date:
                    continue
                values = {field: finite_number(item.get(field)) for field in ("Open", "High", "Low", "Close", "Volume")}
                opening, high, low, close, volume = (values[field] for field in ("Open", "High", "Low", "Close", "Volume"))
                if (
                    None in values.values() or volume < 0 or low <= 0
                    or not low <= min(opening, close) <= max(opening, close) <= high
                ):
                    continue
                delivery_quantity = finite_number(item.get("DLV_QTY"))
                row = {"Date": session.isoformat(), **values}
                # EOD2 publishes delivery quantity in the daily CSV.  Keep it
                # out of the OHLCV cache, but retain it while this source file
                # is already open so the weekly bootstrap incurs no extra I/O.
                if delivery_quantity is not None and 0 <= delivery_quantity <= volume and volume > 0:
                    row["DLV_QTY"] = delivery_quantity
                    row["Series"] = str(item.get("Series") or "EQ").upper()
                rows.append(row)
    except OSError:
        return []
    return rows


def eod2_rows_for_isin(data_dir, history, isin, parsed=None):
    """Collect renamed-file segments for one ISIN, with later segments winning."""
    rows = []
    for item in history.get(isin, []):
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        try:
            start_date = date.fromisoformat(item["from_date"])
            end_date = date.fromisoformat(item["to_date"])
        except (KeyError, TypeError, ValueError):
            continue
        path = data_dir / "daily" / f"{str(item['symbol']).lower()}.csv"
        if parsed is None:
            rows.extend(source_rows(path, start_date, end_date))
        else:
            if path not in parsed:
                parsed[path] = source_rows(path, date.min, date.max)
            rows.extend(row for row in parsed[path] if start_date.isoformat() <= row['Date'] <= end_date.isoformat())
    return merge_rows_by_date(rows)


def eod2_rows_for_security(data_dir, mapping, symbol, isin):
    """Return verified current-symbol history plus any renamed ISIN segments."""
    history = mapping.get("isin2hist", {})
    # A current ticker is commonly also an ISIN segment. Parse its CSV once,
    # while preserving segment precedence and the unbounded fallback.
    parsed = {}
    mapped = eod2_rows_for_isin(data_dir, history, isin, parsed)
    if mapping.get("sym2isin", {}).get(symbol) != isin:
        return mapped, 0

    current_file = data_dir / "daily" / f"{symbol.lower()}.csv"
    current = parsed.get(current_file)
    if current is None:
        current = source_rows(current_file, date.min, date.max)
    mapped_dates = {row["Date"] for row in mapped}
    additional_rows = sum(row["Date"] not in mapped_dates for row in current)
    return merge_rows_by_date([*current, *mapped]), additional_rows


def _csv_bytes(rows, fields):
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode()


def _write_csv_bytes_if_changed(path, data):
    try:
        if path.read_bytes() == data:
            return
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def write_csv_if_changed(path, rows, fields):
    """Render once; use those same bytes for comparison and any required write."""
    _write_csv_bytes_if_changed(path, _csv_bytes(rows, fields))


def write_delivery_csv(path, rows):
    write_csv_if_changed(path, rows, DELIVERY_FIELDS)


def delivery_rows(imported):
    rows = []
    for row in imported:
        volume, quantity = row.get("Volume"), row.get("DLV_QTY")
        if quantity is None or not volume:
            continue
        rows.append({
            "Date": row["Date"],
            "Series": row.get("Series", "EQ"),
            "traded_quantity": int(volume) if float(volume).is_integer() else volume,
            "deliverable_quantity": int(quantity) if float(quantity).is_integer() else quantity,
            "delivery_percent": round((quantity / volume) * 100, 4),
        })
    return rows


def _prepare_security(task):
    """Read and render one overlay without mutating any persistent cache."""
    data_dir, mapping, output_dir, symbol, isin = task
    imported, additional = eod2_rows_for_security(data_dir, mapping, symbol, isin)
    if not imported:
        return None
    existing = read_ohlcv_csv(symbol_csv_path(output_dir, symbol))
    merged = merge_rows_by_date([
        # EOD2 split corrections win overlaps; newer local sessions remain.
        *existing,
        *({field: row[field] for field in OHLCV_FIELDS} for row in imported),
    ])
    delivery = delivery_rows(imported)
    return (
        {"isin": isin, "start_date": imported[0]["Date"], "end_date": imported[-1]["Date"], "sessions": len(imported)},
        additional, _csv_bytes(merged, OHLCV_FIELDS),
        _csv_bytes(delivery, DELIVERY_FIELDS) if delivery else None, len(delivery),
    )


def _ordered_preparations(tasks, workers):
    if workers <= 1:
        yield from map(_prepare_security, tasks)
        return
    # Bound both IPC payloads and speculative reads. Only the parent writes,
    # consumes exceptions and updates reports in the original master order.
    executor = ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"))
    pending = deque()
    tasks = iter(tasks)
    try:
        for _ in range(2 * workers):
            task = next(tasks, None)
            if task is None:
                break
            pending.append(executor.submit(_prepare_security, task))
        while pending:
            result = pending.popleft().result()
            yield result
            task = next(tasks, None)
            if task is not None:
                pending.append(executor.submit(_prepare_security, task))
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)


def import_eod2_ohlcv(data_dir, master, output_dir, delivery_output_dir=None, *, workers=1):
    """Overlay adjusted EOD2 history and retain any newer local provider rows."""
    mapping = json.loads((data_dir / "isin_symbol_map.json").read_text(encoding="utf-8"))
    history = mapping.get("isin2hist", {}) if isinstance(mapping, dict) else {}
    symbols = mapping.get("sym2isin", {}) if isinstance(mapping, dict) else {}
    if not isinstance(history, dict) or not isinstance(symbols, dict):
        raise ValueError("EOD2 ISIN history map is malformed")

    output_dir.mkdir(parents=True, exist_ok=True)
    delivery_output_dir = delivery_output_dir or output_dir.parent / "eod2_delivery_history_data"
    report = {
        "enabled": True,
        "source": "EOD2 adjusted daily CSV bootstrap",
        **FIELD_POLICIES,
        "source_last_update": None,
        "master_symbols": len(master),
        "symbol_history": {},
        "imported_symbols": 0,
        "imported_rows": 0,
        "verified_symbol_history_symbols": 0,
        "verified_symbol_history_additional_rows": 0,
        "unmapped_isins": 0,
        "empty_or_invalid_sources": 0,
        "delivery_symbols": 0,
        "delivery_rows": 0,
    }
    try:
        report["source_last_update"] = json.loads((data_dir / "meta.json").read_text(encoding="utf-8")).get("lastUpdate")
    except (OSError, ValueError, AttributeError):
        pass

    workers = max(1, min(2, workers))
    # Aliases/duplicate master entries can share a destination. Retain their
    # serial read-after-write semantics rather than speculating on stale bytes.
    if workers > 1:
        try:
            destinations = [str(item.get("Symbol")).strip().casefold() for item in master if item.get("Symbol") and item.get("ISIN")]
            if (len(destinations) != len(set(destinations))
                    or any(not isinstance(item.get(key), (str, type(None)))
                           for item in master for key in ("Symbol", "ISIN"))
                    or output_dir.resolve() == (data_dir / "daily").resolve()
                    or Path(delivery_output_dir).resolve() in {output_dir.resolve(), (data_dir / "daily").resolve()}
                    or any((output_dir / f"{item.get('Symbol')}.csv").is_symlink()
                           or (Path(delivery_output_dir) / f"{item.get('Symbol')}.csv").is_symlink()
                           for item in master)):
                workers = 1
        except (AttributeError, TypeError):
            workers = 1  # Let the ordered path surface malformed master rows.
    def tasks():
        for item in master:
            symbol, isin = item.get("Symbol"), item.get("ISIN")
            if not symbol or not isin or (isin not in history and symbols.get(symbol) != isin):
                continue
            # Do not pickle the entire security map for every company.
            security_map = {"isin2hist": {isin: history.get(isin, [])},
                            "sym2isin": {symbol: symbols.get(symbol)}}
            yield data_dir, security_map, output_dir, symbol, isin
    prepared = _ordered_preparations(tasks(), workers)
    try:
        return _commit_preparations(master, history, symbols, output_dir, delivery_output_dir, report, prepared)
    finally:
        prepared.close()


def _commit_preparations(master, history, symbols, output_dir, delivery_output_dir, report, prepared):
    for item in master:
        symbol, isin = item.get("Symbol"), item.get("ISIN")
        if not symbol or not isin:
            continue
        if isin not in history and symbols.get(symbol) != isin:
            report["unmapped_isins"] += 1
            continue
        result = next(prepared)
        if result is None:
            report["empty_or_invalid_sources"] += 1
            continue
        destination = symbol_csv_path(output_dir, symbol)
        symbol_history, additional_rows, ohlcv_bytes, delivery_bytes, delivery_count = result
        # Still perform the overlay every run: unchanged source data may need
        # to replace locally modified historical rows.
        _write_csv_bytes_if_changed(destination, ohlcv_bytes)
        report["symbol_history"][symbol] = symbol_history
        if delivery_bytes is not None:
            _write_csv_bytes_if_changed(delivery_output_dir / f"{symbol}.csv", delivery_bytes)
            report["delivery_symbols"] += 1
            report["delivery_rows"] += delivery_count
        report["imported_symbols"] += 1
        report["imported_rows"] += symbol_history["sessions"]
        if additional_rows:
            report["verified_symbol_history_symbols"] += 1
            report["verified_symbol_history_additional_rows"] += additional_rows
    return report


def main():
    try:
        data_dir = resolve_eod2_data_dir(os.getenv("EDL_EOD2_DATA_DIR"))
        if data_dir is None:
            save_json(REPORT_FILE, {
                "enabled": False,
                "source": "EOD2 adjusted daily CSV bootstrap",
                **FIELD_POLICIES,
                "reason": "EDL_EOD2_DATA_DIR is not set",
            })
            print("EOD2 OHLCV bootstrap skipped (EDL_EOD2_DATA_DIR is not set).")
            return True
        report = import_eod2_ohlcv(
            data_dir, load_json(MASTER_FILE), Path(BASE_DIR) / "ohlcv_data",
            Path(BASE_DIR) / "eod2_delivery_history_data",
            workers=min(2, os.cpu_count() or 1),
        )
        save_json(REPORT_FILE, report)
        print(
            "EOD2 OHLCV bootstrap: "
            f"{report['imported_symbols']}/{report['master_symbols']} symbols, "
            f"{report['imported_rows']} OHLCV rows and {report['delivery_rows']} delivery rows; "
            f"source through {report['source_last_update'] or 'unknown'}."
        )
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"EOD2 OHLCV bootstrap failed: {error}")
        return False


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
