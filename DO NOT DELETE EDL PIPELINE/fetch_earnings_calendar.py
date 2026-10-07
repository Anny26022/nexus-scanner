"""Fetch Nexus Journal's results calendar into a durable scanner artifact."""

from __future__ import annotations

import csv
import gzip
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from pipeline_utils import BASE_DIR, save_json

ENDPOINT = "https://www.nexusjournal.co.in/data/earnings-calendar.json"
OUTPUT = "earnings_calendar.json"
SOURCE = "Nexus Journal earnings calendar with ScanX fallback"
HEADERS = {"Accept": "application/json"}


def nse_symbols(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return {
            str(row.get("SYMBOL") or row.get(" SYMBOL") or "").strip().upper()
            for row in csv.DictReader(handle)
            if str(row.get("SYMBOL") or row.get(" SYMBOL") or "").strip()
            and str(row.get("SERIES") or row.get(" SERIES") or "").strip().upper() == "EQ"
        }


def parse_date(value: object) -> str | None:
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        return None


def normalize(rows: object, symbols: set[str]) -> list[dict]:
    if isinstance(rows, dict):
        rows = rows.get("records")
    if not isinstance(rows, list):
        raise ValueError("Nexus Journal results response must contain a records list.")
    records = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("securityName") or "").strip().upper()
        date = parse_date(row.get("resultDate"))
        code = str(row.get("securityCode") or "").strip()
        if not symbol or symbol not in symbols or not date or not code:
            continue
        records.append({
            "symbol": symbol,
            "bse_security_code": code,
            "company_name": str(row.get("companyName") or "").strip() or None,
            "scheduled_date": date,
            "event_type": "RESULTS_SCHEDULED",
            "source": "NexusJournal",
            "source_url": ENDPOINT,
        })
    return sorted(records, key=lambda item: (item["scheduled_date"], item["symbol"]))


def previous_calendar(root: Path) -> dict | None:
    for path in (root / OUTPUT, root / f"{OUTPUT}.gz"):
        if not path.exists():
            continue
        try:
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict) and isinstance(payload.get("events"), list):
                return payload
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return None


def build_calendar(rows: object, symbols: set[str], fetched_at: str) -> dict:
    return {
        "source": SOURCE,
        "fetched_at": fetched_at,
        "events": normalize(rows, symbols),
    }


def merge_upcoming_results(calendar: dict, scanx_rows: object, symbols: set[str], today: str) -> dict:
    """Select one forthcoming date per symbol, retaining both source observations."""
    by_symbol: dict[str, list[dict]] = {}
    for event in calendar.get("events", []):
        if event.get("source") in {"NexusJournal", "BSE"} and event.get("scheduled_date", "") >= today:
            by_symbol.setdefault(event["symbol"], []).append(event)
    if isinstance(scanx_rows, list):
        for row in scanx_rows:
            if not isinstance(row, dict):
                continue
            symbol = str(row.get("Symbol") or "").strip().upper()
            date = str(row.get("ExDate") or "")
            if (symbol not in symbols or not date or date < today
                    or "QUARTERLY RESULT ANNOUNCEMENT" not in str(row.get("Type") or "").upper()):
                continue
            by_symbol.setdefault(symbol, []).append({
                "symbol": symbol,
                "company_name": row.get("Name") or None,
                "scheduled_date": date,
                "event_type": "QUARTERLY_RESULT_ANNOUNCEMENT",
                "source": "ScanX",
                "source_url": None,
            })

    selected = []
    for symbol, observations in by_symbol.items():
        # The published calendar is preferred; ScanX fills missing symbols.
        observations.sort(key=lambda event: (event["source"] not in {"NexusJournal", "BSE"}, event["scheduled_date"]))
        chosen = observations[0].copy()
        source_dates = {
            source: sorted({event["scheduled_date"] for event in observations if event["source"] == source})
            for source in ("NexusJournal", "BSE", "ScanX") if any(event["source"] == source for event in observations)
        }
        chosen["source_dates"] = source_dates
        chosen["date_conflict"] = len({date for dates in source_dates.values() for date in dates}) > 1
        selected.append(chosen)
    calendar["events"] = sorted(selected, key=lambda event: (event["scheduled_date"], event["symbol"]))
    return calendar


def fetch_calendar(session=requests) -> object:
    for attempt in range(3):
        try:
            response = session.get(ENDPOINT, headers=HEADERS, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(0.5 * (2 ** attempt))


def main(root: Path = Path(BASE_DIR)) -> bool:
    fetched_at = datetime.now(timezone.utc).isoformat()
    symbols = nse_symbols(root / "nse_equity_list.csv")
    try:
        if not symbols:
            raise ValueError("NSE EQ symbol list unavailable.")
        payload = build_calendar(fetch_calendar(), symbols, fetched_at)
    except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
        payload = previous_calendar(root)
        if payload is None:
            payload = {"source": SOURCE, "fetched_at": fetched_at, "events": [], "available": False, "last_fetch_error": str(error)}
        else:
            payload = {**payload, "available": False, "last_fetch_error": str(error)}
        print(f"Nexus Journal calendar unavailable; retaining prior calendar: {error}")
    else:
        payload["available"] = True
        print(f"Fetched {len(payload['events'])} mapped Nexus Journal results events.")
    scanx_path = root / "upcoming_earnings_events.json"
    try:
        scanx_rows = json.loads(scanx_path.read_text(encoding="utf-8")) if scanx_path.exists() else []
    except (OSError, ValueError):
        scanx_rows = []
    payload = merge_upcoming_results(payload, scanx_rows, symbols, datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat())
    save_json(root / OUTPUT, payload, ensure_ascii=False)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
