"""US earnings dates: past reports and the upcoming calendar, from data the pipelines already fetch.

- Earnings Pulse's US results, which the India refresh archives every day (frontend/earningspulse_history.py, published
  as results/us_index.json): each report's filing day and timing, about 15,700 reports over the last four quarters.
- TradingView's scan (tradingview.py): every stock's last and next earnings date and time of day.

The two agreed on 95% of Earnings Pulse's 2026-Q4 reports to the day (and 3% one day apart, after-close reports dated
the next morning), 2026-11-22. Older reports are in neither: SEC EDGAR's 8-K results filings would be the source.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from datetime import date, timedelta
from pathlib import Path

import requests

# Where the US workflow puts the Earnings Pulse US archive, copied from R2 (tools/us_state.py pulse): us_index.json
# and the objects its quarters name, by sha256. No host is assumed; a local run can set US_RESULTS_INDEX_URL instead.
PULSE_DIRECTORY = 'earnings_pulse'
CALENDAR = 'earnings_calendar.json'
# A quarter's report is filed within this many days of its end: the same window as the statements' trust check
# (statements.REPORT_WINDOW_DAYS; 10-Q 40-45, 10-K 60-90, a few days more when late).
REPORT_WINDOW = timedelta(days=100)
TIMING = {-1: 'Pre', 1: 'After'}  # TradingView's earnings_release_time; 0 is not yet known


def _json(url: str, get=requests.get, digest: str | None = None):
    response = get(url, timeout=60, headers={'User-Agent': 'Mozilla/5.0'})
    response.raise_for_status()
    raw = response.content
    # An indexed object is named by the sha256 of its compressed bytes, as the local copy is checked in _local.
    if digest and hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError(f'Earnings Pulse object {url} does not match its sha256')
    return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)


def _local(directory: Path):
    """Read the copied archive: the index, then each object by its sha256."""
    def read(name, digest=None):
        raw = (directory / name).read_bytes()
        # Objects are named by the sha256 of their compressed bytes (earningspulse_history.py checks it the same way).
        if digest and hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError(f'Earnings Pulse object {name} does not match its sha256')
        return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
    return read('us_index.json'), lambda item: read(f"{item['sha256']}.json.gz", item['sha256'])


def load_pulse(root: Path | None = None, *, index_url: str | None = None, index_path: Path | None = None,
               latest: int | None = None, get=requests.get) -> dict:
    """Earnings Pulse's archived reports: {'reported': [...], 'upcoming': [...]} (raw rows), or an `error`.

    From root/earnings_pulse when the workflow copied it there (the US), from `index_path` with each object read from
    its URL (India's index, which site_data.py pull fetches before the build), else from `index_url`."""
    index_url = index_url or os.environ.get('US_RESULTS_INDEX_URL')
    try:
        directory = root / PULSE_DIRECTORY if root else None
        if directory and (directory / 'us_index.json').exists():
            index, load = _local(directory)
        elif index_path and Path(index_path).exists():
            index, load = json.loads(Path(index_path).read_text()), lambda item: _json(item['url'], get, item.get('sha256'))
        elif index_url:
            index, load = _json(index_url, get), lambda item: _json(item['url'], get, item.get('sha256'))
        else:
            return {'reported': [], 'upcoming': [], 'error': 'no Earnings Pulse archive (not copied from R2)'}
        result = {'reported': [], 'upcoming': []}
        quarters = (index or {}).get('quarters') or {}
        # `latest`: only the newest quarters (a reader of the current results), each a download when read by URL.
        for _, quarter in sorted(quarters.items())[-latest if latest else None:]:
            for part, name in (('published', 'reported'), ('upcoming', 'upcoming')):
                item = quarter.get(part) or {}
                if item.get('count'):
                    result[name].extend((load(item) or {}).get('records') or [])
        return result
    except (requests.RequestException, ValueError, OSError, AttributeError, KeyError) as error:
        return {'reported': [], 'upcoming': [], 'error': str(error) or type(error).__name__}


def _day(value) -> str | None:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def report_dates(records: list[dict], pulse: dict) -> dict:
    """Each record's known report dates (`earnings_dates`, oldest first), from Earnings Pulse and TradingView's last
    earnings date, set in place; returns counts."""
    by_symbol: dict[str, set] = {}
    for row in pulse.get('reported') or []:
        day = _day(row.get('filing_day'))
        if row.get('symbol') and day and not row.get('isUpcoming'):
            by_symbol.setdefault(row['symbol'], set()).add(day)
    with_dates = 0
    for record in records:
        days = set(by_symbol.get(record['symbol'], set()))
        if record.get('latest_earnings_date'):
            days.add(record['latest_earnings_date'])
        record['earnings_dates'] = sorted(days)
        with_dates += bool(days)
    return {'pulse_reports': sum(len(days) for days in by_symbol.values()), 'records_with_dates': with_dates}


def reported_on(record: dict, quarter_end: date) -> str | None:
    """The quarter's report date: the first known one after its end, within REPORT_WINDOW. A record report_dates has
    not seen knows its last earnings date only."""
    known = record.get('earnings_dates')
    for day in known if known is not None else [record.get('latest_earnings_date')] if record.get('latest_earnings_date') else []:
        reported = date.fromisoformat(day)
        if quarter_end < reported <= quarter_end + REPORT_WINDOW:
            return day
    return None


def calendar(records: list[dict], pulse: dict, session: str, fetched_at: str) -> dict:
    """India's earnings_calendar.json for the US: one forthcoming report a stock, Earnings Pulse's (confirmed by the
    company) where it has one, else TradingView's next earnings date."""
    symbols = {record['symbol']: record for record in records}
    events = {}
    for row in pulse.get('upcoming') or []:
        day = _day(row.get('filing_day'))
        if row.get('symbol') in symbols and day and day >= session:
            events[row['symbol']] = {'scheduled_date': day, 'timing': row.get('timing'), 'source': 'EarningsPulse'}
    for symbol, record in symbols.items():
        day = record.get('next_earnings_date')
        if symbol not in events and day and day >= session:
            events[symbol] = {'scheduled_date': day, 'timing': TIMING.get(record.get('next_earnings_time')),
                              'source': 'TradingView'}
    return {'source': 'Earnings Pulse US results, TradingView next earnings dates', 'fetched_at': fetched_at, 'available': True,
            'events': sorted(({'symbol': symbol, 'company_name': symbols[symbol].get('name'), 'event_type': 'RESULTS_SCHEDULED',
                               **event} for symbol, event in events.items()),
                             key=lambda event: (event['scheduled_date'], event['symbol']))}
