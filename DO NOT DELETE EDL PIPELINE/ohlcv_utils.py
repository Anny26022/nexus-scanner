import csv
from datetime import datetime, time
from math import isfinite
from pathlib import Path
from zoneinfo import ZoneInfo


OHLCV_FIELDS = ["Date", "Open", "High", "Low", "Close", "Volume"]
NSE_TIMEZONE = ZoneInfo("Asia/Kolkata")


def nse_now(now=None):
    """Return ``now`` interpreted in the NSE's calendar timezone."""
    instant = now or datetime.now(NSE_TIMEZONE)
    return instant.replace(tzinfo=NSE_TIMEZONE) if instant.tzinfo is None else instant.astimezone(NSE_TIMEZONE)


def nse_calendar_date(now=None):
    return nse_now(now).date().isoformat()


def is_nse_cash_session(now=None):
    """Whether a ScanX snapshot can represent an in-progress NSE daily bar.

    The snapshot payload has no trade-date field.  Outside normal cash-market
    hours it can still contain the prior close, so labelling it with the local
    calendar date would create a false weekend/holiday candle.
    """
    instant = nse_now(now)
    return instant.weekday() < 5 and time(9, 15) <= instant.time() < time(15, 30)


def symbol_csv_path(directory, symbol):
    """Resolve a provider symbol to a CSV without allowing path traversal."""
    value = str(symbol).strip()
    if (
        not value
        or value in {".", ".."}
        or any(character in value for character in ("/", "\\", "\0", ":"))
    ):
        raise ValueError(f"Unsafe market symbol: {value!r}")
    return Path(directory) / f"{value}.csv"


def date_string(value):
    return value if isinstance(value, str) else datetime.fromtimestamp(value).strftime("%Y-%m-%d")


def rows_from_tick_data(data):
    times = data.get("Time", [])
    if not times:
        return []

    opens = data.get("o", [])
    highs = data.get("h", [])
    lows = data.get("l", [])
    closes = data.get("c", [])
    volumes = data.get("v", [])

    rows = []
    for index, timestamp in enumerate(times):
        rows.append({
            "Date": date_string(timestamp),
            "Open": opens[index],
            "High": highs[index],
            "Low": lows[index],
            "Close": closes[index],
            "Volume": volumes[index],
        })
    return rows


def read_ohlcv_csv(path):
    try:
        with open(path, "r") as f:
            return list(csv.DictReader(f))
    except FileNotFoundError:
        return []


def merge_rows_by_date(rows):
    return sorted({row["Date"]: row for row in rows}.values(), key=lambda row: row["Date"])


def parse_history_date(value):
    """Fast path for canonical CSV dates; retain legacy strptime compatibility."""
    if isinstance(value, str) and len(value) == 10 and value[4] == value[7] == "-":
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.strptime(value, "%Y-%m-%d")


def discard_weekend_rows(rows):
    """Remove impossible NSE daily bars left by an older live-snapshot run."""
    valid = []
    for row in rows:
        try:
            if parse_history_date(row["Date"]).weekday() < 5:
                valid.append(row)
        except (KeyError, TypeError, ValueError):
            valid.append(row)
    return valid


def has_valid_ohlcv(row):
    """Accept only finite daily bars whose OHLC values agree with each other."""
    try:
        opening, high, low, close = (float(row[key]) for key in ("Open", "High", "Low", "Close"))
        volume = float(row["Volume"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        all(isfinite(value) and value > 0 for value in (opening, high, low, close))
        and isfinite(volume) and volume >= 0
        and low <= min(opening, close) <= max(opening, close) <= high
    )


def discard_invalid_ohlcv_rows(rows):
    """Remove malformed provider bars instead of carrying them into publication."""
    return [row for row in rows if has_valid_ohlcv(row)]


def missing_history_sessions(existing_rows, expected_sessions):
    """Require ledger dates from the first observed candle, including trailing gaps."""
    dates = {row["Date"] for row in existing_rows}
    first = min(dates) if dates else None
    return sorted(day for day in expected_sessions if (first is None or day >= first) and day not in dates)


def plan_history_ranges(existing_rows, desired_start_ts, desired_end_ts, expected_sessions=()):
    """Plan backward and forward gaps without discarding an existing cache."""
    if desired_start_ts >= desired_end_ts:
        return []
    if not existing_rows:
        return [(int(desired_start_ts), int(desired_end_ts))]

    parsed = []
    for row in existing_rows:
        try:
            parsed.append(int(parse_history_date(row["Date"]).timestamp()))
        except (KeyError, TypeError, ValueError):
            continue
    if not parsed:
        return [(int(desired_start_ts), int(desired_end_ts))]

    one_day = 86400
    first_ts = min(parsed)
    last_ts = max(parsed)
    ranges = []
    if desired_start_ts < first_ts - one_day:
        ranges.append((int(desired_start_ts), int(first_ts - one_day)))
    if last_ts + one_day < desired_end_ts:
        ranges.append((int(last_ts + one_day), int(desired_end_ts)))
    missing = missing_history_sessions(existing_rows, expected_sessions)
    if missing:
        # A bounded repair range also covers non-consecutive missing sessions.
        ranges.append((int(parse_history_date(missing[0]).timestamp()),
                       int(parse_history_date(missing[-1]).timestamp()) + one_day))
    return ranges


def chunk_history_range(start_ts, end_ts, chunk_days):
    """Yield non-overlapping API ranges from newest to oldest."""
    if chunk_days <= 0:
        raise ValueError("chunk_days must be positive")
    chunks = []
    pointer = int(end_ts)
    span = int(chunk_days * 86400)
    while pointer > start_ts:
        chunk_start = max(int(start_ts), pointer - span)
        chunks.append((chunk_start, pointer))
        pointer = chunk_start
    return chunks


def write_ohlcv_csv(path, rows):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OHLCV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
