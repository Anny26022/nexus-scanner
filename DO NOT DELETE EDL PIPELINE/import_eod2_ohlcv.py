"""Optionally seed the local OHLCV cache from a checked-out EOD2 data repo.

EOD2 is a historical bootstrap only.  The normal ScanX/NSE sync continues to
own newer candles.  Matching by ISIN (rather than filenames or current ticker)
also keeps renamed securities attached to their own history.
"""

import csv
import json
import os
from datetime import date
from pathlib import Path

from ohlcv_utils import merge_rows_by_date, read_ohlcv_csv, symbol_csv_path, write_ohlcv_csv
from pipeline_utils import BASE_DIR, file_fingerprint, load_json, save_json


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


def eod2_rows_for_isin(data_dir, history, isin):
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
        rows.extend(source_rows(path, start_date, end_date))
    return merge_rows_by_date(rows)


def eod2_rows_for_security(data_dir, mapping, symbol, isin):
    """Return verified current-symbol history plus any renamed ISIN segments."""
    history = mapping.get("isin2hist", {})
    mapped = eod2_rows_for_isin(data_dir, history, isin)
    if mapping.get("sym2isin", {}).get(symbol) != isin:
        return mapped, 0

    current_file = data_dir / "daily" / f"{symbol.lower()}.csv"
    current = source_rows(current_file, date.min, date.max)
    mapped_dates = {row["Date"] for row in mapped}
    additional_rows = sum(row["Date"] not in mapped_dates for row in current)
    return merge_rows_by_date([*current, *mapped]), additional_rows


def write_delivery_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=DELIVERY_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


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


def import_eod2_ohlcv(data_dir, master, output_dir, delivery_output_dir=None):
    """Overlay adjusted EOD2 history and retain any newer local provider rows."""
    mapping = json.loads((data_dir / "isin_symbol_map.json").read_text(encoding="utf-8"))
    history = mapping.get("isin2hist", {}) if isinstance(mapping, dict) else {}
    symbols = mapping.get("sym2isin", {}) if isinstance(mapping, dict) else {}
    if not isinstance(history, dict) or not isinstance(symbols, dict):
        raise ValueError("EOD2 ISIN history map is malformed")

    output_dir.mkdir(parents=True, exist_ok=True)
    delivery_output_dir = delivery_output_dir or output_dir.parent / "eod2_delivery_history_data"
    checkpoint_path = delivery_output_dir / '.import-checkpoints.json'
    try:
        checkpoint = load_json(checkpoint_path, default={})
    except (OSError, ValueError):
        checkpoint = {}
    rules = [file_fingerprint(Path(__file__)), file_fingerprint(Path(__file__).with_name('ohlcv_utils.py'))]
    previous = checkpoint.get('entries', {}) if isinstance(checkpoint, dict) and checkpoint.get('rules') == rules else {}
    if not isinstance(previous, dict):
        previous = {}
    entries = {}
    reused = 0
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

    for item in master:
        symbol, isin = item.get("Symbol"), item.get("ISIN")
        if not symbol or not isin:
            continue
        if isin not in history and symbols.get(symbol) != isin:
            report["unmapped_isins"] += 1
            continue
        destination = symbol_csv_path(output_dir, symbol)
        delivery_path = delivery_output_dir / f"{symbol}.csv"
        segments = history.get(isin, [])
        source_symbols = {str(segment['symbol']).lower() for segment in segments
                          if isinstance(segment, dict) and segment.get('symbol')}
        if symbols.get(symbol) == isin:
            source_symbols.add(symbol.lower())
        signature = {
            'isin': isin, 'segments': segments, 'current_isin': symbols.get(symbol),
            'sources': {name: file_fingerprint(data_dir / 'daily' / f'{name}.csv') for name in sorted(source_symbols)},
            'destination': file_fingerprint(destination), 'delivery': file_fingerprint(delivery_path),
        }
        cached = previous.get(symbol, {})
        if isinstance(cached, dict) and cached.get('signature') == signature and isinstance(cached.get('summary'), dict):
            summary = cached['summary']
            reused += 1
        else:
            imported, additional_rows = eod2_rows_for_security(data_dir, mapping, symbol, isin)
            if not imported:
                report["empty_or_invalid_sources"] += 1
                continue
            # EOD2 corrections replace overlapping rows; newer provider rows remain.
            merged = merge_rows_by_date([
                *read_ohlcv_csv(destination),
                *({field: row[field] for field in ("Date", "Open", "High", "Low", "Close", "Volume")} for row in imported),
            ])
            write_ohlcv_csv(destination, merged)
            delivery = delivery_rows(imported)
            if delivery:
                write_delivery_csv(delivery_path, delivery)
            summary = {
                'history': {"isin": isin, "start_date": imported[0]["Date"], "end_date": imported[-1]["Date"], "sessions": len(imported)},
                'delivery_rows': len(delivery), 'additional_rows': additional_rows,
            }
            signature.update(destination=file_fingerprint(destination), delivery=file_fingerprint(delivery_path))
        entries[symbol] = {'signature': signature, 'summary': summary}
        report['symbol_history'][symbol] = summary['history']
        report['imported_symbols'] += 1
        report['imported_rows'] += summary['history']['sessions']
        report['delivery_symbols'] += bool(summary['delivery_rows'])
        report['delivery_rows'] += summary['delivery_rows']
        report['verified_symbol_history_symbols'] += bool(summary['additional_rows'])
        report['verified_symbol_history_additional_rows'] += summary['additional_rows']
    current = {'rules': rules, 'entries': entries}
    if current != checkpoint:
        save_json(checkpoint_path, current)
    print(f'EOD2 reused {reused}/{len(entries)} unchanged imports.')
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
