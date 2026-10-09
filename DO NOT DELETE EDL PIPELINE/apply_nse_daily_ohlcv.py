"""Apply the staged official NSE full-bhavcopy candle to the local OHLCV cache."""

from pathlib import Path
from datetime import date
import requests

from ohlcv_utils import discard_invalid_ohlcv_rows, discard_weekend_rows, evidenced_history_gaps, merge_rows_by_date, nse_calendar_date, read_ohlcv_csv, symbol_csv_path, write_ohlcv_csv
from nse_delivery import fetch_ohlcv_file_for_date
from pipeline_utils import BASE_DIR, load_json, save_json


MASTER_FILE = Path(BASE_DIR) / "master_isin_map.json"
STAGED_FILE = Path(BASE_DIR) / "nse_delivery_data.json"
REPORT_FILE = Path(BASE_DIR) / "nse_daily_ohlcv_report.json"
OHLCV_DIR = Path(BASE_DIR) / "ohlcv_data"


def apply_official_ohlcv(master, records, output_dir):
    """Write only current-master symbols; official close wins for its date."""
    symbols = {str(item.get("Symbol") or "").upper() for item in master}
    by_symbol = {
        str(record.get("symbol") or "").upper(): record
        for record in records
        if isinstance(record, dict) and record.get("symbol") and record.get("date")
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    applied = 0
    for symbol in symbols:
        record = by_symbol.get(symbol)
        if not record:
            continue
        candle = {
            "Date": record["date"], "Open": record["open"], "High": record["high"],
            "Low": record["low"], "Close": record["close"], "Volume": record["volume"],
        }
        destination = symbol_csv_path(output_dir, symbol)
        write_ohlcv_csv(destination, merge_rows_by_date([*read_ohlcv_csv(destination), candle]))
        applied += 1
    return applied


def repair_official_history(expected, output_dir, fetcher=fetch_ohlcv_file_for_date, adjusted_through=None):
    """Batch evidenced gaps outside known adjusted history; unknown bases are skipped."""
    missing_by_date, existing_by_symbol, recovered = {}, {}, {}
    adjusted_through = adjusted_through or {}
    skipped = 0
    for symbol, sessions in expected.items():
        original_rows = read_ohlcv_csv(symbol_csv_path(output_dir, symbol))
        boundary = adjusted_through.get(symbol)
        gaps = evidenced_history_gaps(original_rows, sessions)
        # Full rows are needed only when a repair can actually be attempted.
        rows = discard_invalid_ohlcv_rows(discard_weekend_rows(original_rows)) if gaps else []
        if rows and not boundary:
            skipped += len(gaps)
            continue  # Previously restored CSVs may be adjusted; do not infer their basis.
        for day in gaps:
            if boundary and day <= boundary:
                skipped += 1
                continue
            missing_by_date.setdefault(day, set()).add(symbol)
            existing_by_symbol[symbol] = rows
    with requests.Session() as session:
        for day, symbols in sorted(missing_by_date.items()):
            try:
                records = fetcher(date.fromisoformat(day), session)
            except (requests.RequestException, ValueError) as error:
                print(f"Official gap recovery unavailable for {day}: {error}; trying provider fallback.", flush=True)
                continue
            for row in records:
                symbol = row['symbol']
                if symbol not in symbols or row['date'] != day or row.get('series') != 'EQ':
                    continue
                candle = {'Date': day, **{field: row[field.lower()] for field in ('Open', 'High', 'Low', 'Close', 'Volume')}}
                if not discard_invalid_ohlcv_rows([candle]):
                    continue
                recovered.setdefault(symbol, []).append(candle)
    repaired = 0
    for symbol, candles in recovered.items():
        try:
            write_ohlcv_csv(symbol_csv_path(output_dir, symbol), merge_rows_by_date([*existing_by_symbol[symbol], *candles]))
            repaired += len(candles)
        except OSError as error:
            print(f'Official gap recovery not saved for {symbol}: {error}; trying provider fallback.', flush=True)
    print(f"Official history recovery: {repaired} candles across {len(missing_by_date)} requested sessions; "
          f"{skipped} gaps deferred to provider sync because their price basis is adjusted or unknown.", flush=True)
    return repaired


def main():
    if not STAGED_FILE.exists():
        save_json(REPORT_FILE, {"available": False, "reason": "NSE daily bhavcopy was not staged"})
        print("NSE daily OHLCV skipped: no staged bhavcopy.")
        return True
    try:
        payload = load_json(STAGED_FILE)
        records = payload.get("ohlcv_records", []) if isinstance(payload, dict) else []
        if not records or not payload.get("as_of_date"):
            raise ValueError("staged bhavcopy has no valid OHLCV rows")
        retrieved_at = str(payload.get("retrieved_at") or "")
        if not retrieved_at.startswith(nse_calendar_date()):
            raise ValueError("staged bhavcopy was not fetched during this IST pipeline run")
        records = [record for record in records if record.get("date") == payload["as_of_date"]]
        if not records:
            raise ValueError("staged bhavcopy OHLCV rows do not match its session")
        applied = apply_official_ohlcv(load_json(MASTER_FILE), records, OHLCV_DIR)
        save_json(REPORT_FILE, {
            "available": True,
            "source": payload.get("source"),
            "file_url": payload.get("file_url"),
            "as_of_date": payload["as_of_date"],
            "source_rows": len(records),
            "applied_symbols": applied,
        })
        print(f"Applied official NSE OHLCV for {applied} symbols on {payload['as_of_date']}.")
        return True
    except (OSError, TypeError, ValueError, KeyError) as error:
        print(f"NSE daily OHLCV apply failed: {error}")
        return False


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
