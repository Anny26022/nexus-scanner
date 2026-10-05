"""Fill missing official NSE traded value on existing candles (rupees).

Bulk daily files are cached once. Prices, volume and corporate-action
adjustments are never changed. Default coverage is the latest 260 sessions;
use --sessions 1500 for deeper base replay history.
"""
import argparse
from datetime import date
import math
import sqlite3
import time
import zipfile
import csv
import gzip
import json
from io import StringIO, BytesIO
from pathlib import Path

import requests

from nse_delivery import HISTORICAL_FILE_URL, NSE_HEADERS, normalize_ohlcv_row
from ohlcv_utils import read_ohlcv_csv, write_ohlcv_csv
from pipeline_utils import BASE_DIR


def fetch_turnover(day, session):
    stamp = date.fromisoformat(day)
    month = stamp.strftime('%b').upper()
    urls = [HISTORICAL_FILE_URL.format(date=stamp.strftime('%d%m%Y')),
            f"https://nsearchives.nseindia.com/content/historical/EQUITIES/{stamp.year}/{month}/cm{stamp.day:02d}{month}{stamp.year}bhav.csv.zip"]
    for legacy, url in enumerate(urls):
        response = session.get(url, timeout=30)
        if not legacy and response.status_code == 404:
            continue
        response.raise_for_status()
        try:
            if legacy:
                with zipfile.ZipFile(BytesIO(response.content)) as archive:
                    content = archive.read(archive.namelist()[0]).decode('utf-8-sig')
            else:
                content = response.content.decode('utf-8-sig')
        except (UnicodeDecodeError, zipfile.BadZipFile):
            if not legacy:
                continue
            raise
        grouped = {}
        for row in csv.DictReader(StringIO(content)):
            if legacy:
                row = {str(key).strip():value for key,value in row.items() if key}
                try:
                    from nse_delivery import parse_nse_date
                    value = float(row['TOTTRDVAL'])  # Legacy value is rupees.
                    record = {'symbol':row['SYMBOL'].strip(), 'series':row['SERIES'].strip(),
                              'date':parse_nse_date(row['TIMESTAMP']), 'turnover':value}
                    if not math.isfinite(value) or value < 0:
                        continue
                except (KeyError, TypeError, ValueError):
                    continue
            else:
                record = normalize_ohlcv_row(row)
            if record and record['date'] == day and 'turnover' in record:
                grouped.setdefault(record['symbol'], []).append(record)
        values = {}
        for symbol, rows in grouped.items():
            selected = [row for row in rows if row['series'] == 'EQ']
            if len(selected) == 1 or len(rows) == 1:
                values[symbol] = (selected or rows)[0]['turnover']
        if values:
            return values
        # An HTTP 200 can still contain an old session. Try the dated archive
        # without relabelling those rows as the requested day.
    raise ValueError(f'No date-aligned turnover in NSE files for {day}')


def backfill(root, sessions=260, fetcher=fetch_turnover, years=None):
    if sessions <= 0:
        raise ValueError('sessions must be positive')
    started = time.monotonic()
    directory = root/'ohlcv_data'
    paths = list(directory.glob('*.csv'))
    all_dates = sorted({row['Date'] for path in paths for row in read_ohlcv_csv(path)}, reverse=True)
    if years is not None:
        if years <= 0:
            raise ValueError('years must be positive')
        if not all_dates:
            raise ValueError('No OHLCV history available for the requested years')
        end = date.fromisoformat(all_dates[0])
        try:
            start = end.replace(year=end.year-years)
        except ValueError:
            start = end.replace(year=end.year-years,day=28)
        dates = {day for day in all_dates if day >= start.isoformat()}
    else:
        dates = set(all_dates[:sessions])
    needed = {row['Date'] for path in paths for row in read_ohlcv_csv(path)
              if row['Date'] in dates and row.get('Turnover') in (None, '')}
    cache = root/'nse_turnover_history'
    cache.mkdir(parents=True, exist_ok=True)
    client = requests.Session();client.headers.update(NSE_HEADERS)
    # Temporary disk index keeps ten-year runs from retaining millions of
    # Python dictionary entries in RAM. Compressed bulk files remain reusable.
    database = sqlite3.connect('')
    database.execute('CREATE TABLE turnover(symbol TEXT, day TEXT, value REAL, PRIMARY KEY(symbol,day))')
    failures, fetched = [], 0
    for index, day in enumerate(sorted(needed, reverse=True),1):
        destination = cache/f'{day}.json.gz'
        try:
            if destination.exists():
                payload = json.loads(gzip.decompress(destination.read_bytes()))
                if payload.get('date') != day:
                    raise ValueError('Cached turnover date mismatch')
                values = payload['values']
            else:
                values = fetcher(day, client)
                data = gzip.compress(json.dumps({'date':day,'values':values},allow_nan=False).encode(),mtime=0)
                temporary = destination.with_suffix('.tmp');temporary.write_bytes(data);temporary.replace(destination)
            database.executemany('INSERT INTO turnover VALUES (?,?,?)',[(symbol,day,float(value)) for symbol,value in values.items() if math.isfinite(float(value)) and float(value)>=0])
            database.commit()
            fetched += 1
            if index % 100 == 0:
                print(f'Official turnover: {index}/{len(needed)} files; {time.monotonic()-started:.1f}s elapsed',flush=True)
        except (requests.RequestException, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
            failures.append(f'{day}: {error}')
    applied = 0
    for path in paths:
        rows = read_ohlcv_csv(path)
        values = dict(database.execute('SELECT day,value FROM turnover WHERE symbol=?',(path.stem,)))
        changed = False
        for row in rows:
            value = values.get(row['Date'])
            if row.get('Turnover') in (None, '') and value is not None:
                row['Turnover'] = value;changed=True;applied+=1
        if changed:
            temporary = path.with_suffix('.tmp');write_ohlcv_csv(temporary,rows);temporary.replace(path)
    database.close()
    client.close()
    return {'applied_rows':applied,'requested_sessions':len(dates),'requested_years':years,
            'first_date':min(dates) if dates else None,'last_date':max(dates) if dates else None,
            'available_files':fetched,'failures':failures,'elapsed_seconds':round(time.monotonic()-started,2)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(BASE_DIR))
    horizon=parser.add_mutually_exclusive_group()
    horizon.add_argument('--sessions',type=int,default=260)
    horizon.add_argument('--years',type=int)
    args=parser.parse_args()
    report=backfill(args.root,args.sessions,years=args.years)
    (args.root/'nse_turnover_report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
    # Missing history remains unavailable, never substituted by close × volume.
    return 0


if __name__=='__main__':
    raise SystemExit(main())
