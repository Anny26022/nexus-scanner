"""Concall summaries: one immutable R2 object per concluded call, a small index of what is stored, and the schedule.

The provider lists concluded calls newest first. A run walks that list only until it reaches a page whose calls are
all stored and fetches the new ones in parallel. Calls whose summary was not ready are kept in the index without an
object and retried on later runs. The weekly refresh walks the whole list (--full) to pick up calls the provider
adds out of order.

The provider has no "updated" field but does revise summaries, sometimes weeks later in batches. So stored calls are
fetched again on a schedule and compared by content hash: daily for the last two days' calls, weekly for the last 7
days plus a rotating eighth of older ones (every call about every two months). An unchanged call uploads nothing.
Each call keeps exactly one object: a revised call's previous object is deleted on the next run, once the index
naming its replacement is live (a run pulls the live index before it starts).

Upcoming calls and today's (with their live status) are rewritten to concalls/upcoming.json on every run.

    python frontend/concall_history.py           # daily
    python frontend/concall_history.py --full    # weekly
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
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
UPCOMING = Path(__file__).parent / 'public/data/concalls/upcoming.json'
REPORT = Path(__file__).parent / 'concall-refresh-report.json'
PAGE_SIZE = 100
# The provider tops out near 7 calls/s: past ~16 at once, each call just takes longer.
WORKERS = 16
# The provider has calls that never get a summary (about 270 of 2,500, mostly older ones); retrying them daily
# would add about a minute to every run.
DAILY_RETRY_DAYS = 14
RECHECK_DAILY_DAYS = 2
RECHECK_WEEKLY_DAYS = 7
# A call still without a summary after this long is retried only in the weekly rotation.
PENDING_WEEKLY_DAYS = 90
RECHECK_ROTATION = 8
# Fetched calls are uploaded and the index rewritten after each batch, so a run cut short keeps its progress.
BATCH = 250
# Far beyond the ~26 pages the provider has; stops a runaway walk if it keeps answering has_next.
MAX_PAGES = 200
# Symbols such as M&M and J&KBANK keep their '&' in the slug.
SLUG = re.compile(r'[a-z0-9&][a-z0-9&-]{0,127}')
# Provider identifiers and per-viewer flags; the recording link is pre-signed and expires within days.
# The sign-up link (diamond_link) is dropped too: it is useless once a call is over. The schedule publishes it,
# since the list is fetched without an account and so carries the organiser's one public link for every viewer.
PRIVATE_FIELDS = frozenset({'call_recording_url', 'stream_sid', 'news_id', 'reminder_set', 'calendar_set',
                            'diamond_link', 'live_data', 'seo_symbol'})


def post(session, path, body):
    for attempt in range(3):
        try:
            response = session.post(f'{API}/{path}', json=body, headers=HEADERS, timeout=(10, 60))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError('Invalid provider response')
            if payload.get('status') != 'success':
                raise ValueError(f"Provider answered {payload.get('status')!r}: {payload.get('message')}")
            data = payload.get('data')
            if data is not None and not isinstance(data, dict):
                raise ValueError('Invalid provider response data')
            return data or {}
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
    # A malformed row (the provider has listed '-q1-fy27') is skipped; it must not hide the rest of the page.
    valid = [row for row in rows if isinstance(row, dict) and SLUG.fullmatch(str(row.get('slug_id', '')))
             and str(row.get('company_symbol') or '').strip()]
    if len(valid) < len(rows):
        print(f'WARNING: skipped {len(rows) - len(valid)} malformed concall rows on page {page}', flush=True)
    return valid, bool(pagination.get('has_next'))


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


def pack(folder, store, slug, detail, current=None):
    """The object for a call, written to folder unless it is the one already stored (current)."""
    record = {key: value for key, value in detail.items() if key not in PRIVATE_FIELDS}
    payload = {'schemaVersion': 1, 'slug': slug, 'call': record}
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    compressed = gzip.compress(raw, mtime=0)
    digest = hashlib.sha256(compressed).hexdigest()
    if current and current.get('sha256') == digest:
        return current
    (folder / f'{digest}.json.gz').write_bytes(compressed)
    return {'sha256': digest, 'url': f'{store.base_url}/objects/{digest}.json.gz', 'bytes': len(compressed)}


def write_index(output, calls, checked_at):
    ordered = dict(sorted(calls.items(), key=lambda item: (item[1].get('date') or '', item[0]), reverse=True))
    write_json(output, {'version': 1, 'checkedAt': checked_at, 'count': len(ordered),
                        'stored': sum(bool(entry.get('object')) for entry in ordered.values()), 'calls': ordered})


def refresh(output, store, list_page, fetch_detail, *, full, checked_at, workers=WORKERS, progress=None,
            delete=None):
    """Add the calls the provider lists that are not stored yet; returns a report.

    progress(report) is called after each batch, so a run that is stopped part-way still leaves its report.
    delete(name) removes one object from R2; superseded objects are kept until it succeeds.
    """
    previous = json.loads(output.read_text()) if output.exists() else {'version': 1, 'calls': {}}
    if previous.get('version') != 1 or not isinstance(previous.get('calls'), dict):
        raise ValueError('Invalid concall index; refusing to discard it')
    calls = {slug: dict(entry) for slug, entry in previous['calls'].items()}
    # Detailed errors stay in this report (a run artifact); the published index carries only a status.
    report = {'checkedAt': checked_at, 'full': full, 'pages': 0, 'listed': 0, 'added': 0, 'pending': 0,
              'rechecked': 0, 'updated': 0, 'deleted': 0, 'failures': {}, 'errors': {}}
    today = checked_at[:10]

    # The index this run starts from is the live one, so it already names the replacements of these objects.
    for slug, entry in calls.items():
        kept = []
        for digest in entry.get('superseded', ()):
            if digest == (entry.get('object') or {}).get('sha256'):
                continue
            try:
                if delete is None:
                    raise RuntimeError('no delete configured')
                delete(f'{digest}.json.gz')
                report['deleted'] += 1
            except Exception as error:  # noqa: BLE001 - kept for the next run
                kept.append(digest)
                report['failures'][slug] = f'delete superseded: {error}'
        if kept:
            entry['superseded'] = kept
        else:
            entry.pop('superseded', None)

    page = 1
    while True:
        try:
            rows, has_next = list_page(page)
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            # Nothing listed is lost: what was read so far is still fetched, the rest waits for the next run.
            report['errors'][f'list-page-{page}'] = str(error)
            break
        report['pages'], report['listed'] = page, report['listed'] + len(rows)
        # A page whose rows were all malformed comes back empty; has_next still decides whether to go on.
        all_stored = bool(rows) and all((calls.get(row['slug_id']) or {}).get('object') for row in rows)
        for row in rows:
            entry = calls[row['slug_id']] = entry_for(row, calls.get(row['slug_id']))
            if not entry.get('date'):
                # The provider lists recent calls as 'Today' or 'Yesterday'; their age is counted from here.
                entry.setdefault('firstSeen', today)
        if not has_next or (all_stored and not full):
            break
        if page >= MAX_PAGES:
            report['errors']['list'] = f'stopped after {MAX_PAGES} pages'
            break
        page += 1

    # Every call is tried once. A call still without a summary is retried daily while it is under two weeks old,
    # then only by the weekly full walk.
    day = date.fromisoformat(today)
    since = lambda days: (day - timedelta(days=days)).isoformat()
    # A continuous week count: ISO week numbers restart at New Year and would skip part of the rotation.
    week = day.toordinal() // 7

    def rotating(slug):
        return int(hashlib.sha256(slug.encode()).hexdigest()[:8], 16) % RECHECK_ROTATION == week % RECHECK_ROTATION

    def due(slug, entry):
        if entry.get('object'):
            # A stored call is fetched again to catch revisions; never twice on the same day.
            if entry.get('checked') == today:
                return False
            when = entry.get('date') or ''
            if when >= since(RECHECK_DAILY_DAYS):
                return True
            return full and (when >= since(RECHECK_WEEKLY_DAYS) or rotating(slug))
        if not entry.get('attempts'):
            return True
        when = entry.get('date') or entry.get('firstSeen') or today
        if full:
            return when >= since(PENDING_WEEKLY_DAYS) or rotating(slug)
        return when >= since(DAILY_RETRY_DAYS)

    wanted = sorted((slug for slug, entry in calls.items() if due(slug, entry)),
                    key=lambda slug: calls[slug].get('date') or '', reverse=True)
    def one(slug):
        try:
            detail = fetch_detail(slug)
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            return slug, None, 'provider request failed', str(error)
        if not str(detail.get('markdown_summary') or '').strip():
            return slug, None, 'summary not ready', 'summary not ready'
        return slug, detail, None, None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for start in range(0, len(wanted), BATCH):
            with tempfile.TemporaryDirectory(prefix='concalls-') as name:
                folder, added = Path(name), 0
                for slug, detail, status, error in pool.map(one, wanted[start:start + BATCH]):
                    entry = calls[slug]
                    current = entry.get('object')
                    if current:
                        report['rechecked'] += 1
                        if detail is None:
                            # A failed or emptied re-check keeps the stored version.
                            report['failures'][slug] = f'recheck: {error}'
                            continue
                        entry['checked'] = today
                        revised = pack(folder, store, slug, detail, current)
                        if revised is not current:
                            # The previous object goes on the next run, after this index is live.
                            entry['superseded'] = [*entry.get('superseded', ()), current['sha256']]
                            entry['object'], entry['updated'] = revised, today
                            report['updated'] += 1
                            added += 1
                        continue
                    if detail is None:
                        entry['attempts'] = entry.get('attempts', 0) + 1
                        entry['status'] = status
                        report['pending'] += 1
                        report['failures'][slug] = error
                        continue
                    for key in ('attempts', 'status', 'lastError', 'firstSeen'):
                        entry.pop(key, None)
                    entry['date'] = iso_date(detail.get('concall_date')) or entry.get('date')
                    entry['time'] = detail.get('concall_time') or entry.get('time')
                    entry['object'] = pack(folder, store, slug, detail)
                    entry['checked'] = today
                    report['added'] += 1
                    added += 1
                if added:
                    # Objects go up before the index names them.
                    store.upload_objects(folder)
            write_index(output, calls, checked_at)
            if progress:
                progress(report)

    if calls != previous['calls']:
        write_index(output, calls, checked_at)
    return report


def call_state(status):
    """The schedule's state for a provider call_status."""
    if status in (None, '', 'not_started'):
        return 'scheduled'
    return 'concluded' if status == 'generating_summary_end' else 'live'


def fetch_upcoming(session):
    rows = []
    for page in range(1, 21):
        data = post(session, 'upcoming', dict(page=page, page_size=PAGE_SIZE))
        batch = data.get('concalls')
        if not isinstance(batch, list):
            raise ValueError('Invalid upcoming list')
        rows.extend(batch)
        if not (data.get('pagination') or {}).get('has_next'):
            return rows
    return rows


def fetch_today(session):
    for attempt in range(3):
        try:
            response = session.get(f'{API}/todays-calls', headers=HEADERS, timeout=(10, 60))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get('status') != 'success' \
                    or not isinstance(payload.get('data') or [], list):
                raise ValueError('Invalid today\'s calls response')
            return payload.get('data') or []
        except (requests.RequestException, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def refresh_upcoming(output, fetch_upcoming, fetch_today, *, checked_at):
    """Rewrite the schedule: upcoming calls, and today's with their live state. A failed fetch keeps the last one."""
    try:
        upcoming, today = fetch_upcoming(), fetch_today()
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        return {'error': str(error)}
    calls = {}
    for row in upcoming:
        if not isinstance(row, dict):
            continue
        slug = str(row.get('slug_id') or '')
        if not SLUG.fullmatch(slug) or not str(row.get('company_symbol') or '').strip():
            continue
        registration = row.get('diamond_link')
        calls[slug] = {key: value for key, value in {
            'slug': slug, 'symbol': row['company_symbol'].strip(), 'isin': row.get('isin') or None,
            'name': row.get('company_name'), 'quarter': row.get('concall_quarter'),
            'date': iso_date(row.get('concall_date')), 'time': row.get('concall_time'), 'sector': row.get('sector'),
            'subSector': row.get('sub_sector'), 'marketCapType': row.get('market_cap_type'),
            'agenda': row.get('concall_agenda'), 'online': row.get('online_flag') == 'true',
            # The organiser's public sign-up page for joining the call.
            'registration': registration if str(registration or '').startswith('https://') else None,
            'filing': row.get('pdf_link') or None, 'state': call_state(row.get('call_status')),
        }.items() if value not in (None, '')}
    for row in today:
        if not isinstance(row, dict):
            continue
        slug = str(row.get('slug') or '')
        state = call_state(row.get('call_status'))
        if not SLUG.fullmatch(slug) or not str(row.get('symbol') or '').strip() or state == 'concluded':
            continue
        entry = calls.setdefault(slug, {'slug': slug, 'symbol': row['symbol'].strip(), 'name': row.get('company_name')})
        entry.update({key: value for key, value in {'date': iso_date(row.get('concall_date')),
                                                    'time': row.get('concall_time')}.items() if value})
        entry['state'] = state
    ordered = sorted(calls.values(), key=lambda entry: (entry.get('date') or '', entry.get('time') or '', entry['slug']))
    write_json(output, {'version': 1, 'checkedAt': checked_at, 'count': len(ordered), 'calls': ordered})
    return {'scheduled': sum(entry['state'] == 'scheduled' for entry in ordered),
            'live': sum(entry['state'] == 'live' for entry in ordered)}


# rclone's exit status when the file is not there.
RCLONE_FILE_NOT_FOUND = 4


def delete_object(store, name):
    """Delete objects/<name> from R2; an object that is already gone counts as deleted, so retries settle."""
    try:
        store.cache_command('deletefile', store.remote(f'objects/{name}'))
    except subprocess.CalledProcessError as error:
        if error.returncode != RCLONE_FILE_NOT_FOUND:
            raise


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
                     lambda slug: fetch_detail(session(), slug), full=args.full, checked_at=now, workers=args.workers,
                     progress=lambda partial: write_json(REPORT, partial),
                     delete=lambda name: delete_object(store, name))
    report['upcoming'] = refresh_upcoming(UPCOMING, lambda: fetch_upcoming(session()), lambda: fetch_today(session()),
                                          checked_at=now)
    if 'error' in report['upcoming']:
        report['errors']['upcoming'] = report['upcoming']['error']
    report['seconds'] = round(time.perf_counter() - started, 1)
    write_json(REPORT, report)
    print(json.dumps(report), flush=True)
    if report['errors']:
        print('::warning::Concall refresh incomplete; see concall-refresh-report.json', flush=True)
    return int(bool(report['errors']))


if __name__ == '__main__':
    sys.exit(main())
