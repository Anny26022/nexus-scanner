"""Fetch BSE's forthcoming-results calendar into a durable scanner artifact."""

from __future__ import annotations

import csv
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

from pipeline_utils import BASE_DIR, save_json

ENDPOINT = "https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w"
OUTPUT = "earnings_calendar.json"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Origin": "https://www.bseindia.com",
    "Referer": "https://www.bseindia.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/154.0.0.0 Safari/537.36",
}


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
        return datetime.strptime(str(value), "%d %b %Y").date().isoformat()
    except (TypeError, ValueError):
        return None


def normalize(rows: object, symbols: set[str]) -> list[dict]:
    if not isinstance(rows, list):
        raise ValueError("BSE results response must be a JSON list.")
    records = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("short_name") or "").strip().upper()
        date = parse_date(row.get("meeting_date"))
        code = str(row.get("scrip_Code") or "").strip()
        if not symbol or symbol not in symbols or not date or not code:
            continue
        records.append({
            "symbol": symbol,
            "bse_security_code": code,
            "company_name": str(row.get("Long_Name") or "").strip() or None,
            "scheduled_date": date,
            "event_type": "RESULTS_BOARD_MEETING",
            "source": "BSE",
            "source_url": row.get("URL"),
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
        "source": "BSE forthcoming results calendar",
        "fetched_at": fetched_at,
        "events": normalize(rows, symbols),
    }


def fetch_calendar(session=requests) -> object:
    response = session.get(ENDPOINT, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response.json()


def main(root: Path = Path(BASE_DIR)) -> bool:
    fetched_at = datetime.now(timezone.utc).isoformat()
    try:
        payload = build_calendar(fetch_calendar(), nse_symbols(root / "nse_equity_list.csv"), fetched_at)
    except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
        payload = previous_calendar(root)
        if payload is None:
            payload = {"source": "BSE forthcoming results calendar", "fetched_at": fetched_at, "events": [], "available": False}
        else:
            payload = {**payload, "available": False, "last_fetch_error": str(error)}
        print(f"BSE calendar unavailable; retaining prior calendar: {error}")
    else:
        payload["available"] = True
        print(f"Fetched {len(payload['events'])} mapped BSE forthcoming-results events.")
    save_json(root / OUTPUT, payload, ensure_ascii=False)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
