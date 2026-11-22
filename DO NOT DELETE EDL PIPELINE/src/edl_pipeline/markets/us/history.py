"""US daily price history: one CSV a stock, in the same form India's history uses (Date,Open,High,Low,Close,Volume).

A stock without a file is seeded in full: Yahoo Finance first (split-adjusted, back to 1980 or the listing; its closes
are the official ones), Dhan (from March 2021) only when Yahoo does not have it. After that each run appends the
session's bar from TradingView's market scan, read with the rest of its values (tradingview.py): its volume and range
are final, and its previous close, which corrects the bar appended the run before, is the official one. A previous
close that disagrees by more than a late print could (a split) fetches the stock in full. A gap, or a stock without a
TradingView bar, is filled from Yahoo's last few weeks, joined where the two share a day. A full fetch never replaces a
deeper stored history with a shorter one. Bars on days the NYSE was closed are always dropped.
"""

from __future__ import annotations

import csv
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from ohlcv_utils import OHLCV_FIELDS, symbol_csv_path

from . import dhan, yahoo
from .calendar import is_nyse_session_day, previous_session_day
from .universe import history_exchanges

# A stored close may differ from the provider's previous close by rounding; beyond this the series was re-adjusted.
ADJUSTMENT_TOLERANCE = 0.005
HISTORY_YEARS = 10  # asks for more than Dhan holds (2021 onwards), so a deeper source later needs no change here
# A gap is filled from this many calendar days before the stored last bar (two weeks hold ten sessions).
REFRESH_DAYS = 14
# A stored last close this far from TradingView's (official) previous close was a late print, and is corrected; any
# further is a split or re-adjustment, which fetches the stock in full. Late prints seen: up to 4% on thin stocks.
CORRECTION_LIMIT = 0.05
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


def fetch_recent(symbol: str, start: date, now: datetime | None = None, *, yahoo_fetch=yahoo.fetch_history) -> list[dict]:
    """Yahoo's session bars from `start`; empty when it does not answer. Dhan is not asked: since 2026-07-24 its daily
    history carries the screener's partial volume (55-95% of the consolidated figure) and last-trade closes."""
    now = now or datetime.now(timezone.utc)
    try:
        return session_bars(yahoo_fetch(symbol, start=datetime.combine(start, time(), timezone.utc), end=now))
    except Exception as error:
        print(f"  yahoo recent {symbol}: {error}", flush=True)
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


def extend(bars: list[dict], record: dict, session: str, *, confirmed: bool = False) -> tuple[list[dict] | None, bool]:
    """(`bars` with the session's TradingView bar appended, whether the series is on another adjustment).

    TradingView's previous close is the official one, so the stored last close (yesterday's TradingView close, which
    can still be a late print) is corrected to it. A difference beyond CORRECTION_LIMIT is no late print: the stored
    series is on another adjustment (a split). A series ending before the previous session joins only when a provider
    re-read `confirmed` that nothing is missing (a halt), and then only on a matching close.
    """
    bar = clean(record['tradingview_bar']) if record.get('tradingview_bar') else None
    previous = record.get('tradingview_previous_close')
    if not bar or not previous or not bars or bars[-1]['close'] <= 0 or bars[-1]['date'] >= session:
        return None, False
    adjacent = bars[-1]['date'] == previous_session_day(date.fromisoformat(session)).isoformat()
    if not adjacent and not confirmed:
        return None, False
    off = abs(previous / bars[-1]['close'] - 1)
    if off > (CORRECTION_LIMIT if adjacent else ADJUSTMENT_TOLERANCE):
        return None, adjacent
    return [*bars[:-1], clean({**bars[-1], 'close': previous}), bar], False


def update(record: dict, root: Path, session: str, *, fetch=fetch_full, recent=None) -> str:
    """Bring one stock's file up to `session`; returns 'current', 'appended' (TradingView's bar), 'gap_filled' or
    'filled' (Yahoo's recent bars, for a gap or for a stock without a TradingView bar), 'refetched' or 'missing'.

    `recent(symbol, start)` returns Yahoo's session bars from `start` (fetch_recent).
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
    readjusted = False
    if bars:
        extended, readjusted = extend(bars, record, session)
        if extended:
            write_bars(path, extended)
            return 'appended'
        if not readjusted and recent:
            start = date.fromisoformat(bars[-1]['date']) - timedelta(days=REFRESH_DAYS)
            joined, readjusted = overlay(bars, recent(record['symbol'], start))
            if joined is not None:
                if joined[-1]['date'] < session:
                    # Yahoo can lag by the closed session; TradingView's bar supplies it when it joins.
                    extended, readjusted = extend(joined, record, session, confirmed=True)
                    joined = extended or joined
                if not readjusted:
                    if joined[-1]['date'] < session:
                        return missing(joined)
                    write_bars(path, joined)
                    # Counted apart: a gap (a missed run) is filled for every stock, which is no sign of trouble.
                    return 'gap_filled' if record.get('tradingview_bar') else 'filled'
        if not readjusted:
            return missing()
    # No history, or a stored series on another adjustment (a split, a dividend re-adjustment).
    fetched = fetch(record['symbol'], record['security_id'], record.get('exchange'))
    if not fetched:
        return missing()
    if bars and date.fromisoformat(fetched[0]['date']) > date.fromisoformat(bars[0]['date']) + DEPTH_SLACK:
        # Yahoo did not answer and Dhan's history starts in 2021: keep the deeper series for the next run's fetch.
        print(f"  history {record['symbol']}: a full fetch from {fetched[0]['date']} would drop history from "
              f"{bars[0]['date']}; kept", flush=True)
        return missing()
    # On a split day a provider's history may not be re-adjusted yet: TradingView's bar joins only on a matching close.
    fetched = extend(fetched, record, session, confirmed=True)[0] or fetched
    write_bars(path, fetched)
    return 'refetched'
