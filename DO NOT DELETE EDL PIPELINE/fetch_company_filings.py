"""Fetch ScanX filing metadata with a resumable LODR-history backfill.

Refresh recent pages until a fully retained overlap page is reached. Initial
LODR backfills and retries after incomplete refreshes traverse all reported
pages. Raw content revisions and endpoint freshness are retained in
``filing_history_data``.
"""

from __future__ import annotations

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

from pipeline_utils import ensure_dir, get_headers, load_json, resolve_path, save_json


INPUT_FILE = "master_isin_map.json"
OUTPUT_DIR = "company_filings"
HISTORY_DIR = "filing_history_data"
HISTORY_FILE = f"{HISTORY_DIR}/filing_history.json"
LEGACY_URL = "https://ow-static-scanx.dhan.co/staticscanx/company_filings"
LODR_URL = "https://ow-static-scanx.dhan.co/staticscanx/lodr"
# Historical pagination can make several requests for one company. Keep the
# first backfill deliberately below the old 20-way all-symbol fan-out.
MAX_THREADS = max(1, int(os.getenv("EDL_FILINGS_MAX_THREADS", "8")))
PAGE_SIZE = 100


def fetch_page(url, isin, headers, page=1):
    """Return records, endpoint page count and an error string when unavailable."""
    payload = {"data": {"isin": isin, "pg_no": page, "count": PAGE_SIZE}}
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=15)
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as error:
        return None, None, str(error)
    records = payload.get("data")
    if not isinstance(records, list):
        return None, None, "response data is not a list"
    try:
        pages = max(1, int(payload.get("total_pages")))
    except (TypeError, ValueError):
        pages = 1
    return records, pages, None


def _key(entry):
    news_id = entry.get("news_id")
    if news_id not in (None, ""):
        return f"id:{news_id}"
    identity = "|".join(str(entry.get(field) or "") for field in ("news_date", "descriptor", "caption"))
    # A later URL is enrichment, not a new identity. URL-only observations have
    # no other usable identity and retain their original URL fallback.
    return identity if identity.strip("|") else str(entry.get("file_url") or "")


def _content_key(entry):
    # Only source content participates: refresh timestamps must not create versions.
    fields = ("news_date", "descriptor", "ann_type", "cat", "caption", "news_body", "source_endpoint")
    return (_key(entry), *(str(entry.get(field) or "") for field in fields))


def _version_key(entry):
    return (*_content_key(entry), str(entry.get("file_url") or ""))


def dedupe_filings(items):
    """Merge non-conflicting enrichment, retaining observable content revisions."""
    unique = {}
    fields = ("news_date", "descriptor", "ann_type", "cat", "caption", "news_body", "file_url")
    for raw in items:
        if not isinstance(raw, dict) or not _key(raw).strip("|"):
            continue
        entry = dict(raw)
        versions = unique.setdefault((_key(entry), entry.get("source_endpoint")), [])
        for index, previous in enumerate(versions):
            conflict = any(previous.get(field) not in (None, "")
                           and entry.get(field) not in (None, "")
                           and previous[field] != entry[field] for field in fields)
            if not conflict:
                versions[index] = {**previous, **{key: value for key, value in entry.items()
                                                if value not in (None, "")}}
                break
        else:
            versions.append(entry)
    return sorted((entry for versions in unique.values() for entry in versions),
                  key=lambda item: str(item.get("news_date") or ""), reverse=True)


def _with_source(records, endpoint):
    return [{**record, "source_endpoint": endpoint} for record in records if isinstance(record, dict)]


def _refresh_endpoint(url, endpoint, isin, headers, existing, attempted_at, full_backfill=False):
    previous = (existing.get("fetch_status") or {}).get(endpoint, {})
    known = {_version_key({**row, "source_endpoint": endpoint})
             for row in (existing.get("filings") or [])
             if isinstance(row, dict) and row.get("source_endpoint") in {None, endpoint}}
    # A failed catch-up may have cached its first pages. Those pages cannot act
    # as the overlap fence on retry, or the still-missing middle would be skipped.
    full_backfill = full_backfill or previous.get("refresh_complete") is False
    fetched, current_page, total_pages, error, page, pages_fetched = [], [], 1, None, 1, 0
    while page <= total_pages:
        records, pages, error = fetch_page(url, isin, headers, page)
        if records is None:
            error = error or "endpoint returned no records"
            break
        pages_fetched += 1
        total_pages = max(total_pages, pages or 1)
        rows = _with_source(records, endpoint)
        if page == 1:
            current_page = rows
        fetched.extend(rows)
        if not full_backfill and rows and all(_version_key(row) in known for row in rows):
            break
        page += 1
    complete = error is None
    metadata = {"last_attempt_at": attempted_at,
                "last_success_at": datetime.now(timezone.utc).isoformat() if complete else previous.get("last_success_at"),
                "refresh_complete": complete, "pages_fetched": pages_fetched,
                "total_pages": total_pages, "error": error}
    return fetched, metadata, current_page


def fetch_filings(item, existing_history=None):
    """Catch up both feeds, preserving prior data and observable content revisions."""
    symbol = str(item.get("Symbol") or "").upper()
    isin = item.get("ISIN")
    if not symbol or not isin:
        return {"symbol": symbol, "status": "error", "error": "missing symbol or ISIN"}

    existing = existing_history or {}
    attempted_at = datetime.now(timezone.utc).isoformat()
    headers = get_headers(include_origin=True)
    legacy, legacy_status, legacy_current = _refresh_endpoint(LEGACY_URL, "company_filings", isin, headers,
                                              existing, attempted_at)
    lodr, lodr_status, lodr_current = _refresh_endpoint(LODR_URL, "lodr", isin, headers, existing,
                                        attempted_at, not existing.get("lodr_backfill_complete", False))
    completed = bool(existing.get("lodr_backfill_complete")) or lodr_status["refresh_complete"]
    history = {"isin": isin,
               "lodr_total_pages": lodr_status["total_pages"] if lodr_status["pages_fetched"] else existing.get("lodr_total_pages", 1),
               "lodr_backfill_complete": completed,
               "filings": dedupe_filings([*(existing.get("filings") or []), *legacy, *lodr]),
               "updated_at": attempted_at,
               "fetch_status": {"company_filings": legacy_status, "lodr": lodr_status}}
    return {"symbol": symbol,
            "status": "success" if legacy_status["pages_fetched"] or lodr_status["pages_fetched"] else "error",
            "refresh_complete": legacy_status["refresh_complete"] and lodr_status["refresh_complete"],
            "current": dedupe_filings([*legacy_current, *lodr_current]) or history["filings"],
            "history": history, "error": legacy_status["error"] or lodr_status["error"]}


def _load_history():
    payload = load_json(HISTORY_FILE, default={})
    symbols = payload.get("symbols") if isinstance(payload, dict) else None
    return symbols if isinstance(symbols, dict) else {}


def _save_history(history):
    completed = sum(bool(record.get("lodr_backfill_complete")) for record in history.values())
    save_json(HISTORY_FILE, {
        "schema_version": 1,
        "source": "ScanX static company_filings and LODR endpoints",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": history,
        "coverage": {"symbols": len(history), "lodr_backfill_complete": completed, "lodr_backfill_pending": len(history) - completed},
    }, ensure_ascii=False)


def has_pending_backfill(existing, canonical_symbols):
    """Checkpoint batches only while a historical LODR sweep is incomplete."""
    return any(
        not bool(existing.get(symbol, {}).get("lodr_backfill_complete"))
        for symbol in canonical_symbols
    )


def main():
    ensure_dir(OUTPUT_DIR)
    ensure_dir(HISTORY_DIR)
    try:
        stock_list = load_json(INPUT_FILE)
    except Exception as error:
        print(f"Error loading {INPUT_FILE}: {error}")
        return False
    if not isinstance(stock_list, list) or not stock_list:
        print("No canonical symbols available for filings fetch.")
        return False

    canonical_symbols = {str(item.get("Symbol") or "").upper() for item in stock_list}
    # Do not carry a delisted/SME symbol forward merely because it existed in
    # an older cache. The published ledger follows the canonical universe.
    existing = {symbol: record for symbol, record in _load_history().items() if symbol in canonical_symbols}
    history = dict(existing)
    checkpoint_batches = has_pending_backfill(existing, canonical_symbols)
    results = []
    started = time.time()
    print(f"Catching up recent filings for {len(stock_list)} mainboard symbols; threads: {MAX_THREADS}.")
    with ThreadPoolExecutor(max_workers=MAX_THREADS) as executor:
        futures = {
            executor.submit(fetch_filings, item, existing.get(str(item.get("Symbol") or "").upper())): item
            for item in stock_list
        }
        for count, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            if result.get("history"):
                history[result["symbol"]] = result["history"]
            if checkpoint_batches and (count % 100 == 0 or count == len(futures)):
                # A first historical sweep can outlast the enclosing stage's
                # timeout. Once complete, a daily refresh writes once at the
                # end instead of repeatedly rewriting the full cache.
                _save_history(history)
                print(f"[{count}/{len(futures)}] elapsed {time.time() - started:.1f}s")

    for result in results:
        if result.get("current"):
            save_json(resolve_path(OUTPUT_DIR) / f"{result['symbol']}_filings.json", {"code": 0, "data": result["current"]})

    _save_history(history)
    completed = sum(bool(record.get("lodr_backfill_complete")) for record in history.values())
    succeeded = sum(result.get("status") == "success" for result in results)
    caught_up = sum(result.get("refresh_complete", False) for result in results)
    print(f"Filings fetched: {succeeded}/{len(results)}; both feeds caught up: {caught_up}/{len(results)}; LODR histories complete: {completed}/{len(history)}.")
    return succeeded > 0


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
