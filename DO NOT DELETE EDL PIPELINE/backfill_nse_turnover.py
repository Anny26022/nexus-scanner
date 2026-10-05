"""Fill missing official NSE traded value on existing candles (rupees).

Bulk daily files are cached once. Prices, volume and corporate-action
adjustments are never changed. Default coverage is the latest 260 sessions;
use --sessions 1500 for deeper base replay history.
"""
import argparse
import csv
import gzip
import json
from io import StringIO
from pathlib import Path

import requests

from nse_delivery import HISTORICAL_FILE_URL, NSE_HEADERS, normalize_ohlcv_row
from ohlcv_utils import read_ohlcv_csv, write_ohlcv_csv
from pipeline_utils import BASE_DIR


def fetch_turnover(day, session):
    response = session.get(HISTORICAL_FILE_URL.format(date=day[8:10]+day[5:7]+day[:4]), timeout=30)
    response.raise_for_status()
    grouped = {}
    for row in csv.DictReader(StringIO(response.content.decode('utf-8-sig'))):
        record = normalize_ohlcv_row(row)
        if record and record['date'] == day and 'turnover' in record:
            grouped.setdefault(record['symbol'], []).append(record)
    values = {}
    for symbol, rows in grouped.items():
        selected = [row for row in rows if row['series'] == 'EQ']
        if len(selected) == 1 or len(rows) == 1:
            values[symbol] = (selected or rows)[0]['turnover']
    if not values:
        raise ValueError(f'No date-aligned turnover in NSE file for {day}')
    return values


def backfill(root, sessions=260, fetcher=fetch_turnover):
    if sessions <= 0:
        raise ValueError('sessions must be positive')
    directory = root/'ohlcv_data'
    paths = list(directory.glob('*.csv'))
    dates = set(sorted({row['Date'] for path in paths for row in read_ohlcv_csv(path)}, reverse=True)[:sessions])
    needed = {row['Date'] for path in paths for row in read_ohlcv_csv(path)
              if row['Date'] in dates and row.get('Turnover') in (None, '')}
    cache = root/'nse_turnover_history'
    cache.mkdir(parents=True, exist_ok=True)
    client = requests.Session();client.headers.update(NSE_HEADERS)
    values, failures = {}, []
    for day in sorted(needed, reverse=True):
        destination = cache/f'{day}.json.gz'
        try:
            if destination.exists():
                payload = json.loads(gzip.decompress(destination.read_bytes()))
                if payload.get('date') != day:
                    raise ValueError('Cached turnover date mismatch')
                values[day] = payload['values']
            else:
                values[day] = fetcher(day, client)
                data = gzip.compress(json.dumps({'date':day,'values':values[day]},allow_nan=False).encode(),mtime=0)
                temporary = destination.with_suffix('.tmp');temporary.write_bytes(data);temporary.replace(destination)
        except (requests.RequestException, OSError, ValueError, KeyError) as error:
            failures.append(f'{day}: {error}')
    applied = 0
    for path in paths:
        rows = read_ohlcv_csv(path)
        changed = False
        for row in rows:
            value = values.get(row['Date'], {}).get(path.stem)
            if row.get('Turnover') in (None, '') and value is not None:
                row['Turnover'] = value;changed=True;applied+=1
        if changed:
            temporary = path.with_suffix('.tmp');write_ohlcv_csv(temporary,rows);temporary.replace(path)
    return {'applied_rows':applied,'requested_sessions':sessions,'available_files':len(values),'failures':failures}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(BASE_DIR))
    parser.add_argument('--sessions',type=int,default=260)
    args=parser.parse_args()
    report=backfill(args.root,args.sessions)
    (args.root/'nse_turnover_report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
    # Missing history remains unavailable, never substituted by close × volume.
    return 0


if __name__=='__main__':
    raise SystemExit(main())
