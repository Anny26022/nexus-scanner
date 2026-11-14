"""US daily price history: one CSV a stock, in the same form India's history uses (Date,Open,High,Low,Close,Volume).

A stock without a file is seeded from Dhan's history (split-adjusted, from March 2021). After that each run appends
the closed session's bar from the screener snapshot, one call for the whole market. If the snapshot's previous close
does not match the stored last close, the stored series is on another adjustment (a split or a dividend
re-adjustment) and the stock is fetched again in full. Bars on days the NYSE was closed are always dropped.
"""

from __future__ import annotations

import csv
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ohlcv_utils import OHLCV_FIELDS, symbol_csv_path

from . import dhan, yahoo
from .calendar import EASTERN, is_nyse_session_day, previous_session_day
from .universe import history_exchanges

# A stored close may differ from the provider's previous close by rounding; beyond this the series was re-adjusted.
ADJUSTMENT_TOLERANCE = 0.005
HISTORY_YEARS = 10  # asks for more than Dhan holds (2021 onwards), so a deeper source later needs no change here


def read_bars(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline='', encoding='utf-8') as handle:
        return [{'date': row['Date'], 'open': float(row['Open']), 'high': float(row['High']), 'low': float(row['Low']),
                 'close': float(row['Close']), 'volume': float(row['Volume'] or 0)} for row in csv.DictReader(handle)]


def write_bars(path: Path, bars: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.csv.tmp')
    with temporary.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(OHLCV_FIELDS)
        for bar in bars:
            writer.writerow([bar['date'], bar['open'], bar['high'], bar['low'], bar['close'], bar['volume'] or 0])
    temporary.replace(path)


def clean(bar: dict) -> dict | None:
    """A bar whose prices agree with each other and volume is non-negative; None for one without real prices.

    Dhan's US history has bars priced 0 before a listing (dropped, as India drops invalid bars) and bars whose open
    or close lies just outside the day's high-low range (0.05% of bars, a median 0.07% outside). Those prints are
    trades, so the day's range is widened to include them rather than leave a hole in the history.
    """
    prices = [bar['open'], bar['high'], bar['low'], bar['close']]
    if any(price is None or price != price or price <= 0 for price in prices):
        return None
    volume = bar.get('volume')
    if volume is not None and (volume != volume or volume < 0):
        return None
    return {**bar, 'high': max(prices), 'low': min(prices)}


def session_bars(bars: list[dict]) -> list[dict]:
    """Clean bars on NYSE session days only, one a day, oldest first."""
    by_day = {bar['date']: bar for bar in filter(None, map(clean, bars)) if is_nyse_session_day(date.fromisoformat(bar['date']))}
    return [by_day[day] for day in sorted(by_day)]


def fetch_full(symbol: str, security_id: int, listing_exchange: str | None, now: datetime | None = None, *,
               post: dhan.Post = dhan.post, yahoo_fetch=yahoo.fetch_history) -> list[dict]:
    """Every session bar for the stock. Tries Yahoo Finance first for deep multi-decade split-adjusted history;
    falls back to Dhan (from March 2021) if Yahoo is unreachable or missing the ticker."""
    now = now or datetime.now(timezone.utc)
    if yahoo_fetch:
        try:
            bars = session_bars(yahoo_fetch(symbol, end=now))
            if bars:
                return bars
        except Exception as error:
            print(f"  yahoo history {symbol}: {error}", flush=True)
    for exchange in history_exchanges(listing_exchange):
        bars = session_bars(dhan.fetch_history(symbol, security_id, exchange, now - timedelta(days=round(365.25 * HISTORY_YEARS)), now, post=post))
        if bars:
            return bars
    return []


def snapshot_bar(record: dict, session: str) -> dict | None:
    """The session's bar from a canonical snapshot record, when every price is present and the row last traded in that
    session (a halted or untraded stock's row still holds an earlier day's prices)."""
    traded = record.get('provider_last_trade_ist')
    # Without a trade time the row's prices cannot be placed in a session, so they are not stored as this one's.
    if not traded or datetime.fromisoformat(traded).astimezone(EASTERN).date().isoformat() != session:
        return None
    values = [record.get(key) for key in ('open', 'high', 'low', 'close')]
    if any(value is None or value <= 0 for value in values):
        return None
    return {'date': session, 'open': values[0], 'high': values[1], 'low': values[2], 'close': values[3],
            'volume': record.get('volume') or 0}


def needs_refetch(bars: list[dict], record: dict, session: str) -> bool:
    """Whether the stored series no longer joins the snapshot: missing, behind by more than a session, or re-adjusted."""
    if not bars:
        return True
    last = bars[-1]
    if last['date'] >= session:
        return False
    if last['date'] != previous_session_day(date.fromisoformat(session)).isoformat():
        return True
    previous_close = record.get('previous_close')
    if not previous_close or last['close'] <= 0:
        return True
    return abs(previous_close / last['close'] - 1) > ADJUSTMENT_TOLERANCE


def adjustment_matches(bars: list[dict], record: dict) -> bool:
    """Whether the latest bar's close agrees with the snapshot's previous close within adjustment tolerance."""
    if not bars:
        return False
    previous_close = record.get('previous_close')
    last_close = bars[-1]['close']
    if not previous_close or last_close <= 0:
        return False  # unverified, as needs_refetch treats it: the snapshot bar is not joined to the series
    return abs(previous_close / last_close - 1) <= ADJUSTMENT_TOLERANCE


def update(record: dict, root: Path, session: str, *, fetch=fetch_full) -> str:
    """Bring one stock's file up to `session`; returns 'current', 'appended', 'refetched' or 'missing'."""
    path = symbol_csv_path(root, record['symbol'])
    stored = read_bars(path)
    bars = cleaned = session_bars(stored)

    def missing():
        # The stock stays on its earlier session, but a file kept from before the bars were cleaned is still cleaned:
        # the release publishes whatever is stored.
        if cleaned and cleaned != stored:
            write_bars(path, cleaned)
        elif stored and not cleaned:
            path.unlink(missing_ok=True)  # every stored row was invalid: publish no file rather than an unusable one
        return 'missing'

    if bars and bars[-1]['date'] >= session:
        if bars != stored:
            write_bars(path, bars)  # a file kept from before the bars were cleaned
        return 'current'
    status = 'appended'
    if needs_refetch(bars, record, session):
        bars, status = fetch(record['symbol'], record['security_id'], record.get('exchange')), 'refetched'
        if not bars:
            return missing()
    # History can lag the snapshot by the latest session; the snapshot supplies it when it joins the series.
    bar = clean(snapshot_bar(record, session) or {'open': None, 'high': None, 'low': None, 'close': None})
    # It joins only when a refetched series also agrees with the snapshot's previous close: on a split day Dhan's
    # history may not be re-adjusted yet, and a bar appended to it would bake the gap in.
    joins = not needs_refetch(bars, record, session) if status == 'appended' else adjustment_matches(bars, record)
    if bars[-1]['date'] < session and joins and bar:
        bars = [*bars, bar]
    elif status == 'appended':
        return missing()
    write_bars(path, bars)
    return status
