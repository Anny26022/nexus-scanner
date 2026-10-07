"""Small announcement summaries, paged evidence, and reusable immutable objects."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from filing_classification import TAXONOMY, VERSION, classify_filings

RECENT_DAYS = 90
PAGE_SIZE = 100
IST = ZoneInfo('Asia/Kolkata')


def object_bytes(payload):
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return gzip.compress(raw, mtime=0)


def put_object(directory, payload):
    data = object_bytes(payload)
    digest = hashlib.sha256(data).hexdigest()
    path = directory / f'{digest}.json.gz'
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(data)
    return digest


def publication_time(value, reference_session):
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        stamp = datetime.fromisoformat(reference_session + 'T23:59:59+05:30')
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=IST)
    return stamp.astimezone(timezone.utc)


def filing_time(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=IST)
    return stamp.astimezone(timezone.utc)


def summary(filing, detail_page):
    classification = filing['classification']
    return {'id': filing['filingId'], 'publishedAt': filing_time(filing['news_date']).isoformat(),
            'headline': filing.get('caption') or filing.get('descriptor') or 'Company filing',
            'url': filing.get('file_url'), 'topics': classification['topics'],
            'status': classification['status'], 'detailPage': detail_page}


def build_announcements(payload, directory, symbols, reference_session):
    """Index filings through fetch time, independently of the EOD price cutoff."""
    cutoff = publication_time(payload.get('updated_at'), reference_session)
    oldest = cutoff - timedelta(days=RECENT_DAYS)
    index_oldest = cutoff - timedelta(days=7)
    taxonomy = put_object(directory, {'version': VERSION, 'topics': TAXONOMY})
    by_symbol = {row['symbol']: row for row in payload.get('records', []) if isinstance(row, dict) and row.get('symbol') in symbols}
    recent_index, manifests = [], {}
    for symbol in sorted(symbols):
        entry = by_symbol.get(symbol, {})
        filings = entry.get('filings') or []
        if any(not f.get('filingId') or f.get('classification', {}).get('version') != VERSION for f in filings):
            filings = classify_filings(filings)
        years = defaultdict(list)
        for filing in filings:
            stamp = filing_time(filing.get('news_date'))
            if stamp and stamp <= cutoff:
                years[stamp.astimezone(IST).year].append(filing)
        recent, history = [], {}
        for year, rows in sorted(years.items(), reverse=True):
            # Ascending pages keep old pages reusable as new filings arrive.
            rows.sort(key=lambda row: (filing_time(row['news_date']), row['filingId']))
            pages = []
            for start in range(0, len(rows), PAGE_SIZE):
                page = rows[start:start + PAGE_SIZE]
                details = put_object(directory, {'symbol': symbol, 'records': {f['filingId']: f for f in page}})
                summaries = [summary(f, details) for f in page]
                page_hash = put_object(directory, {'symbol': symbol, 'year': year, 'records': summaries})
                pages.append({'summary': page_hash, 'details': details, 'count': len(page)})
                for item in summaries:
                    stamp = filing_time(item['publishedAt'])
                    if stamp >= oldest:
                        recent.append(item)
                    if stamp >= index_oldest:
                        recent_index.append({'symbol': symbol, **item})
            history[str(year)] = pages
        recent.sort(key=lambda row: (row['publishedAt'], row['id']), reverse=True)
        manifests[symbol] = {'recent': put_object(directory, {'symbol': symbol, 'records': recent}),
                             'years': history, 'fetchStatus': entry.get('fetch_status', {})}
    recent_index.sort(key=lambda row: (row['publishedAt'], row['id'], row['symbol']), reverse=True)
    index = put_object(directory, {'referenceSession': reference_session, 'publishedAt': cutoff.isoformat(),
                                   'sinceLastClose': reference_session + 'T15:30:00+05:30',
                                   'records': recent_index})
    catalog = {'schemaVersion': 1, 'referenceSession': reference_session, 'publishedAt': cutoff.isoformat(),
               'recentDays': RECENT_DAYS, 'pageSize': PAGE_SIZE, 'taxonomy': taxonomy,
               'index': index, 'symbols': manifests}
    return put_object(directory, catalog)
