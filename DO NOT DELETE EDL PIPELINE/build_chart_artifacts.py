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
import io
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pipeline_utils import BASE_DIR, load_json, save_json
from filing_classification import VERSION, TAXONOMY, classify_filings, classify_corporate_action


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


def _write_gzip_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as handle:
        handle.write(encoded)
    compressed = buffer.getvalue()
    path.write_bytes(compressed)
    return compressed


def _date(value):
    value = str(value or "")[:10]
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
    return min(rows, key=lambda row: (row["volume"], -int(row["date"].replace("-", "")))) if rows else None


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
                    **({"documentExtraction": filing["documentExtraction"]} if filing.get("documentExtraction") else {}),
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
    filings = _filing_events(_artifact(root, "filing_history.json", {}), as_of)
    news = _market_news(root, as_of)
    output = root / "chart_artifacts"
    temporary = root / ".chart_artifacts.tmp"
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    count = 0
    for stock in stocks:
        symbol = str(stock.get("Symbol") or stock.get("symbol") or "").upper()
        if not symbol:
            continue
        candles = _load_candles(root / "ohlcv_data" / f"{symbol}.csv", as_of)
        payload = {
            "schemaVersion": 1, "symbol": symbol, "asOfDate": as_of,
            "historyStartDate": candles[0]["date"] if candles else None,
            "candles": candles, "volumeEvents": _volume_events(candles),
            "corporateActions": [{**row, "classification": classify_corporate_action(row)} for row in actions[symbol] if _date(row.get("ex_date")) and row["ex_date"] <= as_of],
            "earnings": [row for row in earnings[symbol] if _date(row.get("filing_date")) and row["filing_date"] <= as_of],
            "regulatoryAnnouncements": sorted(filings[symbol], key=lambda row: row["date"], reverse=True),
            "filingClassificationVersion": VERSION, "filingTaxonomy": TAXONOMY,
            "marketNews": sorted(news[symbol], key=lambda row: row["date"], reverse=True)[:50],
        }
        _write_gzip_json(temporary / f"{symbol}.json.gz", payload)
        count += 1
    revision = hashlib.sha256()
    for path in sorted(temporary.glob("*.json.gz")):
        revision.update(path.name.encode())
        revision.update(path.read_bytes())
    save_json(temporary / "index.json", {
        "schemaVersion": 1, "revision": revision.hexdigest(), "asOfDate": as_of, "symbols": count,
        "retention": {"highestEver": "all available history", "lowestEver": "all available history", "quarterlyQuarters": QUARTERLY_EVENT_LIMIT},
    })
    shutil.rmtree(output, ignore_errors=True)
    temporary.replace(output)
    print(f"Published {count} immutable chart artifacts through {as_of}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
