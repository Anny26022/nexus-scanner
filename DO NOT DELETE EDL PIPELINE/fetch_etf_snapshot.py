"""TradingView ETF bulk scanner requests for India and US markets; retain missing values and per-listing quote dates."""
import argparse
import sys
from datetime import datetime, timezone
import requests

from pipeline_utils import load_json, post_json, resource_path, save_json

API_URL = 'https://scanner.tradingview.com/india/scan'
API_URL_US = 'https://scanner.tradingview.com/america/scan'
PAGE_SIZE_US = 1500

REGISTRY = load_json(resource_path('etf_fields.json'))
COLUMNS = list(dict.fromkeys(['name', 'description', 'exchange', 'type', 'subtype', 'currency',
                             'time', 'isin', *REGISTRY['columns']]))


def normalize(response, fetched_at):
    rows = response.get('data') if isinstance(response, dict) else None
    if not isinstance(rows, list) or not rows or response.get('totalCount') != len(rows):
        raise ValueError('Incomplete ETF scanner response')
    records, symbols = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Invalid ETF row')
        symbol, values = row.get('s', ''), row.get('d')
        if not isinstance(symbol, str) or not symbol.startswith('NSE:') or symbol in symbols or not isinstance(values, list) or len(values) != len(COLUMNS):
            raise ValueError('Invalid ETF symbol or column alignment')
        record = dict(zip(COLUMNS, values))
        if (record['exchange'], record['type'], record['subtype'], record['currency']) != ('NSE', 'fund', 'etf', 'INR'):
            raise ValueError('Unexpected ETF listing/currency')
        symbols.add(symbol)
        records.append(dict(record, symbol=symbol.removeprefix('NSE:')))
    return {'schemaVersion': 1, 'source': API_URL, 'fetchedAt': fetched_at, 'records': records}


def normalize_us(rows, fetched_at, expected_count=None):
    if not isinstance(rows, list) or not rows or (expected_count is not None and expected_count != len(rows)):
        raise ValueError('Incomplete US ETF scanner response')
    records, symbols = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Invalid ETF row')
        symbol, values = row.get('s', ''), row.get('d')
        ticker = symbol.split(':', 1)[1] if isinstance(symbol, str) and ':' in symbol else symbol
        if not isinstance(symbol, str) or not ticker or ticker in symbols or not isinstance(values, list) or len(values) != len(COLUMNS):
            raise ValueError('Invalid ETF symbol or column alignment')
        record = dict(zip(COLUMNS, values))
        if (record.get('type'), record.get('subtype'), record.get('currency')) != ('fund', 'etf', 'USD'):
            raise ValueError('Unexpected ETF listing/currency')
        symbols.add(ticker)
        records.append(dict(record, symbol=ticker))
    return {'schemaVersion': 1, 'market': 'us', 'source': API_URL_US, 'fetchedAt': fetched_at, 'records': records}


def fetch_us():
    """Fetch all US ETFs in bounded chunks to avoid TradingView chunked-stream disconnects."""
    offset = 0
    all_rows = []
    total_count = None
    while True:
        payload = {
            'columns': COLUMNS,
            'range': [offset, offset + PAGE_SIZE_US if total_count is None else min(offset + PAGE_SIZE_US, total_count)],
            'markets': ['america'],
            'filter': [
                {'left': 'type', 'operation': 'equal', 'right': 'fund'},
                {'left': 'subtype', 'operation': 'equal', 'right': 'etf'}
            ]
        }
        resp = post_json(API_URL_US, payload, timeout=60, retries=2)
        if not isinstance(resp, dict) or 'totalCount' not in resp:
            raise ValueError('Invalid TradingView response')
        if total_count is None:
            total_count = resp['totalCount']
        data = resp.get('data', [])
        all_rows.extend(data)
        offset += len(data)
        if offset >= total_count or not data:
            break
    return normalize_us(all_rows, datetime.now(timezone.utc).isoformat(), expected_count=total_count)


def main(argv=None):
    if argv is None and len(sys.argv) > 1 and sys.argv[0].endswith(('unittest', '__main__.py')):
        argv = []
    parser = argparse.ArgumentParser(prog='fetch_etf_snapshot')
    parser.add_argument('--market', choices=['in', 'us'], default='in', help='market to fetch (in or us)')
    parser.add_argument('--output', default='etf_snapshot.json', help='destination file path')
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    api_url = API_URL_US if args.market == 'us' else API_URL
    # Leave a valid empty artifact even if this optional subprocess is interrupted.
    save_json(args.output, {'schemaVersion': 1, 'source': api_url,
              'fetchedAt': datetime.now(timezone.utc).isoformat(), 'records': []})

    try:
        if args.market == 'us':
            result = fetch_us()
        else:
            payload = {'columns': COLUMNS, 'range': [0, 10000], 'markets': ['india'],
                       'filter': [{'left': key, 'operation': 'equal', 'right': value}
                                  for key, value in [('type', 'fund'), ('subtype', 'etf'), ('exchange', 'NSE')]]}
            result = normalize(post_json(API_URL, payload, timeout=60, retries=1), datetime.now(timezone.utc).isoformat())
    except (requests.RequestException, ValueError, TypeError, KeyError) as error:
        # The runner reports this optional source failure. Never reuse yesterday's ETF file.
        save_json(args.output, {'schemaVersion': 1, 'source': api_url,
                  'fetchedAt': datetime.now(timezone.utc).isoformat(), 'records': [], 'error': str(error)})
        print(f'ETF snapshot unavailable: {error}')
        return False
    save_json(args.output, result)
    print(f"ETF snapshot ({args.market.upper()}): {len(result['records'])} listings, {len(COLUMNS)} fields")
    return True


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
