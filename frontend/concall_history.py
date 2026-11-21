"""Concall summaries: one immutable R2 object per concluded call, and a small index of what is stored.

The provider lists concluded calls newest first. A run walks that list only until it reaches a page whose calls are
all stored, fetches the new ones in parallel, and never fetches a stored call again. Calls whose summary was not
ready are kept in the index without an object and retried on later runs. The weekly refresh walks the whole list
(--full) to pick up calls the provider adds out of order.

    python frontend/concall_history.py           # daily: new calls only
    python frontend/concall_history.py --full    # weekly: whole list, still only fetching what is missing
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
from zoneinfo import ZoneInfo

import requests

from chart_publication import R2Store, write_json

API = 'https://askfuzz.ai/api/v1/concall'
HEADERS = {'Content-Type': 'application/json', 'Origin': 'https://askfuzz.ai',
           'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
OUTPUT = Path(__file__).parent / 'public/data/concalls/index.json'
REPORT = Path(__file__).parent / 'concall-refresh-report.json'
PAGE_SIZE = 100
WORKERS = 6
MAX_DAILY_ATTEMPTS = 22
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,127}')
# Provider identifiers and per-viewer flags; the recording link is pre-signed and expires within days.
PRIVATE_FIELDS = frozenset({'call_recording_url', 'stream_sid', 'news_id', 'reminder_set', 'calendar_set',
                            'diamond_link', 'live_data', 'seo_symbol'})


def post(session, path, body):
    for attempt in range(3):
        try:
            response = session.post(f'{API}/{path}', json=body, headers=HEADERS, timeout=(10, 60))
            response.raise_for_status()
            payload = response.json()
            if payload.get('status') != 'success':
                raise ValueError(f"Provider answered {payload.get('status')!r}: {payload.get('message')}")
            return payload.get('data') or {}
        except (requests.RequestException, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def list_page(session, page):
    data = post(session, 'concluded', dict(page=page, page_size=PAGE_SIZE, quarter='all', search='', sector='',
                                           market_cap=''))
    rows, pagination = data.get('concalls'), data.get('pagination') or {}
    if not isinstance(rows, list):
        raise ValueError('Invalid concall list')
    for row in rows:
        if not isinstance(row, dict) or not SLUG.fullmatch(str(row.get('slug_id', ''))) \
                or not str(row.get('company_symbol') or '').strip():
            raise ValueError('Invalid concall identity')
    return rows, bool(pagination.get('has_next'))


def fetch_detail(session, slug):
    detail = post(session, 'live-call/get-by-slug', {'slug': slug})
    if detail.get('slug_id') not in (None, slug):
        raise ValueError(f'Provider returned {detail.get("slug_id")} for {slug}')
    return detail


def iso_date(value):
    """ISO date from the provider's list ('05 November 2026') or detail ('2026-11-05'); relative ones are None."""
    for pattern in ('%Y-%m-%d', '%d %B %Y'):
        try:
            return datetime.strptime(str(value), pattern).date().isoformat()
        except ValueError:
            pass
    return None


def entry_for(row, previous=None):
    """The index entry for a list row; what an earlier run stored for it is kept."""
    entry = dict(previous or {})
    entry.update({key: value for key, value in {
        'symbol': row['company_symbol'].strip(), 'isin': row.get('isin') or None, 'name': row.get('company_name'),
        'quarter': row.get('concall_quarter'), 'sector': row.get('sector'), 'subSector': row.get('sub_sector'),
        'marketCapType': row.get('market_cap_type'), 'filing': row.get('pdf_link') or None,
    }.items() if value is not None})
    entry['date'] = entry.get('date') or iso_date(row.get('concall_date'))
    entry.setdefault('object', None)
    return entry


def pack(folder, store, slug, detail):
    record = {key: value for key, value in detail.items() if key not in PRIVATE_FIELDS}
    payload = {'schemaVersion': 1, 'slug': slug, 'call': record}
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    compressed = gzip.compress(raw, mtime=0)
    digest = hashlib.sha256(compressed).hexdigest()
    (folder / f'{digest}.json.gz').write_bytes(compressed)
    return {'sha256': digest, 'url': f'{store.base_url}/objects/{digest}.json.gz', 'bytes': len(compressed)}


def refresh(output, store, list_page, fetch_detail, *, full, checked_at, workers=WORKERS):
    """Add the calls the provider lists that are not stored yet; returns a report."""
    previous = json.loads(output.read_text()) if output.exists() else {'version': 1, 'calls': {}}
    if previous.get('version') != 1 or not isinstance(previous.get('calls'), dict):
        raise ValueError('Invalid concall index; refusing to discard it')
    calls = {slug: dict(entry) for slug, entry in previous['calls'].items()}
    report = {'checkedAt': checked_at, 'full': full, 'pages': 0, 'listed': 0, 'added': 0, 'pending': 0, 'errors': {}}

    page = 1
    while True:
        try:
            rows, has_next = list_page(page)
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            # Nothing listed is lost: what was read so far is still fetched, the rest waits for the next run.
            report['errors'][f'list-page-{page}'] = str(error)
            break
        report['pages'], report['listed'] = page, report['listed'] + len(rows)
        all_stored = bool(rows) and all((calls.get(row['slug_id']) or {}).get('object') for row in rows)
        for row in rows:
            calls[row['slug_id']] = entry_for(row, calls.get(row['slug_id']))
        if not has_next or not rows or (all_stored and not full):
            break
        page += 1

    # A call whose summary never appears is retried daily for a month, then only by the weekly full walk.
    wanted = sorted((slug for slug, entry in calls.items()
                     if not entry.get('object') and (full or entry.get('attempts', 0) < MAX_DAILY_ATTEMPTS)),
                    key=lambda slug: calls[slug].get('date') or '', reverse=True)
    with tempfile.TemporaryDirectory(prefix='concalls-') as name:
        folder = Path(name)

        def one(slug):
            try:
                detail = fetch_detail(slug)
            except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                return slug, None, str(error)
            if not str(detail.get('markdown_summary') or '').strip():
                return slug, None, 'summary not ready'
            return slug, detail, None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for slug, detail, error in pool.map(one, wanted):
                entry = calls[slug]
                if detail is None:
                    entry['attempts'] = entry.get('attempts', 0) + 1
                    entry['lastError'] = error
                    report['pending'] += 1
                    continue
                entry.pop('attempts', None)
                entry.pop('lastError', None)
                entry['date'] = iso_date(detail.get('concall_date')) or entry.get('date')
                entry['time'] = detail.get('concall_time') or entry.get('time')
                entry['object'] = pack(folder, store, slug, detail)
                report['added'] += 1
        if report['added']:
            store.upload_objects(folder)

    if calls != previous['calls']:
        ordered = dict(sorted(calls.items(), key=lambda item: (item[1].get('date') or '', item[0]), reverse=True))
        write_json(output, {'version': 1, 'checkedAt': checked_at, 'count': len(ordered),
                            'stored': sum(bool(entry.get('object')) for entry in ordered.values()), 'calls': ordered})
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--full', action='store_true', help='walk the whole list instead of stopping at stored calls')
    parser.add_argument('--workers', type=int, default=WORKERS)
    args = parser.parse_args(argv)
    now = datetime.now(ZoneInfo('Asia/Kolkata')).isoformat()
    store = R2Store()
    local = threading.local()

    def session():
        if not hasattr(local, 'session'):
            local.session = requests.Session()
        return local.session

    started = time.perf_counter()
    report = refresh(OUTPUT, store, lambda page: list_page(session(), page),
                     lambda slug: fetch_detail(session(), slug), full=args.full, checked_at=now, workers=args.workers)
    report['seconds'] = round(time.perf_counter() - started, 1)
    write_json(REPORT, report)
    print(json.dumps(report), flush=True)
    if report['errors']:
        print('::warning::Concall refresh incomplete; see concall-refresh-report.json', flush=True)
    return int(bool(report['errors']))


if __name__ == '__main__':
    sys.exit(main())
