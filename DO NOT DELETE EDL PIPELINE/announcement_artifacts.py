"""Small announcement summaries, paged evidence, and reusable immutable objects."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import sys
import zlib
from pathlib import Path
from zoneinfo import ZoneInfo
from functools import lru_cache

from filing_classification import TAXONOMY, VERSION, classify_filings

RECENT_DAYS = 90
PAGE_SIZE = 100
IST = ZoneInfo('Asia/Kolkata')


def object_bytes(payload):
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return gzip.compress(raw, mtime=0)


def put_object(directory, payload, cache=None, used=None):
    if cache is None:
        data = object_bytes(payload)
    else:
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        version = f'{sys.version_info[:3]}:{zlib.ZLIB_RUNTIME_VERSION}'
        cached = cache / (hashlib.sha256(version.encode() + raw).hexdigest() + '.json.gz')
        if used is not None:
            used.add(cached.name)
        try:
            data = cached.read_bytes()
            if cached.with_suffix('.sha256').read_text() != hashlib.sha256(data).hexdigest():
                raise ValueError('Cached object bytes changed')
            if gzip.decompress(data) != raw:
                raise ValueError('Cached object input mismatch')
        except (OSError, ValueError, EOFError, zlib.error):
            data = gzip.compress(raw, mtime=0)
            try:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(data)
                cached.with_suffix('.sha256').write_text(hashlib.sha256(data).hexdigest())
            except OSError:
                pass  # Optional acceleration never changes publication success.
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
    return _filing_time(str(value))


@lru_cache(maxsize=16384)
def _filing_time(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=IST)
    return stamp.astimezone(timezone.utc)


def summary(filing, detail_page, stamp=None):
    classification = filing['classification']
    return {'id': filing['filingId'], 'publishedAt': (stamp or filing_time(filing['news_date'])).isoformat(),
            'headline': filing.get('caption') or filing.get('descriptor') or 'Company filing',
            'url': filing.get('file_url'), 'topics': classification['topics'],
            'status': classification['status'], 'detailPage': detail_page}


def build_announcements(payload, directory, symbols, reference_session, cache=None):
    """Index filings through fetch time, independently of the EOD price cutoff."""
    cutoff = publication_time(payload.get('updated_at'), reference_session)
    oldest = cutoff - timedelta(days=RECENT_DAYS)
    index_oldest = cutoff - timedelta(days=7)
    used = set()
    put = lambda value: put_object(directory, value, cache, used)
    taxonomy = put({'version': VERSION, 'topics': TAXONOMY})
    records = payload.get('records', [])
    if isinstance(records, list):
        by_symbol = {row['symbol']: row for row in records if isinstance(row, dict) and row.get('symbol') in symbols}
        entries = ((symbol, by_symbol.get(symbol, {})) for symbol in sorted(symbols))
    else:
        # The pipeline emits unique companies in symbol order. Keep only one
        # company's evidence resident; missing companies still get manifests.
        def streamed_entries():
            seen = set()
            for row in records:
                if isinstance(row, dict) and row.get('symbol') in symbols:
                    if row['symbol'] in seen:
                        raise ValueError('Duplicate streamed filing symbol: ' + row['symbol'])
                    seen.add(row['symbol'])
                    yield row['symbol'], row
            for symbol in sorted(symbols - seen):
                yield symbol, {}
        entries = streamed_entries()
    recent_index, manifests = [], {}
    for symbol, entry in entries:
        filings = entry.get('filings') or []
        if any(not f.get('filingId') or f.get('classification', {}).get('version') != VERSION for f in filings):
            filings = classify_filings(filings)
        years = defaultdict(list)
        for filing in filings:
            stamp = filing_time(filing.get('news_date'))
            if stamp and stamp <= cutoff:
                years[stamp.astimezone(IST).year].append((filing, stamp))
        recent, history = [], {}
        for year, rows in sorted(years.items(), reverse=True):
            # Ascending pages keep old pages reusable as new filings arrive.
            rows.sort(key=lambda item: (item[1], item[0]['filingId']))
            pages = []
            for start in range(0, len(rows), PAGE_SIZE):
                page = rows[start:start + PAGE_SIZE]
                details = put({'symbol': symbol, 'records': {f['filingId']: f for f, stamp in page}})
                summaries = [summary(f, details, stamp) for f, stamp in page]
                page_hash = put({'symbol': symbol, 'year': year, 'records': summaries})
                pages.append({'summary': page_hash, 'details': details, 'count': len(page)})
                for item, (_, stamp) in zip(summaries, page):
                    if stamp >= oldest:
                        recent.append(item)
                    if stamp >= index_oldest:
                        recent_index.append({'symbol': symbol, **item})
            history[str(year)] = pages
        recent.sort(key=lambda row: (row['publishedAt'], row['id']), reverse=True)
        manifests[symbol] = {'recent': put({'symbol': symbol, 'records': recent}),
                             'years': history, 'fetchStatus': entry.get('fetch_status', {})}
    recent_index.sort(key=lambda row: (row['publishedAt'], row['id'], row['symbol']), reverse=True)
    index = put({'referenceSession': reference_session, 'publishedAt': cutoff.isoformat(),
                                   'sinceLastClose': reference_session + 'T15:30:00+05:30',
                                   'records': recent_index})
    catalog = {'schemaVersion': 1, 'referenceSession': reference_session, 'publishedAt': cutoff.isoformat(),
               'recentDays': RECENT_DAYS, 'pageSize': PAGE_SIZE, 'taxonomy': taxonomy,
               'index': index, 'symbols': manifests}
    result = put(catalog)
    # This private acceleration cache retains only the current release's
    # objects. Public immutable objects and historical evidence are untouched.
    if cache is not None:
        try:
            for cached in cache.glob('*.json.gz'):
                if cached.name not in used:
                    cached.unlink()
                    cached.with_suffix('.sha256').unlink(missing_ok=True)
        except OSError:
            pass
    return result
