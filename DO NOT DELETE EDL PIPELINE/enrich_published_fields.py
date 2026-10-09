"""Connect staged NSE prices/dividends and verified history to published stock records."""
from datetime import date, datetime
from pathlib import Path
from functools import lru_cache
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
import os

from ohlcv_utils import read_ohlcv_csv, symbol_csv_path, valid_ohlcv_values
from pipeline_utils import BASE_DIR, load_json, save_json


@lru_cache(maxsize=16384)
def _listing_day(value):
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        pass
    for pattern in ("%d-%b-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(str(value).strip(), pattern).date()
        except ValueError:
            pass
    return None


def listing_day(value):
    # Dates repeat across the entire universe; cache only the immutable text.
    return _listing_day(str(value))


def _price_inputs(bhavcopy, ledger):
    session = bhavcopy.get("as_of_date")
    prices = {(row["symbol"], row["date"]): row for row in bhavcopy.get("ohlcv_records", [])}
    dividends = {}
    for row in ledger.get("records", []):
        if "DIVIDEND" in row.get("action_type", "") and session and row["ex_date"] <= session:
            dividends.setdefault(row["symbol"], []).append(row)
    return prices, dividends


def enrich(stocks, bhavcopy, ledger, history_report, history_dir, *, prepared=None):
    session = bhavcopy.get("as_of_date")
    prices, dividends = _price_inputs(bhavcopy, ledger) if prepared is None else prepared
    for stock in stocks:
        symbol = stock.get("Symbol") or stock.get("symbol")
        price = prices.get((symbol, session), {})
        stock["vwap"] = price.get("vwap")
        stock["vwap_as_of_date"] = session if stock["vwap"] is not None else None
        stock["vwap_source"] = "NSE full bhavcopy AVG_PRICE or traded value / volume" if stock["vwap"] is not None else None
        # Latest declaration, not a fabricated annual DPS or partial trailing sum.
        events = sorted(dividends.get(symbol, []), key=lambda row: row["ex_date"])
        latest = events[-1] if events else {}
        same_day = [event for event in events if event["ex_date"] == latest.get("ex_date")]
        unambiguous_dividend = len(same_day) == 1 and latest.get("dividend_per_share") is not None
        stock["dividend_per_share_latest"] = latest.get("dividend_per_share") if unambiguous_dividend else None
        stock["dividend_ex_date"] = latest.get("ex_date") if unambiguous_dividend else None
        stock["dividend_basis"] = "latest ex-date declaration; rupees per share on that date" if unambiguous_dividend else None
        stock["dividend_source_range"] = ledger.get("range") if unambiguous_dividend else None
        rows = read_ohlcv_csv(symbol_csv_path(Path(history_dir), symbol))
        normalized_rows = []
        for row in rows:
            values = valid_ohlcv_values(row)
            if values is None:
                continue
            row_date = listing_day(row.get("Date"))
            if row_date is None:
                continue
            # Only these fields are consumed below. Keep the same validated
            # floats without converting or copying the whole candle twice.
            normalized_rows.append({"Date": row_date.isoformat(),
                                    "High": values[1], "Low": values[2], "Close": values[3]})
        # Canonicalization can collapse differently formatted source dates onto
        # one exchange session. Keep the last source row for that session so a
        # duplicate cannot inflate lookbacks or history coverage counts.
        rows = list({
            row["Date"]: row
            for row in normalized_rows
            if not session or row["Date"] <= session
        }.values())
        rows.sort(key=lambda row: row["Date"])
        listing = listing_day(stock.get("Listing Date") or stock.get("listing_date"))
        source = history_report.get("symbol_history", {}).get(symbol, {})
        first = date.fromisoformat(rows[0]["Date"]) if rows else None
        aligned = bool(rows and rows[-1]["Date"] == session)
        source_first = listing_day(source.get("start_date"))
        covers_listing = bool(
            aligned and listing and source_first
            and abs((source_first - listing).days) <= 7
            and abs((first - listing).days) <= 7
        )
        stock["history_metadata"] = {
            "start_date": rows[0]["Date"] if rows else None,
            "end_date": rows[-1]["Date"] if rows else None,
            "sessions": len(rows), "source": history_report.get("source") if source else "local cache",
            "price_policy": history_report.get("price_policy") if source else "unverified",
            "covers_listing": covers_listing,
            "completeness_basis": "ISIN-verified EOD2 source starts within 7 calendar days of official listing; not an exchange certification",
        }
        high = max((row["High"] for row in rows), default=None)
        low = min((row["Low"] for row in rows), default=None)
        stock["available_history_high"] = high
        stock["available_history_low"] = low
        stock["all_time_high"] = high if covers_listing else None
        stock["all_time_low"] = low if covers_listing else None
        stock["return_5y"] = (rows[-1]["Close"] / rows[-1261]["Close"] - 1) * 100 if aligned and len(rows) >= 1261 else None
        # The existing distance filter also must not call a four-year maximum an ATH.
        stock["% from ATH"] = (high - rows[-1]["Close"]) / high * 100 if covers_listing and high else None
    return stocks


def _initialize_enrichment(bhavcopy, ledger, history_report, history_dir):
    global _ENRICHMENT_INPUTS
    _ENRICHMENT_INPUTS = (bhavcopy, ledger, history_report, history_dir, _price_inputs(bhavcopy, ledger))


def _enrich_chunk(stocks):
    bhavcopy, ledger, history_report, history_dir, prepared = _ENRICHMENT_INPUTS
    return enrich(stocks, bhavcopy, ledger, history_report, history_dir, prepared=prepared)


def enrich_parallel(stocks, bhavcopy, ledger, history_report, history_dir, workers):
    """Workers compute only; the parent retains stock order and the sole write."""
    chunks = iter(stocks[start:start + 8] for start in range(0, len(stocks), 8))
    pending = deque()
    with ProcessPoolExecutor(max_workers=workers, mp_context=get_context('spawn'),
                             initializer=_initialize_enrichment,
                             initargs=(bhavcopy, ledger, history_report, history_dir)) as executor:
        try:
            for _ in range(2 * workers):
                chunk = next(chunks, None)
                if chunk is not None:
                    pending.append(executor.submit(_enrich_chunk, chunk))
            offset = 0
            while pending:
                for result in pending.popleft().result():
                    stock = stocks[offset]
                    stock.clear()
                    stock.update(result)
                    offset += 1
                chunk = next(chunks, None)
                if chunk is not None:
                    pending.append(executor.submit(_enrich_chunk, chunk))
        finally:
            for future in pending:
                future.cancel()
    return stocks


def main():
    root = Path(BASE_DIR)
    def optional(name):
        path = root / name
        return load_json(path) if path.exists() else {}
    stocks = load_json(root / "all_stocks_fundamental_analysis.json")
    inputs = (stocks, optional("nse_delivery_data.json"), optional("corporate_action_ledger.json"),
              optional("eod2_ohlcv_import_report.json"), root / "ohlcv_data")
    workers = min(2, os.cpu_count() or 1)
    if workers > 1 and len(stocks) >= 256:
        enrich_parallel(*inputs, workers)
    else:
        enrich(*inputs)
    save_json(root / "all_stocks_fundamental_analysis.json", stocks, ensure_ascii=False)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
