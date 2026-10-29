"""Optional earnings history: verified R2 objects, with a small index.

The provider shows anonymous visitors only the current week (Monday to Sunday); older weeks and quarter views need
a sign-in. Each run reads that week and merges it into the stored calendar quarters: events on the week's days are
replaced, the rest of each quarter is kept as published before. The daily refresh runs Monday to Friday and the
weekly one on Sunday, so each week is read after its weekday and Saturday results are out.
"""
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
# Primary India index consumed by the frontend
OUTPUT = Path(__file__).parent / 'public/data/results/index.json'
# Output indices indexed by market to ensure 100% backward compatibility for IN
INDEX_BY_MARKET = {
    'IN': OUTPUT,
    'US': Path(__file__).parent / 'public/data/results/us_index.json',
}
# Provider-side links the app never reads; they would only identify where the data came from.
PRIVATE_FIELDS = frozenset({'summary_uri'})
REPORT = Path(__file__).parent / 'earningspulse-refresh-report.json'


def quarter_bounds(label):
    if not re.fullmatch(r'20\d{2}-Q[1-4]', label):
        raise ValueError('Invalid calendar quarter')
    year, quarter = int(label[:4]), int(label[-1])
    start = date(year, quarter * 3 - 2, 1)
    end = date(year + (quarter == 4), quarter * 3 % 12 + 1, 1) - timedelta(days=1)
    return start, end


def quarter_label(day):
    return f'{day.year}-Q{(day.month - 1) // 3 + 1}'


def event_key(row):
    return (row['symbol'], row.get('quarter_label') or '', row['filing_day'])


def parse_week(text, today, market='IN'):
    """The provider's current week as (first day, last day, events), read from Flight without executing scripts."""
    def value(key):
        marker = json.dumps(key) + ':'
        return json.JSONDecoder().raw_decode(text[text.index(marker) + len(marker):])[0]
    if value('fetchError') is not False:
        raise ValueError('Provider reported a fetch failure')
    dates = value('allDates')
    try:
        days = [date.fromisoformat(day) for day in dates]
    except (TypeError, ValueError):
        raise ValueError('Provider returned an invalid week') from None
    start, end = days[0] if days else None, days[-1] if days else None
    # Monday to Sunday around today (the provider's day may be a few hours off ours).
    if (len(days) != 7 or start.weekday() != 0 or days != [start + timedelta(days=offset) for offset in range(7)]
            or not start - timedelta(days=1) <= today <= end + timedelta(days=1)):
        raise ValueError('Provider returned a different week')
    rows = value('results')
    if not isinstance(rows, list):
        raise ValueError('Invalid earnings collection')
    unique = {}
    required = {'symbol', 'filing_day', 'market', 'isUpcoming'}
    for row in rows:
        if not isinstance(row, dict) or not required.issubset(row) or not isinstance(row.get('symbol'), str) or not row['symbol'].strip():
            raise ValueError('Invalid earnings identity or schema')
        day = date.fromisoformat(row['filing_day'])
        if not start <= day <= end or row.get('market') != market or type(row.get('isUpcoming')) is not bool:
            raise ValueError('Invalid earnings date, market or publication status')
        if market == 'IN':
            if not row['isUpcoming'] and (not isinstance(row.get('quarter_label'), str) or not row['quarter_label'].strip()):
                raise ValueError('Missing fiscal quarter on a published event')
            if not row['isUpcoming'] and not {'revenue', 'net_income', 'eps'}.issubset(row):
                raise ValueError('Missing financial fields on a published event')
        key = event_key(row)
        if key in unique and unique[key] != row:
            if market == 'US':
                # In US market, multiple filings occur on the same day (e.g. PR vs 10-Q); retain newest by event_ts
                current_ts = unique[key].get('event_ts') or 0
                row_ts = row.get('event_ts') or 0
                if row_ts > current_ts:
                    unique[key] = row
            else:
                raise ValueError('Conflicting duplicate earnings event')
        else:
            unique[key] = row
    rows = [unique[key] for key in sorted(unique)]
    # Reject NaN and Infinity before writing any objects.
    json.dumps(rows, allow_nan=False)
    return start, end, rows


def fetch_week(session, today, market='IN'):
    params = dict(liquidity='all', market=market)
    for attempt in range(2):
        try:
            response = session.get(SOURCE, params=params, headers={'RSC': '1'}, timeout=(10, 60))
            response.raise_for_status()
            return parse_week(response.text, today, market=market)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            if attempt:
                raise
            time.sleep(1)


def load_records(session, item):
    """The events of a published object, checked against its digest."""
    response = session.get(item['url'], timeout=(10, 60))
    response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != item['sha256']:
        raise ValueError('Stored earnings object does not match its digest')
    return json.loads(gzip.decompress(response.content))['records']


def refresh(output, store, fetch, load, *, checked_at):
    """Merge the provider's current week (fetch) into the stored quarters (load reads a published object)."""
    previous = json.loads(output.read_text()) if output.exists() else {'version': 1, 'quarters': {}}
    if previous.get('version') != 1 or not isinstance(previous.get('quarters'), dict):
        raise ValueError('Invalid earnings history index; refusing to discard it')
    entries = dict(previous['quarters'])
    report = {'checkedAt': checked_at, 'quarters': {}, 'errors': {}}
    try:
        start, end, rows = fetch()
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        report['errors']['current-week'] = str(error)
        print(f'WARNING: Earnings Pulse current week: {error}', flush=True)
        return report
    rows = [{key: value for key, value in row.items() if key not in PRIVATE_FIELDS} for row in rows]
    if not rows:
        # Nothing to merge (a quiet week, or a provider hiccup): what is stored for these days stays.
        return report
    with tempfile.TemporaryDirectory(prefix='earningspulse-') as folder:
        objects = Path(folder)

        def pack(rows, label, status):
            payload = dict(schemaVersion=1, calendarQuarter=label, status=status, records=rows)
            raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
            compressed = gzip.compress(raw, mtime=0)
            digest = hashlib.sha256(compressed).hexdigest()
            (objects / f'{digest}.json.gz').write_bytes(compressed)
            return {'sha256': digest, 'url': f'{store.base_url}/objects/{digest}.json.gz', 'count': len(rows)}

        for label in sorted({quarter_label(start), quarter_label(end)}):
            try:
                fresh = [row for row in rows if quarter_label(date.fromisoformat(row['filing_day'])) == label]
                symbols = {row['symbol'] for row in fresh}
                old_entry = entries.get(label, {})
                merged = {}
                for status in ('published', 'upcoming'):
                    kept, replaced = [], 0
                    if status in old_entry:
                        for row in load(old_entry[status]):
                            day = date.fromisoformat(row['filing_day'])
                            # This week's days come from the provider; an older announcement for a company that
                            # reports this week is superseded.
                            if start <= day <= end or (status == 'upcoming' and row['symbol'] in symbols):
                                replaced += start <= day <= end
                                continue
                            kept.append(row)
                    current = [row for row in fresh if row['isUpcoming'] == (status == 'upcoming')]
                    if status == 'published' and len(current) < replaced / 2:
                        raise ValueError("Fewer than half of this week's published events returned; retaining prior data")
                    merged[status] = sorted(kept + current, key=event_key)
                old_count = old_entry.get('published', {}).get('count', 0)
                if old_count and len(merged['published']) < old_count / 2:
                    raise ValueError('Published record count dropped by more than half; retaining prior data')
                entry = {'checkedAt': checked_at, 'published': pack(merged['published'], label, 'published'),
                         'upcoming': pack(merged['upcoming'], label, 'upcoming')}
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
            write_json(output, {'version': 1, 'quarters': dict(sorted(entries.items()))})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--markets', nargs='+', default=['IN', 'US'], help='Markets to refresh (default: IN US)')
    args = parser.parse_args()
    now = datetime.now(ZoneInfo('Asia/Kolkata'))
    combined_report = {'checkedAt': now.isoformat(), 'markets': {}, 'errors': {}}

    store = R2Store()
    with requests.Session() as session:
        for market in args.markets:
            output_file = INDEX_BY_MARKET.get(market, Path(__file__).parent / f'public/data/results/{market.lower()}_index.json')
            try:
                report = refresh(output_file, store,
                                 lambda m=market: fetch_week(session, now.date(), market=m),
                                 lambda item: load_records(session, item), checked_at=now.isoformat())
                combined_report['markets'][market] = report
                if report.get('errors'):
                    combined_report['errors'][market] = report['errors']
            except Exception as error:
                combined_report['errors'][market] = str(error)

    write_json(REPORT, combined_report)
    if combined_report['errors']:
        print('::warning::Earnings Pulse refresh incomplete; see earningspulse-refresh-report.json', flush=True)
    print(json.dumps(combined_report), flush=True)
    return int(bool(combined_report['errors']))


if __name__ == '__main__':
    sys.exit(main())
