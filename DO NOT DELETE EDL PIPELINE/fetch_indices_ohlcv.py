"""
ULTRA-FAST Index OHLCV Fetcher - Hybrid Incremental
Merges deep history with Today's live snapshot from ScanX API.
"""

import requests
from pipeline_utils import http_session
import sys
import time
from collections import Counter
from datetime import datetime, date, time as day_time, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ohlcv_utils import discard_weekend_rows, merge_rows_by_date, nse_calendar_date, nse_now, NSE_TIMEZONE, read_ohlcv_csv, rows_from_tick_data, write_ohlcv_csv
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
            r = http_session().post(
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


def equity_session(directory, symbols, now=None):
    """Latest stock session, only when >=90% of the current universe covers it."""
    if not symbols:
        return None
    sessions = Counter()
    today = nse_calendar_date(now)
    for symbol in symbols:
        rows = read_ohlcv_csv(Path(directory) / f'{symbol}.csv')
        try:
            session = date.fromisoformat(rows[-1]['Date']).isoformat()
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if session <= today:
            sessions[session] += 1
    latest = max(sessions, default=None)
    return latest if latest and sessions[latest] / len(symbols) >= MIN_CURRENT_EQUITY_COVERAGE else None


def snapshot_matches_session(fetched_at, session, now=None):
    """Do not assign a snapshot captured after the next market opening backwards."""
    try:
        captured = datetime.fromisoformat(fetched_at)
        if captured.tzinfo is None:
            return False
        captured = nse_now(captured)
        day = date.fromisoformat(session)
    except (TypeError, ValueError):
        return False
    next_day = day + timedelta(days=1)
    while next_day.weekday() >= 5:
        next_day += timedelta(days=1)
    return (day.weekday() < 5 and datetime.combine(day, day_time(9, 15), NSE_TIMEZONE) <= captured
            < datetime.combine(next_day, day_time(9, 15), NSE_TIMEZONE) and captured <= nse_now(now))

def main():
    ensure_dir(OUTPUT_DIR)

    try:
        indices = load_json(INPUT_FILE)
    except FileNotFoundError:
        print(f"Error: {INPUT_FILE} not found.")
        return False

    tasks = []
    global_start_ts = 215634600 # 1976
    now = nse_now()
    try:
        current_symbols = {
            str(item.get("Symbol") or "") for item in load_json(MASTER_FILE)
            if item.get("Symbol")
        }
    except (OSError, ValueError, TypeError):
        print('Error: current stock universe unavailable; index sync stopped.')
        return False
    session = equity_session(resolve_path("ohlcv_data"), current_symbols, now)
    if session is None:
        print('Error: no latest stock session has 90% history coverage; index sync stopped.')
        return False
    global_end_ts = min(int(now.timestamp()), int(datetime.combine(
        date.fromisoformat(session) + timedelta(days=1), day_time(), NSE_TIMEZONE).timestamp()) - 1)
    print(f'Index target session from stock histories: {session}.')
    
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
                last_dt = datetime.strptime(last_row_date, "%Y-%m-%d").replace(tzinfo=NSE_TIMEZONE)
                target_start = int(last_dt.timestamp()) + 86400
            except Exception:
                pass

        # Include a single missing completed session, not just multi-day gaps.
        if target_start < global_end_ts:
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
        
        # Dated provider candles win. Undated snapshots need capture-time evidence
        # that the next market session had not opened yet (including midnight).
        live_rows = []
        if snapshot_matches_session(idx.get('SnapshotFetchedAt'), session, now) and not any(
                row.get('Date') == session for row in fetched_rows):
            live_rows.append({
                'Date': session,
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
    print(f"Index sync completed for stock session {session}; publication checks still apply.")
    return True

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
