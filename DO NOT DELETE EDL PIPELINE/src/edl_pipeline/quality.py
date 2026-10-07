"""Whole-publication integrity and coverage checks, independent of the UI."""
from collections import Counter
import csv
from datetime import date, datetime, timedelta, timezone
import gzip
import os

from .validators import strict_json_load


MIN_DELIVERY_HISTORY_SESSIONS = 252


def inspect_delivery_history(root, reference_session, previous_session=None):
    """Audit the cached official NSE daily-delivery files used by the scanner.

    A latest delivery snapshot alone is insufficient for a ``fired_within``
    delivery rule. Treat missing sessions as missing data, never as zero
    delivery. NSE can publish delivery after the cash-market close, so a
    closed-market publication may use the immediately preceding trading
    session while the current session's delivery file is pending.
    """
    cache = root / "delivery_history_data"
    sessions = []
    records_by_session = {}
    for path in sorted(cache.glob("????-??-??.json")):
        try:
            payload = read_json(path)
            records = payload.get("records", [])
        except (OSError, ValueError, AttributeError):
            continue
        if not isinstance(records, list) or not records or payload.get("date") != path.stem:
            continue
        if any(item.get("date") == path.stem for item in records if isinstance(item, dict)):
            sessions.append(path.stem)
            records_by_session[path.stem] = records
    allowed_sessions = [reference_session]
    if previous_session and previous_session != reference_session:
        allowed_sessions.append(previous_session)
    aligned_session = next((value for value in allowed_sessions if value in records_by_session), None)
    latest_records = records_by_session.get(aligned_session, [])
    current_equities = sum(
        str(item.get("series") or "").upper() == "EQ"
        for item in latest_records if isinstance(item, dict)
    )
    return {
        "minimum_required_sessions": MIN_DELIVERY_HISTORY_SESSIONS,
        "cached_sessions": len(sessions),
        "oldest_session": sessions[0] if sessions else None,
        "latest_session": sessions[-1] if sessions else None,
        "reference_session_present": reference_session in records_by_session,
        "benchmark_session_present": reference_session in records_by_session,
        "previous_session": previous_session,
        "previous_session_present": bool(previous_session and previous_session in records_by_session),
        "aligned_session": aligned_session,
        "aligned_session_present": bool(latest_records),
        "reference_session_records": len(latest_records),
        "reference_session_equity_records": current_equities,
    }


def read_json(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return strict_json_load(handle)


def ohlc_error(row):
    values = [row.get(key) for key in ("open", "high", "low", "close")]
    present = [x for x in values if x is not None]
    if any(type(x) not in (int, float) or x <= 0 for x in present):
        return "non-positive or non-numeric OHLC"
    if len(present) == 4:
        opening, high, low, close = values
        if not low <= min(opening, close) <= max(opening, close) <= high:
            return "inconsistent OHLC"
    volume = row.get("volume")
    if volume is not None and (type(volume) not in (int, float) or volume < 0):
        return "invalid volume"
    return None


def inspect_breadth_history(breadth, window=30, minimum_ratio=0.90):
    """Current file presence cannot certify coverage of earlier sessions."""
    eligible = breadth.get("quality", {}).get("eligible_symbols")
    if type(eligible) is not int or eligible <= 0:
        raise ValueError("breadth eligible population is missing or invalid")
    rows = breadth.get("records", [])[-window:]
    gaps = []
    for row in rows:
        count = row.get("eligible_with_candle")
        if type(count) is not int or not 0 <= count <= eligible:
            raise ValueError("breadth session candle count is missing or invalid")
        if count / eligible < minimum_ratio:
            gaps.append({"date": row["date"], "with_candle": count, "eligible": eligible})
    return {"checked_sessions": len(rows), "minimum_ratio": minimum_ratio, "low_coverage_sessions": gaps}


def inspect_publication(root, today=None, expected_session=None, max_age_days=None):
    today = today or datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    max_age_days = max_age_days if max_age_days is not None else int(os.getenv("EDL_MAX_SESSION_AGE_DAYS", "7"))
    errors = []
    try:
        stocks = read_json(root / "all_stocks_fundamental_analysis.json.gz")
        indices = read_json(root / "all_indices_history_v2.json.gz")
        breadth = read_json(root / "market_breadth_v2.json.gz")
        universe = read_json(root / "breadth_universe_snapshot.json.gz")
        ledger = read_json(root / "corporate_action_ledger.json.gz")
        fno_ban = read_json(root / "nse_fno_ban.json.gz")
        rs_ratings = read_json(root / "rs_rating_daily.json.gz")
        source = read_json(root / "master_isin_map.json")
        for name in ("sector_analytics.json.gz", "all_indices_list.json"):
            read_json(root / name)
        benchmark = next(x for x in indices["indices"] if x["symbol"] == "NIFTY")
        session = date.fromisoformat(benchmark["records"][-1]["date"])
        expected_session = expected_session or os.getenv("EDL_EXPECTED_SESSION")
        if expected_session and session.isoformat() != expected_session:
            errors.append(f"benchmark session {session} != expected {expected_session}")
        if not 0 <= (today - session).days <= max_age_days:
            errors.append(f"benchmark session outside freshness limit: {session}")
        generated = [x["generated_at"] for x in (indices, breadth, universe)]
        if len(set(generated)) != 1 or any(datetime.fromisoformat(x).astimezone(timezone(timedelta(hours=5, minutes=30))).date() != today for x in generated):
            errors.append("v2 outputs were not generated together today")
        if breadth["records"][-1]["date"] != session.isoformat():
            errors.append("breadth and benchmark sessions differ")
        breadth_history = inspect_breadth_history(breadth)
        if breadth_history["low_coverage_sessions"]:
            errors.append("breadth candle coverage below 90%: " + ", ".join(
                f"{row['date']} ({row['with_candle']}/{row['eligible']})"
                for row in breadth_history["low_coverage_sessions"]
            ))
        rs_methodology = rs_ratings.get("methodology")
        rs_benchmark_name = "NIFTY 500"
        if not isinstance(rs_methodology, dict):
            errors.append("RS ratings methodology is missing or invalid")
        elif rs_methodology.get("benchmark") != rs_benchmark_name:
            errors.append(f"RS ratings benchmark must be {rs_benchmark_name}")
        ratings = rs_ratings.get("ratings")
        if not isinstance(ratings, dict) or not ratings:
            errors.append("RS ratings are empty or invalid")
        rs_benchmark = next(
            (item for item in indices["indices"] if str(item.get("symbol")) == rs_benchmark_name),
            None,
        )
        if not rs_benchmark or not rs_benchmark.get("records"):
            errors.append(f"RS benchmark history unavailable: {rs_benchmark_name}")
        elif (
            rs_benchmark["records"][-1]["date"] != session.isoformat()
            or rs_ratings.get("as_of_date") != session.isoformat()
        ):
            errors.append("RS ratings and NIFTY 500 sessions differ from the publication session")
        previous_session = (
            date.fromisoformat(benchmark["records"][-2]["date"])
            if len(benchmark["records"]) > 1 else None
        )
        delivery_history = inspect_delivery_history(
            root, session.isoformat(), previous_session.isoformat() if previous_session else None,
        )
        if delivery_history["cached_sessions"] < MIN_DELIVERY_HISTORY_SESSIONS:
            errors.append(
                "delivery-history coverage below "
                f"{MIN_DELIVERY_HISTORY_SESSIONS} sessions: {delivery_history['cached_sessions']}"
            )
        if not delivery_history["aligned_session_present"]:
            errors.append("delivery-history has no file for benchmark or immediately prior trading session")
        if fno_ban.get("available") and not fno_ban.get("trade_date"):
            errors.append("available F&O-ban report has no trade date")
        with gzip.open(root / "market_breadth.json.gz", "rt", encoding="utf-8") as handle:
            legacy = list(csv.reader(handle))
        legacy_dates = [date.fromisoformat(value) for value in legacy[0][1:]]
        if not legacy_dates or legacy_dates != sorted(set(legacy_dates)) or legacy_dates[-1] != session:
            errors.append("legacy breadth dates differ from benchmark")
        if any(len(row) != len(legacy[0]) for row in legacy[1:]):
            errors.append("legacy breadth has inconsistent row widths")
        symbols = [x["symbol"] for x in stocks]
        source_by_symbol = {x["Symbol"]: x for x in source}
        expected = set(source_by_symbol)
        if set(symbols) != expected or len(symbols) != len(set(symbols)):
            errors.append("stock universe differs from fetched master or has duplicates")
        sme_symbols = [stock["symbol"] for stock in stocks if stock.get("is_sme") is True]
        if sme_symbols:
            errors.append(f"canonical stock universe contains SME securities: {len(sme_symbols)}")
        availability = []
        for stock in stocks:
            symbol = stock["symbol"]
            identity = source_by_symbol.get(symbol, {})
            if stock.get("isin") != identity.get("ISIN") or str(stock.get("security_id")) != str(identity.get("Sid")):
                errors.append(f"{symbol}: canonical identity does not match master")
            missing = sorted(k for k, value in stock.items() if value is None)
            stamp = stock.get("as_of_date")
            if stamp is not None:
                parsed = date.fromisoformat(stamp)
                if parsed > today:
                    errors.append(f"{symbol}: future as_of_date")
            invalid = ohlc_error(stock)
            if invalid:
                errors.append(f"{symbol}: {invalid}")
            availability.append({"symbol": symbol, "isin": stock.get("isin"),
                                 "security_id": stock.get("security_id"), "as_of_date": stamp,
                                 "history_current": stamp == session.isoformat(),
                                 "missing_fields": missing})
        current = sum(row["history_current"] for row in availability)
        if not stocks or current / len(stocks) < 0.90:
            errors.append(f"current stock-history coverage below 90%: {current}/{len(stocks)}")
        index_availability = []
        for item in indices["indices"]:
            dates = []
            for record in item["records"]:
                stamp = date.fromisoformat(record["date"])
                dates.append(stamp)
                invalid = ohlc_error(record)
                if invalid or stamp > today:
                    errors.append(f"index {item['symbol']} {stamp}: {invalid or 'future date'}")
            if dates != sorted(set(dates)):
                errors.append(f"index {item['symbol']}: unsorted/duplicate dates")
            index_availability.append({"symbol": item["symbol"], "index_id": item.get("index_id"),
                                       "as_of_date": dates[-1].isoformat() if dates else None})
        index_current = sum(x["as_of_date"] == session.isoformat() for x in index_availability)
        if not index_availability or index_current / len(index_availability) < 0.90:
            errors.append("current index-history coverage below 90%")
        coverage_fields = ("listing_date", "sector", "industry", "circuit_limit", "fno_eligible", "delivery_percent")
        coverage = {
            field: {
                "available": sum(stock.get(field) is not None for stock in stocks),
                "missing": sum(stock.get(field) is None for stock in stocks),
            }
            for field in coverage_fields
        }
        fno = [stock for stock in stocks if stock.get("fno_eligible") is True]
        coverage["fno_lot_size"] = {"eligible": len(fno), "available": sum(stock.get("fno_lot_size") is not None for stock in fno), "missing": sum(stock.get("fno_lot_size") is None for stock in fno)}
        coverage["fno_next_expiry"] = {"eligible": len(fno), "available": sum(stock.get("fno_next_expiry") is not None for stock in fno), "missing": sum(stock.get("fno_next_expiry") is None for stock in fno)}
        if ledger.get("price_adjusted") is not False:
            errors.append("corporate-action ledger unexpectedly claims adjusted prices")
        action_counts = Counter(record.get("action_type") for record in ledger.get("records", []))
        return {"reference_session": session.isoformat(),
                "freshness_policy": {"expected_session": expected_session, "max_calendar_age_days": max_age_days,
                                     "note": "Benchmark-aligned; not an exchange-holiday calendar. Set EDL_EXPECTED_SESSION for an exact session gate."},
                "stock_count": len(stocks), "current_history_count": current,
                "coverage": coverage,
                "corporate_action_ledger": {"records": len(ledger.get("records", [])),
                                              "verified_price_adjustments": sum(record.get("adjustment_status") == "verified" for record in ledger.get("records", [])),
                                              "manual_review_price_actions": sum(record.get("adjustment_status") == "manual-review" for record in ledger.get("records", [])),
                                              "action_type_counts": dict(action_counts),
                                              "price_adjusted": ledger.get("price_adjusted")},
                "fno_ban": {"available": bool(fno_ban.get("available")), "trade_date": fno_ban.get("trade_date"),
                            "symbols": len(fno_ban.get("symbols", []))},
                "rs_ratings": {"as_of_date": rs_ratings.get("as_of_date"),
                               "universe_count": rs_ratings.get("liquid_universe_count"),
                               "ratings": len(ratings) if isinstance(ratings, dict) else 0,
                               "methodology": rs_ratings.get("methodology")},
                "delivery_history": delivery_history,
                "breadth_history": breadth_history,
                "missing_field_counts": dict(Counter(k for row in availability for k in row["missing_fields"])),
                "symbols": availability, "indices": index_availability, "errors": errors}
    except (ValueError, KeyError, TypeError, IndexError, StopIteration, OSError) as error:
        return {"errors": [f"invalid publication: {error}"]}
