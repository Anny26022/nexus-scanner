"""US company filings from SEC EDGAR: India's filing history (ScanX company_filings + LODR) for the US market.

Each company's filing list (data.sec.gov/submissions/CIK##########.json, every filing since the 1990s with its form,
exact acceptance time, 8-K item codes and document) is cached per stock, gzip-compressed, keeping material forms
only: about 12 KB a stock, ~75 MB for the market (measured on 59 stocks, 2026-11-22; Form 4s and banks' structured-note
filings are 90% of all rows and are left out). It gives:

- past earnings dates: 8-Ks with item 2.02 (Results of Operations) carry the exact release time (AAPL: 46 since 2015).
  Foreign issuers report results on 6-K, which carries no item codes: telling a results 6-K from any other would need
  its document, so their past dates stay Earnings Pulse's and TradingView's;
- `filing_history.json.gz` in India's shape, which build_chart_artifacts publishes as each chart's announcements.

SEC's fair-access policy asks automated clients to name themselves with a contact address in the User-Agent and to stay
under 10 requests a second; the contact comes from the SEC_CONTACT environment variable (a repository secret), and
without it nothing is fetched. A company is fetched again when EDGAR's daily index shows a new material filing (about
300 listed companies a day), and monthly as a safety sweep.
"""

from __future__ import annotations

import gzip
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from . import dhan
from .calendar import EASTERN

TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json'
SUBMISSIONS_URL = 'https://data.sec.gov/submissions/{name}'
ARCHIVE_URL = 'https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}'
DIRECTORY = 'sec_filings'
HISTORY = 'filing_history.json'
# Without a readable daily index, a company is due a week after its fetch; with one, a month after (a safety sweep).
REFRESH_AFTER = timedelta(days=7)
SWEEP_AFTER = timedelta(days=30)
INDEX_URL = 'https://www.sec.gov/Archives/edgar/daily-index/{year}/QTR{quarter}/master.{day}.idx'
INDEX_STATE = '_daily_index.json'  # in DIRECTORY, so it travels with the cached filings
MAX_CATCH_UP = 30  # days of indexes read in one run; a longer gap falls back to the weekly rule
INTERVAL = 0.12  # under SEC's 10 requests a second, across workers
# Material forms (and their amendments): results and reports, events, registration, proxies, major holders.
MATERIAL = frozenset({'10-K', '10-Q', '8-K', '20-F', '40-F', '6-K', '10-KT', '10-QT', 'S-1', 'S-3', 'S-4', 'F-1',
                      'DEF 14A', 'DEFM14A', 'SC 13D', 'SC 13G', 'SC TO-T', '25-NSE', '15-12B'})
RESULTS_ITEM = '2.02'
ITEMS = {
    '1.01': 'Entry into a material agreement', '1.02': 'Termination of a material agreement', '1.03': 'Bankruptcy',
    '2.01': 'Acquisition or disposition of assets', '2.02': 'Results of operations and financial condition',
    '2.03': 'Creation of a financial obligation', '2.05': 'Exit or disposal costs', '2.06': 'Material impairments',
    '3.01': 'Delisting or transfer of listing', '3.02': 'Unregistered sales of equity', '3.03': 'Change to security holders\' rights',
    '4.01': 'Change of accountant', '4.02': 'Non-reliance on prior financial statements', '5.01': 'Change in control',
    '5.02': 'Directors or officers change', '5.03': 'Charter or bylaw amendments', '5.07': 'Shareholder vote',
    '7.01': 'Regulation FD disclosure', '8.01': 'Other events', '9.01': 'Financial statements and exhibits',
}


def user_agent() -> str | None:
    contact = (os.environ.get('SEC_CONTACT') or '').strip()
    return f'NexusScanner {contact}' if contact else None


def _get_json(url: str, get, agent: str):
    response = get(url, headers={'User-Agent': agent, 'Accept-Encoding': 'gzip, deflate'}, timeout=30)
    if response.status_code in (403, 429):
        raise dhan.Throttled(f'SEC answered {response.status_code}')
    response.raise_for_status()
    return response.json()


def sec_ticker(symbol: str) -> str:
    """SEC writes share classes with a hyphen (BRK-B), as Yahoo does."""
    return symbol.strip().upper().replace('.', '-')


def ciks(get, agent: str) -> dict[str, int]:
    payload = _get_json(TICKERS_URL, get, agent)
    column = {name: index for index, name in enumerate(payload['fields'])}
    return {row[column['ticker']]: row[column['cik']] for row in payload['data'] if row[column['ticker']]}


def _material(columns: dict, cik: int) -> list[dict]:
    rows = []
    for index, form in enumerate(columns.get('form') or []):
        if form.removesuffix('/A') not in MATERIAL:
            continue
        accession, document = columns['accessionNumber'][index], columns['primaryDocument'][index]
        rows.append({'form': form, 'accepted': columns['acceptanceDateTime'][index], 'date': columns['filingDate'][index],
                     'report_date': (columns.get('reportDate') or [''] * (index + 1))[index] or None,
                     'items': columns['items'][index] or '',
                     'url': ARCHIVE_URL.format(cik=cik, accession=accession.replace('-', ''), document=document)
                     if document else None})
    return rows


def fetch_company(cik: int, get, agent: str, pace=lambda: None) -> list[dict]:
    """Every material filing, newest first: the recent window plus the older pages it names."""
    pace()
    payload = _get_json(SUBMISSIONS_URL.format(name=f'CIK{cik:010d}.json'), get, agent)
    rows = _material(payload['filings']['recent'], cik)
    for older in payload['filings'].get('files') or []:
        pace()
        rows.extend(_material(_get_json(SUBMISSIONS_URL.format(name=older['name']), get, agent), cik))
    return sorted(rows, key=lambda row: row['accepted'], reverse=True)


def _path(root: Path, symbol: str) -> Path:
    return root / DIRECTORY / f'{symbol}.json.gz'


def read(root: Path, symbol: str) -> dict | None:
    try:
        return json.loads(gzip.decompress(_path(root, symbol).read_bytes()))
    except (OSError, ValueError):
        return None


def _index_url(day: date) -> str:
    return INDEX_URL.format(year=day.year, quarter=(day.month - 1) // 3 + 1, day=day.strftime('%Y%m%d'))


def filed_since(last: date, today: date, get, agent: str, pace) -> tuple[set, date]:
    """The CIKs with a material filing in EDGAR's daily indexes after `last`, through `today`, and the last day read.

    One small file a business day lists every filing made (366 KB on 2026-11-20: 4,136 filings, 300 by listed
    companies in material forms). SEC publishes the days in order, so a day without an index is a holiday only once a
    later day has one; until then (today's not published yet, or a past day not there yet) reading stops before it, and
    the next run reads it again.
    """
    filed, day, unresolved = set(), last, None
    while day < today:
        day += timedelta(days=1)
        if day.weekday() >= 5:
            continue
        pace()
        response = get(_index_url(day), headers={'User-Agent': agent, 'Accept-Encoding': 'gzip, deflate'}, timeout=30)
        if response.status_code in (403, 429):
            raise dhan.Throttled(f'SEC answered {response.status_code}')
        if response.status_code == 404:
            unresolved = unresolved or day
            continue
        response.raise_for_status()
        unresolved = None  # a later index exists: the missing days before it were holidays
        for line in response.text.splitlines():
            parts = line.split('|')
            if len(parts) == 5 and parts[0].isdigit() and parts[2].removesuffix('/A') in MATERIAL:
                filed.add(int(parts[0]))
    return filed, (unresolved - timedelta(days=1)) if unresolved else day


def _state(root: Path) -> dict:
    """The daily-index cursor and pending companies; a missing or malformed file counts as none (the first run)."""
    try:
        state = json.loads((root / DIRECTORY / INDEX_STATE).read_text())
        last = date.fromisoformat(state['last_index_day']) if state.get('last_index_day') else None
        pending = {int(cik) for cik in state.get('pending') or []}
        return {'last_index_day': last, 'pending': pending}
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return {'last_index_day': None, 'pending': set()}


def refresh(records: list[dict], root: Path, now: datetime | None = None, *, get=requests.get, interval: float = INTERVAL,
            workers: int = 4, budget_seconds: float = 900) -> dict:
    """Fetch the companies that are due, never-fetched first, until the time budget; returns counts.

    Due: never fetched; named in a daily index since the last run (a new material filing), or left over from a run
    that ran out of time; or a month old (a safety sweep). Without a readable index (the first run, a gap over
    MAX_CATCH_UP days, an error) the weekly rule stands in: due when a week old.
    """
    agent = user_agent()
    if not agent:
        return {'skipped': 'no SEC_CONTACT'}
    now = now or datetime.now(timezone.utc)
    deadline, pacer, stopped, lock = time.monotonic() + budget_seconds, dhan.Pacer(interval), threading.Event(), threading.Lock()

    def pace():
        pacer.wait()
        if stopped.is_set() or time.monotonic() > deadline:
            raise TimeoutError('stopped')

    try:
        pace()
        known = ciks(get, agent)
    except (requests.RequestException, ValueError, KeyError, TimeoutError, dhan.Throttled) as error:
        return {'error': f'SEC ticker list unavailable: {error}'}
    today = now.astimezone(EASTERN).date()
    state = _state(root)
    pending, last = state['pending'], state['last_index_day']
    filed, read_through, index_error = None, last, None
    if last and (today - last).days <= MAX_CATCH_UP:
        try:
            filed, read_through = filed_since(last, today, get, agent, pace)
        except (requests.RequestException, ValueError, TimeoutError, dhan.Throttled) as error:
            index_error = str(error)
    elif last:
        # Too long a gap to read day by day: this run uses the weekly rule, and the next resumes from yesterday.
        read_through = today - timedelta(days=1)
    wanted = (filed | pending) if filed is not None else None
    cached = {record['symbol']: read(root, record['symbol']) for record in records}

    def due(record):
        entry = cached[record['symbol']]
        if not entry:
            return True
        age = now - datetime.fromisoformat(entry['fetched_at'])
        cik = known[sec_ticker(record['symbol'])]
        if wanted is None:  # no index this run: pending companies stay due alongside the weekly rule
            return cik in pending or age > REFRESH_AFTER
        return cik in wanted or age > SWEEP_AFTER

    listed = [record for record in records if sec_ticker(record['symbol']) in known]
    queue = [record for record in listed if due(record)]
    queue.sort(key=lambda record: (cached[record['symbol']] is not None, (cached[record['symbol']] or {}).get('fetched_at', '')))
    counts = {'companies': len(listed), 'due': len(queue), 'fetched': 0, 'failed': 0,
              'index': 'unavailable: ' + index_error if index_error else ('read' if filed is not None else 'not used')}
    fetched = set()

    def one(record):
        if stopped.is_set() or time.monotonic() > deadline:
            return
        cik = known[sec_ticker(record['symbol'])]
        try:
            filings = fetch_company(cik, get, agent, pace)
        except TimeoutError:
            return
        except dhan.Throttled:
            stopped.set()
            outcome = 'failed'
        except (requests.RequestException, ValueError, KeyError, TypeError):
            outcome = 'failed'
        else:
            path = _path(root, record['symbol'])
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix('.tmp')
            temporary.write_bytes(gzip.compress(json.dumps({'cik': cik, 'fetched_at': now.isoformat(), 'filings': filings},
                                                           separators=(',', ':')).encode(), compresslevel=9, mtime=0))
            temporary.replace(path)
            outcome = 'fetched'
            with lock:
                fetched.add(cik)
        with lock:
            counts[outcome] += 1

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, queue))
    # Companies the index named but this run did not reach stay pending; the index is read from where it stopped.
    listed_ciks = {known[sec_ticker(record['symbol'])] for record in listed}
    left = sorted(((wanted if wanted is not None else pending) & listed_ciks) - fetched)
    state_path = root / DIRECTORY / INDEX_STATE
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({'last_index_day': (read_through or today - timedelta(days=1)).isoformat(),
                                      'pending': left}))
    return {**counts, 'pending': len(left), 'throttled': stopped.is_set()}


def result_dates(root: Path, symbol: str) -> list[str]:
    """The New York dates of the company's results releases (8-K item 2.02), oldest first."""
    days = set()
    for filing in (read(root, symbol) or {}).get('filings', []):
        if filing['form'].startswith('8-K') and RESULTS_ITEM in filing['items'].split(','):
            stamp = datetime.fromisoformat(filing['accepted'].replace('Z', '+00:00'))
            days.add(stamp.astimezone(EASTERN).date().isoformat())
    return sorted(days)


def caption(filing: dict) -> str:
    items = [ITEMS.get(item.strip(), item.strip()) for item in filing['items'].split(',') if item.strip() and item.strip() != '9.01']
    return f"{filing['form']}: {'; '.join(items)}" if items else filing['form']


def history(records: list[dict], root: Path, updated_at: str) -> dict:
    """India's filing_history.json (fetch_company_filings.py) from the cached filings, for build_chart_artifacts."""
    entries = []
    for record in sorted(records, key=lambda record: record['symbol']):
        cached = read(root, record['symbol'])
        if not cached:
            continue
        entries.append({'symbol': record['symbol'], 'filings': [
            {'news_date': filing['accepted'], 'caption': caption(filing), 'descriptor': filing['form'], 'cat': filing['form'],
             'file_url': filing['url'], 'source_endpoint': 'sec_edgar'} for filing in cached['filings']]})
    return {'source': 'SEC EDGAR submissions (material forms)', 'updated_at': updated_at,
            'coverage': {'companies': len(entries), 'filings': sum(len(entry['filings']) for entry in entries)},
            'records': entries}
