"""Report NSE-listed EQ securities that are not yet usable in the ScanX universe.

NSE's EQUITY_L file is authoritative for listing metadata, but it does not
include the full SME universe and cannot supply a Dhan security ID or price.
This report deliberately does not add NSE-only rows to the tradable master
until ScanX provides both of those fields on a later refresh.
"""

import csv
from datetime import date, datetime, timedelta

from ohlcv_utils import is_nse_session_day, nse_calendar_date
from pipeline_utils import load_json, resolve_path, save_json


MASTER_FILE = "master_isin_map.json"
EQUITY_LIST_FILE = "nse_equity_list.csv"
OUTPUT_FILE = "nse_universe_reconciliation.json"
ALERT_AFTER_SESSIONS = 2


def normalized(value):
    return str(value or "").strip().upper()


def row_value(row, *names):
    for name in names:
        if name in row:
            return row[name]
    return None


def parse_listing_date(value):
    try:
        return datetime.strptime(str(value).strip(), "%d-%b-%Y").date()
    except (TypeError, ValueError):
        return None


def previous_weekday(day):
    while not is_nse_session_day(day):
        day -= timedelta(days=1)
    return day


def weekday_sessions_after(listing_date, as_of_date):
    """Conservative session count using weekdays; NSE holidays delay alerts."""
    if listing_date is None or listing_date >= as_of_date:
        return 0
    sessions = 0
    current = listing_date + timedelta(days=1)
    while current <= as_of_date:
        sessions += is_nse_session_day(current)
        current += timedelta(days=1)
    return sessions


def reconcile(master_rows, nse_rows, as_of_date):
    master_symbols = {normalized(row.get("Symbol")) for row in master_rows if normalized(row.get("Symbol"))}
    master_isins = {normalized(row.get("ISIN")) for row in master_rows if normalized(row.get("ISIN"))}
    pending, excluded = [], []
    for row in nse_rows:
        symbol = normalized(row_value(row, "SYMBOL"))
        isin = normalized(row_value(row, " ISIN NUMBER", "ISIN NUMBER"))
        if not symbol or symbol in master_symbols or isin in master_isins:
            continue
        series = normalized(row_value(row, " SERIES", "SERIES"))
        listing_date = parse_listing_date(row_value(row, " DATE OF LISTING", "DATE OF LISTING"))
        item = {
            "symbol": symbol,
            "isin": isin or None,
            "name": str(row_value(row, " NAME OF COMPANY", "NAME OF COMPANY") or "").strip() or None,
            "series": series or None,
            "listing_date": listing_date.isoformat() if listing_date else None,
        }
        if series != "EQ":
            excluded.append({**item, "reason": "non_eq_series"})
            continue
        sessions = weekday_sessions_after(listing_date, as_of_date)
        item.update({
            "observed_sessions_since_listing": sessions,
            "status": "alert" if sessions >= ALERT_AFTER_SESSIONS else "pending_scanx_enrichment",
        })
        pending.append(item)
    pending.sort(key=lambda item: (item["listing_date"] or "", item["symbol"]))
    excluded.sort(key=lambda item: item["symbol"])
    return pending, excluded


def main():
    as_of_date = previous_weekday(date.fromisoformat(nse_calendar_date()))
    try:
        master_rows = load_json(MASTER_FILE)
        with resolve_path(EQUITY_LIST_FILE).open(encoding="utf-8-sig", newline="") as handle:
            nse_rows = list(csv.DictReader(handle))
    except (FileNotFoundError, csv.Error, ValueError) as error:
        save_json(OUTPUT_FILE, {
            "available": False, "source": "NSE EQUITY_L reconciliation",
            "as_of_date": as_of_date.isoformat(), "reason": str(error),
            "pending_scanx_enrichment": [], "alert_count": 0,
        })
        print(f"NSE universe reconciliation unavailable: {error}")
        return True
    pending, excluded = reconcile(master_rows, nse_rows, as_of_date)
    alerts = [item for item in pending if item["status"] == "alert"]
    save_json(OUTPUT_FILE, {
        "available": True, "source": "NSE EQUITY_L reconciliation",
        "as_of_date": as_of_date.isoformat(),
        "alert_after_observed_sessions": ALERT_AFTER_SESSIONS,
        "scanx_master_count": len(master_rows), "nse_equity_list_count": len(nse_rows),
        "pending_scanx_enrichment": pending, "pending_count": len(pending),
        "alert_count": len(alerts), "nse_only_non_eq": excluded,
        "nse_only_non_eq_count": len(excluded),
    })
    print(f"NSE universe reconciliation: {len(pending)} EQ pending, {len(alerts)} alert(s), {len(excluded)} non-EQ excluded.")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
