"""One bulk TradingView request; retain missing values and per-listing quote dates."""
import sys
from datetime import datetime, timezone
import requests

from pipeline_utils import load_json, post_json, resource_path, save_json

API_URL = 'https://scanner.tradingview.com/india/scan'
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


def main():
    # Leave a valid empty artifact even if this optional subprocess is interrupted.
    save_json('etf_snapshot.json', {'schemaVersion':1, 'source':API_URL,
              'fetchedAt':datetime.now(timezone.utc).isoformat(), 'records':[]})
    payload = {'columns': COLUMNS, 'range': [0, 10000], 'markets': ['india'],
               'filter': [{'left': key, 'operation': 'equal', 'right': value}
                          for key, value in [('type', 'fund'), ('subtype', 'etf'), ('exchange', 'NSE')]]}
    try:
        result = normalize(post_json(API_URL, payload, timeout=60, retries=1), datetime.now(timezone.utc).isoformat())
    except (requests.RequestException, ValueError, TypeError, KeyError) as error:
        # The runner reports this optional source failure. Never reuse yesterday's ETF file.
        save_json('etf_snapshot.json', {'schemaVersion':1, 'source':API_URL,
                  'fetchedAt':datetime.now(timezone.utc).isoformat(), 'records':[], 'error':str(error)})
        print(f'ETF snapshot unavailable: {error}')
        return False
    save_json('etf_snapshot.json', result)
    print(f"ETF snapshot: {len(result['records'])} listings, {len(COLUMNS)} fields, one bulk scan")
    return True


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
