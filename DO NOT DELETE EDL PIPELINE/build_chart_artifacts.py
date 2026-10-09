"""Build compact, immutable per-symbol chart payloads for the published screen.

The scanner snapshot stays small.  A chart is fetched only after a user opens a
symbol, and is always clipped to the same completed NSE session as its screen.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, wait, FIRST_COMPLETED
import os
import time
from multiprocessing import get_context
from functools import lru_cache

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pipeline_utils import BASE_DIR, load_json, save_json
from filing_classification import VERSION, classify_filings, classify_corporate_action
from announcement_artifacts import build_announcements, put_object
from json_records import record_artifact


# HVE is the one all-history record.  Twenty quarters gives five years of
# quarterly context without turning every chart request into an archive dump.
MONTHLY_EVENT_LIMIT = 60
QUARTERLY_EVENT_LIMIT = 20
YEARLY_EVENT_LIMIT = 10


def _records(payload):
    return payload.get("records", []) if isinstance(payload, dict) else []


def _artifact(root: Path, name: str, default):
    """Read either the staging JSON or the published compressed artifact."""
    raw = root / name
    if raw.exists():
        return load_json(raw, default=default)
    compressed = raw.with_suffix(raw.suffix + ".gz")
    if compressed.exists():
        with gzip.open(compressed, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    return default



def _date(value):
    return _parsed_date(str(value or "")[:10])


@lru_cache(maxsize=16384)
def _parsed_date(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def _event_date(value):
    if isinstance(value, (int, float)):
        if value <= 0:
            return None
        timestamp = value / 1000 if value >= 100_000_000_000 else value
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()
        except (ValueError, OverflowError, OSError):
            return None
    return _date(value)


def _load_candles(path: Path, as_of: str):
    candles = []
    if not path.exists():
        return candles
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            date = _date(row.get("Date"))
            if not date or date > as_of:
                continue
            try:
                candles.append({
                    "date": date,
                    "open": float(row["Open"]), "high": float(row["High"]),
                    "low": float(row["Low"]), "close": float(row["Close"]),
                    "volume": int(float(row["Volume"])),
                })
            except (KeyError, TypeError, ValueError):
                continue
    return candles


def _highest(rows):
    return max(rows, key=lambda row: (row["volume"], row["date"])) if rows else None


def _lowest(rows):
    # Equal volume selects the latest session.
    return min(rows, key=lambda row: (row["volume"], _reverse_date(row["date"]))) if rows else None


@lru_cache(maxsize=16384)
def _reverse_date(value):
    return -int(value.replace('-', ''))


def _volume_events(candles):
    monthly, quarterly, yearly = defaultdict(list), defaultdict(list), defaultdict(list)
    for candle in candles:
        date = candle["date"]
        year, month = date[:4], date[5:7]
        monthly[date[:7]].append(candle)
        quarterly[f"{year}-Q{(int(month) - 1) // 3 + 1}"].append(candle)
        yearly[year].append(candle)
    event = lambda candle: {"date": candle["date"], "volume": candle["volume"]} if candle else None
    return {
        "highestEver": event(_highest(candles)),
        "lowestEver": event(_lowest(candles)),
        "lowestQuarterly": [event(_lowest(quarterly[key])) for key in sorted(quarterly)[-QUARTERLY_EVENT_LIMIT:]],
        "monthly": [event(_highest(monthly[key])) for key in sorted(monthly)[-MONTHLY_EVENT_LIMIT:]],
        "quarterly": [event(_highest(quarterly[key])) for key in sorted(quarterly)[-QUARTERLY_EVENT_LIMIT:]],
        "yearly": [event(_highest(yearly[key])) for key in sorted(yearly)[-YEARLY_EVENT_LIMIT:]],
        "retention": {"highestEver": "all available history", "lowestEver": "all available history", "monthlyMonths": MONTHLY_EVENT_LIMIT,
                      "quarterlyQuarters": QUARTERLY_EVENT_LIMIT, "yearlyYears": YEARLY_EVENT_LIMIT},
    }


def _by_symbol(rows):
    grouped = defaultdict(list)
    for row in rows:
        if isinstance(row, dict) and row.get("symbol"):
            grouped[str(row["symbol"]).upper()].append(row)
    return grouped


def _filing_events(payload, as_of):
    events = defaultdict(list)
    for row in _records(payload):
        symbol = str(row.get("symbol") or "").upper()
        filings = row.get("filings", []) if isinstance(row, dict) else []
        if any(not filing.get('filingId') or not isinstance(filing.get('classification'), dict)
               or filing['classification'].get('version') != VERSION for filing in filings):
            filings = classify_filings(filings)
        for filing in filings:
            date = _date(filing.get("news_date"))
            if symbol and date and date <= as_of:
                events[symbol].append({"date": date, "publishedAt": filing.get("news_date"),
                    "category": "Regulatory filing", "headline": filing.get("caption") or filing.get("descriptor"),
                    "url": filing.get("file_url"), "filingId": filing.get("filingId"),
                    "classification": filing['classification'],
                    **({"documentExtraction": {k: v for k, v in filing["documentExtraction"].items() if k in ("status", "sha256", "pagesExamined", "totalPages", "truncated", "error")}} if filing.get("documentExtraction") else {}),
                    **({"documentGroupId": filing["documentGroupId"]} if filing.get("documentGroupId") else {}),
                    "sourceEndpoints": filing.get("sourceEndpoints") if filing.get("sourceEndpoints") is not None else ([filing['source_endpoint']] if filing.get('source_endpoint') else []),
                    "sourceLabels": filing.get("sourceLabels") or [{k: filing.get(k) for k in ("descriptor", "ann_type", "cat")}]})
    return events


def _market_news(root, as_of):
    events = defaultdict(list)
    directory = root / "market_news"
    if not directory.is_dir():
        return events
    for path in directory.glob("*_news.json"):
        payload = load_json(path, default={})
        symbol = str(payload.get("Symbol") or path.stem.removesuffix("_news")).upper()
        for row in payload.get("News", []) if isinstance(payload, dict) else []:
            date = _event_date(row.get("PublishDate"))
            if date and date <= as_of:
                events[symbol].append({"date": date, "category": "Market news", "headline": row.get("Title"), "summary": row.get("Summary"), "source": row.get("Source")})
    return events


def _chart_object(task):
    root, objects, symbol, as_of, actions, earnings, news = task
    candles = _load_candles(root / "ohlcv_data" / f"{symbol}.csv", as_of)
    payload = {
        "schemaVersion": 2, "symbol": symbol,
        "historyStartDate": candles[0]["date"] if candles else None,
        "candles": candles, "volumeEvents": _volume_events(candles),
        "corporateActions": [{**row, "classification": classify_corporate_action(row)} for row in actions if _date(row.get("ex_date")) and row["ex_date"] <= as_of],
        "earnings": [row for row in earnings if _date(row.get("filing_date")) and row["filing_date"] <= as_of],
        "marketNews": sorted(news, key=lambda row: row["date"], reverse=True)[:50],
    }
    return symbol, put_object(objects, payload)


def _chart_chunk(tasks):
    return [_chart_object(task) for task in tasks]


def _timed_announcements(*args, **kwargs):
    started = time.perf_counter()
    result = build_announcements(*args, **kwargs)
    print(f'Chart announcements elapsed: {time.perf_counter() - started:.2f}s', flush=True)
    return result


def _parallel_chart_objects(tasks, workers, announcement=None):
    """Bound queued work and notice failures independently of result order."""
    executor = ProcessPoolExecutor(max_workers=workers, mp_context=get_context('spawn'))
    chunks = iter(enumerate(tasks[start:start + 8] for start in range(0, len(tasks), 8)))
    pending, completed = {}, {}
    def refill():
        while len(pending) < 2 * workers:
            if announcement is not None and announcement.done():
                announcement.result()
            item = next(chunks, None)
            if item is None:
                break
            index, chunk = item
            pending[executor.submit(_chart_chunk, chunk)] = index
    try:
        refill()
        while pending:
            waiting = set(pending)
            if announcement is not None:
                if announcement.done():
                    announcement.result()
                else:
                    waiting.add(announcement)
            done, _ = wait(waiting, return_when=FIRST_COMPLETED)
            if announcement is not None and announcement.done():
                announcement.result()
                done.discard(announcement)
            for future in done:
                index = pending.pop(future)
                completed[index] = future.result()
            refill()
    except BaseException:
        for future in pending:
            future.cancel()
        # Running chunks cannot be cancelled safely: await only this bounded
        # window, not the whole universe, before allowing a retry to reuse tmp.
        executor.shutdown(wait=True, cancel_futures=True)
        for future in pending:
            if not future.cancelled() and future.exception() is not None:
                print(f'Additional chart worker failure: {future.exception()}', file=sys.stderr)
        raise
    else:
        executor.shutdown(wait=True)
    return [item for index in sorted(completed) for item in completed[index]]


def _chart_worker_counts(cpus, symbols):
    candles = max(1, min(2, cpus - 1))
    # Reserve a core for streamed input, IPC and parent assembly. One extra
    # worker adds IPC without the measured two-worker speedup; use the existing
    # in-process path unless a large build has room for both workers.
    announcements = 2 if symbols >= 256 and cpus - candles - 1 >= 2 else 0
    return candles, announcements


def main() -> int:
    root = Path(BASE_DIR)
    stocks = _artifact(root, "all_stocks_fundamental_analysis.json", [])
    if not isinstance(stocks, list) or not stocks:
        print("Cannot build chart artifacts without the canonical stock artifact.")
        return 1
    as_of = max(str(item.get("As Of Date") or item.get("as_of_date") or "")[:10] for item in stocks)
    if not _date(as_of):
        print("Canonical stock artifact has no valid screen session.")
        return 1
    actions = _by_symbol(_records(_artifact(root, "corporate_action_ledger.json", {})))
    earnings = _by_symbol(_records(_artifact(root, "quarterly_financial_history.json", {})))
    filing_path = root / 'filing_history.json'
    filing_history = record_artifact(filing_path) if filing_path.exists() else _artifact(root, "filing_history.json", {})
    news = _market_news(root, as_of)
    output = root / "chart_artifacts"
    temporary = root / ".chart_artifacts.tmp"
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    objects = temporary / "objects"
    symbols = {str(stock.get("Symbol") or stock.get("symbol") or "").upper() for stock in stocks}
    symbols.discard("")
    chart_objects = {}
    count = 0
    tasks = []
    for stock in stocks:
        symbol = str(stock.get("Symbol") or stock.get("symbol") or "").upper()
        if not symbol:
            continue
        tasks.append((root, objects, symbol, as_of, actions[symbol], earnings[symbol], news[symbol]))
    # Share the available CPU budget between bounded candle/announcement pools.
    # Small builds keep announcements in-process. Parent assembly stays ordered
    # and publication waits for both branches, including iterator failures.
    cpus = os.cpu_count() or 1
    workers, announcement_workers = _chart_worker_counts(cpus, len(tasks))
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='announcements') as background:
        announcement = background.submit(_timed_announcements, filing_history, objects, symbols, as_of,
                                          cache=root / 'filing_history_data/object_cache', workers=announcement_workers)
        candle_started = time.perf_counter()
        if cpus > 1 and len(tasks) >= 32:
            chart_objects.update(_parallel_chart_objects(tasks, workers, announcement))
        else:
            for task in tasks:
                if announcement.done():
                    announcement.result()
                symbol, digest = _chart_object(task)
                chart_objects[symbol] = digest
        print(f'Chart candles elapsed: {time.perf_counter() - candle_started:.2f}s', flush=True)
        announcements = announcement.result()
    count = len(tasks)
    index = {"schemaVersion": 2, "asOfDate": as_of, "symbols": count,
             "chartObjects": chart_objects, "announcements": announcements,
             "retention": {"highestEver": "all available history", "quarterlyQuarters": QUARTERLY_EVENT_LIMIT}}
    index["revision"] = hashlib.sha256(json.dumps(index, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    save_json(temporary / "index.json", index)
    shutil.rmtree(output, ignore_errors=True)
    temporary.replace(output)
    print(f"Published {count} immutable chart artifacts through {as_of}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
