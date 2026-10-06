"""
ULTRA-FAST Index OHLCV Fetcher - Hybrid Incremental
Merges deep history with Today's live snapshot from ScanX API.
"""

import requests
import sys
import time
from collections import Counter
from datetime import date, datetime, time as clock_time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ohlcv_utils import discard_weekend_rows, is_nse_cash_session, merge_rows_by_date, nse_now, read_ohlcv_csv, rows_from_tick_data, write_ohlcv_csv
from pipeline_utils import ensure_dir, get_headers, load_json, resolve_path

# --- Configuration ---
INPUT_FILE = "all_indices_list.json"
MASTER_FILE = "master_isin_map.json"
OUTPUT_DIR = "indices_ohlcv_data"
TICK_API_URL = "https://openweb-ticks.dhan.co/getDataH"
CHUNK_DAYS = 120
MAX_THREADS = 60
FETCH_ATTEMPTS = 3
MIN_CURRENT_EQUITY_COVERAGE = 0.90
NSE_DAILY_REPORT_FILE = "nse_daily_ohlcv_report.json"

def get_safe_sym(sym, index_id=None, disambiguate=False):
    safe_symbol = "".join(c if c.isalnum() else "_" for c in str(sym))
    safe_index_id = "".join(
        c if c.isalnum() else "_" for c in str(index_id)
    )
    return (
        f"{safe_symbol}__{safe_index_id}"
        if disambiguate
        else safe_symbol
    )

def fetch_chunk(payload):
    last_error = None
    for attempt in range(FETCH_ATTEMPTS):
        try:
            r = requests.post(
                TICK_API_URL,
                json=payload,
                headers=get_headers(),
                timeout=10,
            )
            r.raise_for_status()
            return rows_from_tick_data(r.json().get("data", {}))
        except (requests.RequestException, ValueError, TypeError, IndexError) as error:
            last_error = error
            if attempt + 1 < FETCH_ATTEMPTS:
                time.sleep(0.25 * (2 ** attempt))
    raise RuntimeError("Index OHLCV chunk failed after retries") from last_error


def has_current_equity_session(directory, session, symbols=None):
    """Whether the stock feed has a trustworthy current NSE session.

    The index tick-history endpoint can lag its cash-market snapshot after
    close.  We only label that snapshot as today's index candle when the same
    provider has already produced today's daily candle for almost the complete
    equity universe.  This prevents a prior close becoming a holiday candle.
    """
    paths = (
        [Path(directory) / f"{symbol}.csv" for symbol in symbols]
        if symbols is not None else list(Path(directory).glob("*.csv"))
    )
    if not paths:
        return False
    current = 0
    for path in paths:
        rows = read_ohlcv_csv(path)
        if rows and rows[-1].get("Date") == session:
            current += 1
    return current / len(paths) >= MIN_CURRENT_EQUITY_COVERAGE

def index_snapshot_session(directory, symbols=None, official_report=None, now=None):
    """Choose the snapshot date from observed equity sessions, never midnight alone.

    Before the cash open, an undated vendor snapshot still describes the latest
    completed session. Accept the official report's date only when the report
    was retrieved today, is no more than seven calendar days old, and at least
    90% of current-master histories end on that session. This also covers
    weekends and short exchange holidays without trusting a stale cache.
    """
    instant = nse_now(now)
    today = instant.date().isoformat()
    if is_nse_cash_session(instant) or has_current_equity_session(directory, today, symbols):
        return today
    report = official_report if isinstance(official_report, dict) else {}
    candidate = str(report.get("as_of_date") or "")
    try:
        candidate_date = date.fromisoformat(candidate)
    except ValueError:
        candidate_date = None
    age_days = (instant.date() - candidate_date).days if candidate_date else None
    if (instant.time() < clock_time(9, 15)
        and report.get("available") is True
        and age_days is not None
        and 1 <= age_days <= 7
        and str(report.get("retrieved_at") or "").startswith(today)
        and has_current_equity_session(directory, candidate, symbols)):
        return candidate
    return None


def main():
    ensure_dir(OUTPUT_DIR)

    try:
        indices = load_json(INPUT_FILE)
    except FileNotFoundError:
        print(f"Error: {INPUT_FILE} not found.")
        return False

    tasks = []
    global_start_ts = 215634600 # 1976
    global_end_ts = int(time.time())
    try:
        current_symbols = {
            str(item.get("Symbol") or "") for item in load_json(MASTER_FILE)
            if item.get("Symbol")
        }
    except (OSError, ValueError, TypeError):
        current_symbols = None
    try:
        official_report = load_json(NSE_DAILY_REPORT_FILE)
    except (OSError, ValueError, TypeError):
        official_report = {}
    snapshot_session = index_snapshot_session(
        resolve_path("ohlcv_data"), current_symbols, official_report
    )
    print(f"Index snapshot session: {snapshot_session or 'unconfirmed; using dated history only'}")
    
    existing_data_cache = {}
    safe_symbol_counts = Counter(
        get_safe_sym(index.get("Symbol") or "") for index in indices
    )

    def cache_key(index):
        symbol = str(index["Symbol"])
        safe_symbol = get_safe_sym(symbol)
        return get_safe_sym(
            symbol,
            index.get("IndexID"),
            disambiguate=safe_symbol_counts[safe_symbol] > 1,
        )

    print(f"Checking {len(indices)} indices for sync...")

    for idx in indices:
        sym = idx["Symbol"]
        safe_sym = cache_key(idx)
        output_path = resolve_path(OUTPUT_DIR) / f"{safe_sym}.csv"
        
        target_start = global_start_ts
        rows = read_ohlcv_csv(output_path)
        if rows:
            try:
                existing_data_cache[safe_sym] = rows
                last_row_date = rows[-1]["Date"]
                last_dt = datetime.strptime(last_row_date, "%Y-%m-%d")
                target_start = int(last_dt.timestamp()) + 86400
            except Exception:
                pass

        # Only crawl if there's a gap before today
        if target_start < global_end_ts - 86400:
            current_end = global_end_ts
            while current_end > target_start:
                c_start = max(target_start, current_end - (CHUNK_DAYS * 86400))
                tasks.append({
                    "EXCH": idx["Exchange"], "SYM": sym, "SEG": idx["Segment"],
                    "INST": idx["Instrument"], "SEC_ID": idx["IndexID"],
                    "EXPCODE": 0, "INTERVAL": "D", "START": c_start, "END": current_end,
                    "SAFE_SYM": safe_sym
                })
                current_end = c_start - 86400

    # Execute history crawl if needed
    new_data = {cache_key(index): [] for index in indices}
    failed_chunks = 0
    if tasks:
        print(f"Executing {len(tasks)} API chunks for history...")
        with ThreadPoolExecutor(max_workers=MAX_THREADS) as executor:
            future_to_payload = {executor.submit(fetch_chunk, t): t for t in tasks}
            for future in as_completed(future_to_payload):
                payload = future_to_payload[future]
                try:
                    rows = future.result()
                except Exception:
                    failed_chunks += 1
                    continue
                if rows:
                    new_data[payload["SAFE_SYM"]].extend(rows)

    print("Merging with Live Snapshots and saving CSVs...")
    for idx in indices:
        safe_sym = cache_key(idx)
        
        # 1. Start with existing or historic data
        base_rows = existing_data_cache.get(safe_sym, [])
        fetched_rows = new_data.get(safe_sym, [])
        all_rows = base_rows + fetched_rows
        
        # 2. Overlay the undated snapshot only for the confirmed session.
        # Before the cash open this can be the preceding day's close.
        live_rows = []
        if snapshot_session:
            live_rows.append({
                'Date': snapshot_session,
                'Open': idx.get('Open'),
                'High': idx.get('High'),
                'Low': idx.get('Low'),
                'Close': idx.get('Ltp'),
                'Volume': idx.get('Volume', 0)
            })
        final_rows = merge_rows_by_date(discard_weekend_rows(all_rows + live_rows))
        output_path = resolve_path(OUTPUT_DIR) / f"{safe_sym}.csv"
        write_ohlcv_csv(output_path, final_rows)

    if failed_chunks:
        print(f"Error: {failed_chunks} index history chunk(s) failed after retries.")
        return False
    print("Successfully updated index CSVs with dated history and confirmed snapshots.")
    return True

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
