"""NSE daily full-bhavcopy delivery-data adapter."""

from __future__ import annotations

import csv
import math
from datetime import date, datetime, timedelta
from io import StringIO
from urllib.parse import urljoin

import requests


NSE_DAILY_REPORTS_URL = "https://www.nseindia.com/api/daily-reports?key=CM"
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.nseindia.com/all-reports",
}
DELIVERY_FILE_KEY = "CM-BHAVDATA-FULL"
HISTORICAL_FILE_URL = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date}.csv"


def parse_nse_date(value: str) -> str:
    """Convert NSE's ``25-Sep-2026`` calendar date to ISO form."""
    return datetime.strptime(value.strip(), "%d-%b-%Y").date().isoformat()


def normalize_row(row: dict) -> dict | None:
    """Normalize one row from NSE's `sec_bhavdata_full` CSV."""
    row = {str(key).strip(): value for key, value in row.items()}
    symbol = str(row.get("SYMBOL") or "").strip().upper()
    session_date = row.get("DATE1")
    delivery_percent = row.get("DELIV_PER")
    if not symbol or not session_date or delivery_percent in (None, ""):
        return None
    try:
        return {
            "symbol": symbol,
            "series": str(row.get("SERIES") or "").strip().upper() or None,
            "date": parse_nse_date(session_date),
            "traded_quantity": int(float(row.get("TTL_TRD_QNTY") or 0)),
            "deliverable_quantity": int(float(row.get("DELIV_QTY") or 0)),
            "delivery_percent": float(delivery_percent),
            "source": "NSE daily full bhavcopy and security deliverable data",
        }
    except (TypeError, ValueError):
        return None


def normalize_ohlcv_row(row: dict) -> dict | None:
    """Normalize the OHLCV portion of one official NSE full-bhavcopy row."""
    row = {str(key).strip(): value for key, value in row.items()}
    symbol = str(row.get("SYMBOL") or "").strip().upper()
    try:
        result = {
            "symbol": symbol,
            "series": str(row.get("SERIES") or "").strip().upper() or None,
            "date": parse_nse_date(row["DATE1"]),
            "open": float(row["OPEN_PRICE"]),
            "high": float(row["HIGH_PRICE"]),
            "low": float(row["LOW_PRICE"]),
            "close": float(row["CLOSE_PRICE"]),
            "volume": float(row["TTL_TRD_QNTY"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
    prices = [result[key] for key in ("open", "high", "low", "close")]
    if not symbol or not all(math.isfinite(value) and value > 0 for value in prices):
        return None
    if not math.isfinite(result["volume"]) or result["volume"] < 0:
        return None
    # NSE occasionally reports an opening-auction price outside the regular
    # session HIGH_PRICE/LOW_PRICE envelope. Preserve every reported price and
    # derive a valid daily candle envelope instead of dropping the session.
    reported_high, reported_low = result["high"], result["low"]
    result["high"] = max(prices)
    result["low"] = min(prices)
    if result["high"] != reported_high or result["low"] != reported_low:
        result["reported_high"] = reported_high
        result["reported_low"] = reported_low
        result["ohlc_envelope_adjusted"] = True
    try:
        vwap = float(row.get("AVG_PRICE") or 0)
        volume = result["volume"]
        if not vwap and volume > 0:
            vwap = float(row.get("TURNOVER_LACS") or 0) * 100_000 / volume
        if volume > 0 and math.isfinite(vwap) and vwap > 0:
            result["vwap"] = vwap
    except (TypeError, ValueError):
        pass
    return result


def latest_delivery_file(report_payload: dict) -> dict:
    """Find NSE's newest published Full Bhavcopy + Delivery CSV descriptor."""
    candidates = []
    for section in ("CurrentDay", "PreviousDay"):
        for item in report_payload.get(section, []):
            if item.get("fileKey") == DELIVERY_FILE_KEY and item.get("fileActlName"):
                candidates.append(item)
    if not candidates:
        raise RuntimeError("NSE daily reports did not list a full bhavcopy delivery file")
    return max(candidates, key=lambda item: parse_nse_date(item["tradingDate"]))


def fetch_latest_full_bhavcopy(session: requests.Session | None = None) -> tuple[dict, list[dict], list[dict]]:
    """Download one official file for both daily OHLCV and delivery data."""
    session = session or requests.Session()
    session.headers.update(NSE_HEADERS)
    reports = session.get(NSE_DAILY_REPORTS_URL, timeout=30)
    reports.raise_for_status()
    descriptor = latest_delivery_file(reports.json())
    url = urljoin(descriptor["filePath"].rstrip("/") + "/", descriptor["fileActlName"])
    response = session.get(url, timeout=60)
    response.raise_for_status()
    rows = list(csv.DictReader(StringIO(response.content.decode("utf-8-sig"))))
    delivery_records = [item for row in rows if (item := normalize_row(row))]
    ohlcv_records = [item for row in rows if (item := normalize_ohlcv_row(row))]
    if not delivery_records or not ohlcv_records:
        raise RuntimeError(f"NSE full bhavcopy contained no usable records: {url}")
    return {
        "source": "NSE daily full bhavcopy and security deliverable data",
        "file_name": descriptor["fileActlName"],
        "file_url": url,
        "as_of_date": parse_nse_date(descriptor["tradingDate"]),
    }, delivery_records, ohlcv_records


def fetch_latest_delivery_bhavcopy(session: requests.Session | None = None) -> tuple[dict, list[dict]]:
    """Compatibility wrapper for the delivery-only consumer."""
    metadata, delivery_records, _ = fetch_latest_full_bhavcopy(session)
    return metadata, delivery_records


def fetch_delivery_history_by_date(from_date: str, to_date: str, session: requests.Session | None = None) -> tuple[list[dict], list[str]]:
    """Download a bounded calendar range of daily full-universe delivery CSVs.

    Weekends/holidays are represented as skipped dates; a missing file never
    becomes a zero-delivery record.
    """
    start, end = date.fromisoformat(from_date), date.fromisoformat(to_date)
    if start > end:
        raise ValueError("from_date must not be after to_date")
    session = session or requests.Session()
    session.headers.update(NSE_HEADERS)
    records, skipped = [], []
    current = start
    while current <= end:
        url = HISTORICAL_FILE_URL.format(date=current.strftime("%d%m%Y"))
        response = session.get(url, timeout=60)
        if response.status_code == 404:
            skipped.append(current.isoformat())
        else:
            response.raise_for_status()
            rows = csv.DictReader(StringIO(response.content.decode("utf-8-sig")))
            records.extend(item for row in rows if (item := normalize_row(row)))
        current += timedelta(days=1)
    return records, skipped


def fetch_delivery_file_for_date(session_date: date, session: requests.Session) -> list[dict] | None:
    """Fetch one dated bulk file; ``None`` means NSE did not publish one."""
    url = HISTORICAL_FILE_URL.format(date=session_date.strftime("%d%m%Y"))
    response = session.get(url, timeout=60)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return [item for row in csv.DictReader(StringIO(response.content.decode("utf-8-sig"))) if (item := normalize_row(row))]
