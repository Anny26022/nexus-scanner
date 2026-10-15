"""Fetch standard daily indicators in one TradingView scanner request."""
import math
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

from pipeline_utils import load_json, post_json, save_json

INPUT_FILE = "master_isin_map.json"
OUTPUT_FILE = "advanced_indicator_data.json"
API_URL = "https://scanner.tradingview.com/india/scan"
PERIODS = (5, 10, 20, 50, 100, 200)
INDICATORS = {"RSI": "RSI(14)", "ATR": "ATR(14)", "ADX": "ADX(14)",
              "MACD.macd": "MACD(12,26)", "MACD.signal": "MACD Signal(9)"}
COLUMNS = ["isin", "time", "update_mode", "close",
           *[f"{kind}{period}" for kind in ("SMA", "EMA") for period in PERIODS],
           *INDICATORS]
LIMIT = 10000


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def normalize_rows(response, master, fetched_at):
    rows = response.get("data")
    if not isinstance(rows, list) or not rows or response.get("totalCount") != len(rows):
        raise ValueError("Incomplete TradingView scanner response")
    by_isin = {}
    for row in rows:
        if not isinstance(row, dict) or not str(row.get("s", "")).startswith("NSE:") or not isinstance(row.get("d"), list) or len(row["d"]) != len(COLUMNS):
            raise ValueError("Unexpected TradingView scanner row/column alignment")
        values = dict(zip(COLUMNS, row["d"]))
        isin = values["isin"]
        if not isin:
            continue
        if isin in by_isin:
            raise ValueError(f"Ambiguous TradingView ISIN: {isin}")
        by_isin[isin] = values
    result = []
    for item in master:
        values = by_isin.get(item.get("ISIN"))
        if values is None:
            continue
        timestamp = number(values["time"])
        if timestamp is None or number(values["close"]) is None:
            continue
        result.append({
            "Symbol": item["Symbol"], "ISIN": item["ISIN"], "source": API_URL,
            "asOfDate": datetime.fromtimestamp(timestamp, ZoneInfo("Asia/Kolkata")).date().isoformat(),
            "fetchedAt": fetched_at, "updateMode": values["update_mode"], "close": values["close"],
            **{kind: [{"Indicator": f"{period}-{kind}", "Value": number(values[f"{kind}{period}"])}
                      for period in PERIODS] for kind in ("SMA", "EMA")},
            "TechnicalIndicators": [{"Indicator": label, "Value": number(values[field])}
                                    for field, label in INDICATORS.items()],
            # Monthly TradingView pivots are not the old provider's daily pivots.
            "Pivots": [],
        })
    if not result:
        raise ValueError("TradingView returned no indicators for the canonical ISIN universe")
    # Use the observed stock session, never today's calendar date. Suspended
    # stocks may still have older candles in an otherwise current response.
    session = max(row["asOfDate"] for row in result)
    return [row for row in result if row["asOfDate"] == session]


def main():
    started = time.perf_counter()
    try:
        master = load_json(INPUT_FILE)
        if not master:
            raise ValueError("Master ISIN universe is empty")
        payload = {"columns": COLUMNS, "markets": ["india"], "options": {"lang": "en"},
                   "filter": [{"left": "exchange", "operation": "equal", "right": "NSE"},
                              {"left": "type", "operation": "equal", "right": "stock"},
                              {"left": "is_primary", "operation": "equal", "right": True}],
                   "range": [0, LIMIT]}
        response = post_json(API_URL, payload, timeout=20, retries=1)
        result = normalize_rows(response, master, datetime.now(timezone.utc).isoformat())
        save_json(OUTPUT_FILE, result)
        matched = {row["ISIN"] for row in result}
        missing = [item["Symbol"] for item in master if item.get("ISIN") not in matched]
        print(f"TradingView daily indicators: {len(result)}/{len(master)} matched by ISIN; "
              f"{len(missing)} unavailable; session {result[0]['asOfDate']}; "
              f"elapsed {time.perf_counter() - started:.2f}s", flush=True)
        if missing:
            print(f"Unavailable indicator symbols: {', '.join(missing)}", flush=True)
        return True
    except (OSError, ValueError, OverflowError, requests.RequestException) as error:
        print(f"Advanced indicator fetch failed: {error}", flush=True)
        return False


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
