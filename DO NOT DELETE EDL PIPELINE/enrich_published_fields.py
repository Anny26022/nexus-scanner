"""Connect staged NSE prices/dividends and verified history to published stock records."""
import math
from datetime import date, datetime
from pathlib import Path

from ohlcv_utils import read_ohlcv_csv, symbol_csv_path, discard_invalid_ohlcv_rows
from pipeline_utils import BASE_DIR, load_json, save_json


def listing_day(value):
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


def enrich(stocks, bhavcopy, ledger, history_report, history_dir):
    session = bhavcopy.get("as_of_date")
    prices = {(row["symbol"], row["date"]): row for row in bhavcopy.get("ohlcv_records", [])}
    dividends = {}
    for row in ledger.get("records", []):
        if "DIVIDEND" in row.get("action_type", "") and session and row["ex_date"] <= session:
            dividends.setdefault(row["symbol"], []).append(row)
    for stock in stocks:
        symbol = stock.get("Symbol") or stock.get("symbol")
        snapshot_day = listing_day(stock.get('as_of_date'))
        official_day = listing_day(session)
        price = prices.get((symbol, session), {}) if official_day and (snapshot_day is None or snapshot_day == official_day) else {}
        replaced_ohlcv = False
        ohlcv_fields = ("open", "high", "low", "close", "volume")
        if all(price.get(field) is not None for field in ohlcv_fields):
            # The closed-session NSE bhavcopy is the canonical daily candle.
            # Replacing the live vendor snapshot here also prevents a mixed
            # source OHLC record when an auction open sits outside NSE's
            # reported regular-session high/low range.
            replaced_ohlcv = True
            for field in ohlcv_fields:
                stock[field] = price[field]
            stock["rupee_volume"] = round(price["close"] * price["volume"], 2)
            stock["as_of_date"] = session
            stock["ohlcv_source"] = "NSE daily full bhavcopy"
            stock["ohlc_envelope_adjusted"] = bool(price.get("ohlc_envelope_adjusted"))
            stock['ohlcv_reported_high'] = price.get('reported_high', price['high'])
            stock['ohlcv_reported_low'] = price.get('reported_low', price['low'])
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
        rows = discard_invalid_ohlcv_rows(read_ohlcv_csv(symbol_csv_path(Path(history_dir), symbol)))
        normalized_rows = []
        for row in rows:
            row_date = listing_day(row.get("Date"))
            if row_date is None:
                continue
            normalized_rows.append({**row, "Date": row_date.isoformat(),
                                    **{key: float(row[key]) for key in ("Open", "High", "Low", "Close", "Volume")}})
        # Canonicalization can collapse differently formatted source dates onto
        # one exchange session. Keep the last source row for that session so a
        # duplicate cannot inflate lookbacks or history coverage counts.
        rows = list({
            row["Date"]: row
            for row in normalized_rows
            if not session or row["Date"] <= session
        }.values())
        rows.sort(key=lambda row: row["Date"])
        if replaced_ohlcv:
            # Prefer NSE PREV_CLOSE so corporate-action reference changes use
            # the exchange's return basis; otherwise use the prior cached close.
            prior_rows = [row for row in rows if row['Date'] < session]
            previous = price.get('previous_close', prior_rows[-1]['Close'] if prior_rows else None)
            try:
                previous = float(previous)
                change = (float(price['close']) / previous - 1) * 100 if math.isfinite(previous) and previous > 0 else None
                stock['change_percent'] = change if change is not None and math.isfinite(change) else None
            except (TypeError, ValueError):
                stock['change_percent'] = None
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


def main():
    root = Path(BASE_DIR)
    def optional(name):
        path = root / name
        return load_json(path) if path.exists() else {}
    stocks = load_json(root / "all_stocks_fundamental_analysis.json")
    enrich(stocks, optional("nse_delivery_data.json"), optional("corporate_action_ledger.json"),
           optional("eod2_ohlcv_import_report.json"), root / "ohlcv_data")
    save_json(root / "all_stocks_fundamental_analysis.json", stocks, ensure_ascii=False)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
