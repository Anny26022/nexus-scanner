"""US daily price history: one CSV a stock, in the same form India's history uses (Date,Open,High,Low,Close,Volume).

A stock without a file is seeded in full: Yahoo Finance first (split-adjusted, back to 1980 or the listing), Dhan
(from March 2021) when Yahoo does not have it. After that each run re-reads the last few weeks from the same
providers and lays them over the file's tail, so a missed run leaves no gap, the latest bars carry the provider's
final volume and official close (not the screener snapshot's after-hours last trade), and a split shows up as a
disagreement on the earliest shared day, which fetches the stock again in full. Only when neither provider answers
does the screener snapshot supply the closed session's bar, and only when it directly follows the stored series.
A full fetch never replaces a deeper stored history with a shorter one. Bars on days the NYSE was closed are dropped.
"""

from __future__ import annotations

import csv
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from ohlcv_utils import OHLCV_FIELDS, symbol_csv_path

from . import dhan, yahoo
from .calendar import EASTERN, is_nyse_session_day, previous_session_day
from .universe import history_exchanges

# A stored close may differ from the provider's previous close by rounding; beyond this the series was re-adjusted.
ADJUSTMENT_TOLERANCE = 0.005
HISTORY_YEARS = 10  # asks for more than Dhan holds (2021 onwards), so a deeper source later needs no change here
# Each run re-reads this many calendar days before the stored last bar (two weeks hold ten sessions).
REFRESH_DAYS = 14
# A full fetch that starts this much later than the stored history would lose depth, and is not stored.
DEPTH_SLACK = timedelta(days=31)


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


def fetch_recent(symbol: str, security_id: int, listing_exchange: str | None, start: date, now: datetime | None = None, *,
                 post: dhan.Post = dhan.post, yahoo_fetch=yahoo.fetch_history) -> list[dict]:
    """Session bars from `start`, from the provider order fetch_full uses; empty when neither answers."""
    now = now or datetime.now(timezone.utc)
    begin = datetime.combine(start, time(), timezone.utc)
    if yahoo_fetch:
        try:
            bars = session_bars(yahoo_fetch(symbol, start=begin, end=now))
            if bars:
                return bars
        except Exception as error:
            print(f"  yahoo recent {symbol}: {error}", flush=True)
    for exchange in history_exchanges(listing_exchange):
        bars = session_bars(dhan.fetch_history(symbol, security_id, exchange, begin, now, post=post))
        if bars:
            return bars
    return []


def overlay(bars: list[dict], recent: list[dict]) -> tuple[list[dict] | None, bool]:
    """(`bars` with `recent` laid over their tail, whether the two are on different adjustments).

    They are joined at the earliest day both hold, when its closes agree; stored bars after `recent` ends (a provider
    a day behind) are kept. Without a shared day the two cannot be checked against each other: (None, False).
    """
    stored = {bar['date']: bar for bar in bars}
    shared = next((bar for bar in recent if bar['date'] in stored), None)
    if shared is None:
        return None, False
    close = stored[shared['date']]['close']
    if close <= 0 or abs(shared['close'] / close - 1) > ADJUSTMENT_TOLERANCE:
        return None, True
    tail = [bar for bar in recent if bar['date'] >= shared['date']]
    return [*(bar for bar in bars if bar['date'] < shared['date']), *tail,
            *(bar for bar in bars if bar['date'] > tail[-1]['date'])], False


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


def update(record: dict, root: Path, session: str, *, fetch=fetch_full, recent=None) -> str:
    """Bring one stock's file up to `session`; returns 'current', 'appended', 'refetched' or 'missing'.

    `recent(symbol, security_id, exchange, start)` returns session bars from `start` (fetch_recent); without it only
    the snapshot can extend a stored series.
    """
    path = symbol_csv_path(root, record['symbol'])
    stored = read_bars(path)
    bars = cleaned = session_bars(stored)

    def missing(kept=None):
        # The stock stays on its earlier session, but a file kept from before the bars were cleaned is still cleaned
        # (and bars a partial re-read brought in are kept): the release publishes whatever is stored.
        kept = kept or cleaned
        if kept and kept != stored:
            write_bars(path, kept)
        elif stored and not kept:
            path.unlink(missing_ok=True)  # every stored row was invalid: publish no file rather than an unusable one
        return 'missing'

    if bars and bars[-1]['date'] >= session:
        if bars != stored:
            write_bars(path, bars)  # a file kept from before the bars were cleaned
        return 'current'
    snapshot = clean(snapshot_bar(record, session) or {'open': None, 'high': None, 'low': None, 'close': None})
    readjusted = False
    if bars and recent:
        start = date.fromisoformat(bars[-1]['date']) - timedelta(days=REFRESH_DAYS)
        joined, readjusted = overlay(bars, recent(record['symbol'], record['security_id'], record.get('exchange'), start))
        if joined is not None:
            # The providers can lag the snapshot by the closed session; the snapshot supplies it when its previous
            # close is the series' last (after a halt that is an earlier session's).
            if joined[-1]['date'] < session and snapshot and adjustment_matches(joined, record):
                joined = [*joined, snapshot]
            if joined[-1]['date'] < session:
                return missing(joined)
            write_bars(path, joined)
            return 'appended'
    if bars and not readjusted:
        last = bars[-1]['date']
        if last != previous_session_day(date.fromisoformat(session)).isoformat():
            return missing()  # behind by more than a session: the re-read above fills the gap when a provider answers
        if not record.get('previous_close'):
            return missing()  # nothing to check the series against: wait for a provider rather than fetch it all
        if not needs_refetch(bars, record, session):
            if not snapshot:
                return missing()
            write_bars(path, [*bars, snapshot])
            return 'appended'
    # No history, or a stored series on another adjustment (a split, a dividend re-adjustment).
    fetched = fetch(record['symbol'], record['security_id'], record.get('exchange'))
    if not fetched:
        return missing()
    if bars and date.fromisoformat(fetched[0]['date']) > date.fromisoformat(bars[0]['date']) + DEPTH_SLACK:
        # Yahoo did not answer and Dhan's history starts in 2021: keep the deeper series for the next run's fetch.
        print(f"  history {record['symbol']}: a full fetch from {fetched[0]['date']} would drop history from "
              f"{bars[0]['date']}; kept", flush=True)
        return missing()
    # It joins only when the fetched series also agrees with the snapshot's previous close: on a split day a
    # provider's history may not be re-adjusted yet, and a bar appended to it would bake the gap in.
    if fetched[-1]['date'] < session and snapshot and adjustment_matches(fetched, record):
        fetched = [*fetched, snapshot]
    write_bars(path, fetched)
    return 'refetched'
