"""Optional earnings history: verified R2 objects, with a small Git-owned index."""
import argparse
from datetime import date, datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

import requests

from chart_publication import R2Store, write_json

SOURCE = 'https://earningspulse.ai/earnings'
START = '2024-Q3'
OUTPUT = Path(__file__).parent / 'public/data/earningspulse/index.json'
REPORT = Path(__file__).parent / 'earningspulse-refresh-report.json'


def quarter_bounds(label):
    if not re.fullmatch(r'20\d{2}-Q[1-4]', label):
        raise ValueError('Invalid calendar quarter')
    year, quarter = int(label[:4]), int(label[-1])
    start = date(year, quarter * 3 - 2, 1)
    end = date(year + (quarter == 4), quarter * 3 % 12 + 1, 1) - timedelta(days=1)
    return start, end


def quarters_until(today):
    start, _ = quarter_bounds(START)
    labels = []
    while start <= today:
        label = f'{start.year}-Q{(start.month - 1) // 3 + 1}'
        labels.append(label)
        start = quarter_bounds(label)[1] + timedelta(days=1)
    return labels


def parse_quarter(text, label):
    """Read JSON values from Flight without executing scripts or assuming line IDs."""
    def value(key):
        marker = json.dumps(key) + ':'
        return json.JSONDecoder().raw_decode(text[text.index(marker) + len(marker):])[0]
    start, end = quarter_bounds(label)
    if value('fetchError') is not False:
        raise ValueError('Provider reported a fetch failure')
    dates = value('allDates')
    if not isinstance(dates, list) or not dates or (dates[0], dates[-1]) != (start.isoformat(), end.isoformat()):
        raise ValueError('Provider returned a different quarter')
    rows = value('results')
    if not isinstance(rows, list):
        raise ValueError('Invalid earnings collection')
    unique = {}
    required = {'symbol', 'quality', 'quarter_label', 'filing_day', 'market', 'isUpcoming', 'attachment_url'}
    for row in rows:
        if not isinstance(row, dict) or not required.issubset(row) or not isinstance(row.get('symbol'), str) or not row['symbol'].strip():
            raise ValueError('Invalid earnings identity or schema')
        day = date.fromisoformat(row['filing_day'])
        if not start <= day <= end or row.get('market') != 'IN' or type(row.get('isUpcoming')) is not bool:
            raise ValueError('Invalid earnings date, market or publication status')
        if not row['isUpcoming'] and (not isinstance(row.get('quarter_label'), str) or not row['quarter_label'].strip()):
            raise ValueError('Missing fiscal quarter on a published event')
        if not row['isUpcoming'] and not {'revenue', 'net_income', 'eps'}.issubset(row):
            raise ValueError('Missing financial fields on a published event')
        key = (row['symbol'], row.get('quarter_label') or '', row['filing_day'])
        if key in unique and unique[key] != row:
            raise ValueError('Conflicting duplicate earnings event')
        unique[key] = row
    rows = [unique[key] for key in sorted(unique)]
    # Reject NaN and Infinity before writing any objects.
    json.dumps(rows, allow_nan=False)
    return rows


def fetch_quarter(session, label, today):
    start, _ = quarter_bounds(label)
    anchor = start.replace(month=start.month + 1, day=15)
    monday = today - timedelta(days=today.weekday())
    params = dict(range='quarter', liquidity='all', market='IN', week=(anchor - monday).days // 7)
    for attempt in range(2):
        try:
            response = session.get(SOURCE, params=params, headers={'RSC': '1'}, timeout=(10, 60))
            response.raise_for_status()
            return parse_quarter(response.text, label)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            if attempt:
                raise
            time.sleep(1)


def refresh(output, store, fetch, *, today, checked_at, recheck_oldest=False):
    previous = json.loads(output.read_text()) if output.exists() else {'version': 1, 'source': SOURCE, 'quarters': {}}
    if previous.get('version') != 1 or previous.get('source') != SOURCE or not isinstance(previous.get('quarters'), dict):
        raise ValueError('Invalid earnings history index; refusing to discard it')
    entries = dict(previous['quarters'])
    labels = quarters_until(today)
    selected = set(labels[-2:]) | (set(labels) - entries.keys())
    older = [label for label in labels[:-2] if label in entries]
    if recheck_oldest and older:
        selected.add(min(older, key=lambda label: entries[label]['checkedAt']))
    report = {'checkedAt': checked_at, 'quarters': {}, 'errors': {}}
    with tempfile.TemporaryDirectory(prefix='earningspulse-') as folder:
        objects = Path(folder)

        def pack(rows, label, status):
            payload = dict(schemaVersion=1, source=SOURCE, calendarQuarter=label, status=status, records=rows)
            raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
            compressed = gzip.compress(raw, mtime=0)
            digest = hashlib.sha256(compressed).hexdigest()
            (objects / f'{digest}.json.gz').write_bytes(compressed)
            return {'sha256': digest, 'url': f'{store.base_url}/objects/{digest}.json.gz', 'count': len(rows)}

        for label in sorted(selected):
            try:
                rows = fetch(label)
                published = [row for row in rows if not row['isUpcoming']]
                old_entry = entries.get(label, {})
                old_count = old_entry.get('published', {}).get('count', 0)
                if old_count and len(published) < old_count / 2:
                    raise ValueError('Published record count dropped by more than half; retaining prior data')
                entry = {'checkedAt': checked_at, 'published': pack(published, label, 'published'),
                         'upcoming': pack([row for row in rows if row['isUpcoming']], label, 'upcoming')}
                unchanged = all(old_entry.get(key) == entry[key] for key in ('published', 'upcoming'))
                report['quarters'][label] = 'unchanged' if unchanged else 'updated'
                entries[label] = entry
            except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                report['errors'][label] = str(error)
                print(f'WARNING: Earnings Pulse {label}: {error}', flush=True)
        if report['quarters']:
            # Reuse the existing immutable uploader and its download verification.
            known = {item['sha256'] + '.json.gz' for entry in previous['quarters'].values()
                     for item in (entry['published'], entry['upcoming'])
                     if item['url'] == f"{store.base_url}/objects/{item['sha256']}.json.gz"}
            store.upload_objects(objects, known)
            write_json(output, {**previous, 'quarters': dict(sorted(entries.items()))})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recheck-oldest', action='store_true', help='Also refresh the least recently checked older quarter')
    args = parser.parse_args()
    now = datetime.now(ZoneInfo('Asia/Kolkata'))
    try:
        with requests.Session() as session:
            report = refresh(OUTPUT, R2Store(), lambda label: fetch_quarter(session, label, now.date()),
                             today=now.date(), checked_at=now.isoformat(), recheck_oldest=args.recheck_oldest)
    except Exception as error:
        # Workflow treats this source as optional; retain the previous public index.
        report = {'checkedAt': now.isoformat(), 'errors': {'publication': str(error)}}
    write_json(REPORT, report)
    if report['errors']:
        print('::warning::Earnings Pulse refresh incomplete; see earningspulse-refresh-report.json', flush=True)
    print(json.dumps(report), flush=True)
    return int(bool(report['errors']))


if __name__ == '__main__':
    sys.exit(main())
