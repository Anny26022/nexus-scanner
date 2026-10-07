import requests
import os
import sys
import time
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from ohlcv_utils import (
    chunk_history_range,
    discard_invalid_ohlcv_rows,
    discard_weekend_rows,
    merge_rows_by_date,
    missing_history_sessions,
    is_nse_cash_session,
    nse_calendar_date,
    plan_history_ranges,
    read_ohlcv_csv,
    rows_from_tick_data,
    symbol_csv_path,
    write_ohlcv_csv,
)
from pipeline_utils import ensure_dir, fetch_scanx_data, get_headers, load_json, resolve_path

# --- Configuration ---
MASTER_FILE = "master_isin_map.json"
OUTPUT_DIR = "ohlcv_data"
CHUNK_DAYS = 180  # Fetch in chunks to avoid API limits
MAX_THREADS = 15
TICK_API_URL = "https://openweb-ticks.dhan.co/getDataH"
HISTORY_CALENDAR_DAYS = int(os.getenv("EDL_OHLCV_HISTORY_DAYS", str(4 * 365)))
FETCH_ATTEMPTS = 3
NSE_DAILY_REPORT_FILE = "nse_daily_ohlcv_report.json"
MIN_READY_HISTORY_ROWS = 252


def official_session():
    """Return the staged official session, if this refresh obtained one."""
    try:
        with open(NSE_DAILY_REPORT_FILE, encoding="utf-8") as handle:
            report = json.load(handle)
        return report.get("as_of_date") if report.get("available") else None
    except (OSError, ValueError, AttributeError):
        return None


def has_official_history(existing_rows, session, desired_start, expected_sessions=()):
    """Avoid a Dhan request when official data covers the needed cache state."""
    if not session or len(existing_rows) < MIN_READY_HISTORY_ROWS:
        return False
    dates = []
    for row in existing_rows:
        try:
            dates.append(datetime.strptime(row["Date"], "%Y-%m-%d").timestamp())
        except (KeyError, TypeError, ValueError):
            continue
    return (bool(dates) and any(row.get("Date") == session for row in existing_rows)
            and min(dates) <= desired_start
            and not missing_history_sessions(existing_rows, expected_sessions))


def expected_sessions_by_symbol(cache_dir, symbols, through_session, window=30):
    """Reuse dated official files; do not guess holidays or non-trading days."""
    expected = {symbol: set() for symbol in symbols}
    paths = sorted(cache_dir.glob("????-??-??.json"), reverse=True)
    used = 0
    for path in paths:
        if path.stem > through_session:
            continue
        payload = load_json(path)
        if payload.get("date") != path.stem or not payload.get("records"):
            raise ValueError(f"Invalid official session cache: {path}")
        for row in payload["records"]:
            if row.get("date") != path.stem:
                raise ValueError(f"Mixed dates in official session cache: {path}")
            symbol = row.get("symbol")
            if symbol in expected:
                expected[symbol].add(path.stem)
        used += 1
        if used >= window:
            break
    return expected


def get_live_snapshots():
    """Fetches live OHLCV snapshot for all stocks to fill in Today's gap."""
    print("Fetching live snapshots for stocks (Today's data)...")
    payload = {
        "data": {
            "sort": "Volume", "sorder": "desc", "count": 5000,
            "fields": ["Sym", "Open", "High", "Low", "Ltp", "Volume"],
            "params": [{"field": "Exch", "op": "", "val": "NSE"}]
        }
    }
    try:
        return {item["Sym"]: item for item in fetch_scanx_data(payload, timeout=15) if item.get("Sym")}
    except Exception:
        pass
    return {}

def fetch_history_chunk(payload):
    """Fetch a single chunk of historical data."""
    last_error = None
    for attempt in range(FETCH_ATTEMPTS):
        try:
            response = requests.post(
                TICK_API_URL,
                json=payload,
                headers=get_headers(include_origin=True),
                timeout=15,
            )
            response.raise_for_status()
            return rows_from_tick_data(response.json().get("data", {}))
        except (requests.RequestException, ValueError, TypeError, IndexError) as error:
            last_error = error
            if attempt + 1 < FETCH_ATTEMPTS:
                time.sleep(0.25 * (2 ** attempt))
    raise RuntimeError("Historical OHLCV chunk failed after retries") from last_error

def fetch_single_stock(sym, details, live_snapshot=None, official_nse_session=None, expected_sessions=()):
    output_path = symbol_csv_path(resolve_path(OUTPUT_DIR), sym)
    today_str = nse_calendar_date()
    
    # Four calendar years gives roughly 1,000 trading sessions. This supports
    # a 250-session published window, a prior 252-session high/low reference,
    # and a stable EMA-200 warm-up.
    current_end = int(time.time())
    desired_start = current_end - (HISTORY_CALENDAR_DAYS * 86400)
    original_rows = read_ohlcv_csv(output_path)
    # Dhan occasionally returns a malformed historical candle.  Remove it
    # before deciding whether the cache is ready, then persist the repaired
    # cache even if no new provider row is needed today.
    existing_rows = discard_invalid_ohlcv_rows(discard_weekend_rows(original_rows))

    # 1. The official full bhavcopy supplies the closed session for every
    # matching stock.  Dhan is therefore only a fallback for a missing/stale
    # cache, never the routine post-close history source.
    new_rows = []
    if not has_official_history(existing_rows, official_nse_session, desired_start, expected_sessions):
        for range_start, range_end in plan_history_ranges(existing_rows, desired_start, current_end, expected_sessions):
            for c_start, c_end in chunk_history_range(range_start, range_end, CHUNK_DAYS):
                payload = {
                    "EXCH": details["Exch"], "SYM": sym, "SEG": details["Seg"],
                    "INST": details["Inst"], "SEC_ID": details["Sid"],
                    "EXPCODE": 0, "INTERVAL": "D", "START": int(c_start), "END": int(c_end)
                }
                chunk_rows = fetch_history_chunk(payload)
                if chunk_rows:
                    new_rows.extend(chunk_rows)

    # 2. Hybrid Step: Add Today using Live Snapshot
    if live_snapshot and is_nse_cash_session():
        s = live_snapshot
        today_row = {
            'Date': today_str, 
            'Open': s.get('Open', 0), 
            'High': s.get('High', 0), 
            'Low': s.get('Low', 0), 
            'Close': s.get('Ltp', 0), 
            'Volume': s.get('Volume', 0)
        }
        new_rows.append(today_row)

    # 3. Merge, deduplicate and repair old weekend snapshot rows even when
    # the history provider has no new trading-day candle to contribute.
    official_rows = [row for row in existing_rows if row["Date"] == official_nse_session]
    final_rows = merge_rows_by_date(discard_invalid_ohlcv_rows(existing_rows + new_rows + official_rows))

    if missing_history_sessions(final_rows, expected_sessions):
        # Keep useful repaired rows, but never report an incomplete repair as ready.
        if final_rows != original_rows:
            write_ohlcv_csv(output_path, final_rows)
        return "error"

    if not final_rows or final_rows == original_rows:
        return "uptodate"

    write_ohlcv_csv(output_path, final_rows)
    return "success"

def main():
    ensure_dir(OUTPUT_DIR)

    try:
        master_rows = load_json(MASTER_FILE)
    except FileNotFoundError:
        print(f"Error: {MASTER_FILE} not found.")
        return False

    # The canonical map is filtered against current NSE SME market-watch data
    # before this stage.  Do not enumerate raw ScanX rows here: that would
    # silently rebuild SME history after they were excluded from the scanner.
    stocks = {
        item["Symbol"]: {
            "Sid": item["Sid"],
            "Exch": item.get("Exchange", "NSE"),
            "Inst": item.get("Instrument", "EQUITY"),
            "Seg": item.get("Segment", "E"),
        }
        for item in master_rows
        if item.get("Symbol") and item.get("Sid") is not None
    }

    # One bulk ScanX snapshot is used only while a daily candle is forming.
    live_snapshots = get_live_snapshots() if is_nse_cash_session() else {}
    nse_session = official_session()
    expected_sessions = expected_sessions_by_symbol(
        resolve_path("delivery_history_data"), stocks, nse_session or nse_calendar_date()
    )

    print(f"Syncing OHLCV for {len(stocks)} stocks (Hybrid Multi-Chunk Mode)...")
    counts = {"success": 0, "uptodate": 0, "error": 0}
    
    with ThreadPoolExecutor(max_workers=MAX_THREADS) as executor:
        futures = {
            executor.submit(fetch_single_stock, s, stocks[s], live_snapshots.get(s), nse_session, expected_sessions[s]): s
            for s in stocks
        }
        for future in as_completed(futures):
            try:
                res = future.result()
                counts[res if res in counts else "error"] += 1
            except Exception:
                counts["error"] += 1

    print(f"Done! Updated: {counts['success']} | UpToDate: {counts['uptodate']} | Errors: {counts['error']}")
    return counts["error"] == 0

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
