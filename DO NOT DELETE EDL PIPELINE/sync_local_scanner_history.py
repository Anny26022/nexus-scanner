"""Restore ignored scanner caches from a local EDL copy and refresh NSE sessions.

Git transfers published artifacts, not the Actions history cache. This explicit
bootstrap keeps that cache local and verifies security identity before merging.
"""
import argparse
import csv
import gzip
import json
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import requests

from nse_delivery import HISTORICAL_FILE_URL, NSE_HEADERS, normalize_ohlcv_row
from ohlcv_utils import discard_invalid_ohlcv_rows, discard_weekend_rows, is_nse_session_day, merge_rows_by_date, read_ohlcv_csv, symbol_csv_path, write_ohlcv_csv
from pipeline_utils import BASE_PATH, load_json, save_json


def restore(source, root, stocks):
    source_master = load_json(source / "master_isin_map.json")
    identities = {s["Symbol"]: s.get("ISIN") for s in source_master}
    restored, rejected = 0, []
    destination = root / "ohlcv_data"
    destination.mkdir(parents=True, exist_ok=True)
    for stock in stocks:
        symbol = stock["symbol"]
        if not stock.get("isin") or identities.get(symbol) != stock["isin"]:
            rejected.append(symbol)
            continue
        original = read_ohlcv_csv(symbol_csv_path(source / "ohlcv_data", symbol))
        target = symbol_csv_path(destination, symbol)
        rows = discard_invalid_ohlcv_rows(discard_weekend_rows(merge_rows_by_date(original + read_ohlcv_csv(target))))
        if rows:
            write_ohlcv_csv(target, rows)
            restored += 1
    return restored, rejected


def refresh_sessions(root, stocks, start, end):
    symbols = {s["symbol"] for s in stocks}
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    refreshed = []
    current = start
    while current <= end:
        if is_nse_session_day(current):
            url = HISTORICAL_FILE_URL.format(date=current.strftime("%d%m%Y"))
            response = session.get(url, timeout=30)
            if response.status_code != 404:
                response.raise_for_status()
                rows = [r for item in csv.DictReader(StringIO(response.content.decode("utf-8-sig"))) if (r := normalize_ohlcv_row(item))]
                if not rows or any(r["date"] != current.isoformat() for r in rows):
                    raise ValueError(f"NSE file has no valid dated candles: {url}")
                # Match the published listing series; never let another series
                # with the same symbol overwrite the equity candle.
                series = {s["symbol"]: s.get("listing_series") for s in stocks}
                observed_series = {}
                for row in rows:
                    observed_series.setdefault(row["symbol"], set()).add(row["series"])
                applied = 0
                for row in rows:
                    symbol = row["symbol"]
                    if symbol not in symbols:
                        continue
                    selected_series = series[symbol]
                    if selected_series is None and len(observed_series[symbol]) == 1:
                        selected_series = row["series"]
                    if row["series"] != selected_series:
                        continue
                    path = symbol_csv_path(root / "ohlcv_data", symbol)
                    candle = {"Date":row["date"], **{k.title():row[k] for k in ("open","high","low","close","volume")}}
                    write_ohlcv_csv(path, merge_rows_by_date(read_ohlcv_csv(path) + [candle]))
                    applied += 1
                refreshed.append({"date":current.isoformat(), "symbols":applied, "source":url})
                print(f"Applied {current}: {applied} official NSE candles", flush=True)
        current += timedelta(days=1)
    return refreshed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, help="Existing EDL folder containing master_isin_map.json and ohlcv_data")
    parser.add_argument("--from-date", required=True, type=date.fromisoformat)
    parser.add_argument("--as-of-date", required=True, type=date.fromisoformat)
    args = parser.parse_args()
    if args.from_date > args.as_of_date:
        parser.error("from-date must be on or before as-of-date")
    with gzip.open(BASE_PATH / "all_stocks_fundamental_analysis.json.gz", "rt") as handle:
        stocks = json.load(handle)
    report = {"as_of_date":args.as_of_date.isoformat()}
    if args.source_root:
        source = args.source_root.expanduser().resolve()
        if source == BASE_PATH:
            parser.error("source-root must be a separate EDL copy")
        restored, rejected = restore(source, BASE_PATH, stocks)
        report.update(source_root=str(source), restored_symbols=restored, rejected_identity_symbols=rejected)
        print(f"Restored {restored} validated histories; {len(rejected)} identity mismatches or missing identities", flush=True)
    (BASE_PATH / "ohlcv_data").mkdir(exist_ok=True)
    report["sessions"] = refresh_sessions(BASE_PATH, stocks, args.from_date, args.as_of_date)
    save_json(BASE_PATH / "local_scanner_history_report.json", report)


if __name__ == "__main__":
    main()
