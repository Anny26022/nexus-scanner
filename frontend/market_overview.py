"""Compact market overview (breadth, sectors, key indices) for one published session."""
import csv
import gzip
import json
import math
from collections import defaultdict
from pathlib import Path
from classification_contract import clean_label

MARKET_OVERVIEW_VERSION = 1
BREADTH_SESSIONS = 60
INDEX_SESSIONS = 60
MIN_SECTOR_STOCKS = 3

BREADTH_FIELDS = (
    'advances', 'declines', 'unchanged', 'up_4', 'down_4',
    'above_10_pct', 'above_20_pct', 'above_50_pct', 'above_200_pct',
    'new_52w_high', 'new_52w_low', 'nnh_52w', 'net_breadth', 'index_change_pct',
)
SECTOR_FIELDS = (
    'stock_count', 'above_sma20_percent', 'above_sma50_percent', 'above_sma200_percent', 'near_52w_high_5_percent',
)
# Benchmarks shown as index cards, in display order.
KEY_INDICES = (
    'NIFTY', 'SENSEX', 'BANKNIFTY', 'NIFTY 500', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250', 'NIFTY MIDSMALLCAP 400', 'FINNIFTY',
)


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _load(source_bytes, name):
    raw = source_bytes.get(name)
    return json.loads(gzip.decompress(raw)) if raw is not None else None


def _breadth(payload, session):
    records = [r for r in (payload or {}).get('records', []) if isinstance(r, dict) and str(r.get('date', '')) <= session]
    return [{'date': r['date'], **{field: _number(r.get(field)) for field in BREADTH_FIELDS}} for r in records[-BREADTH_SESSIONS:]]


def _sectors(payload):
    sectors = []
    for sector in (payload or {}).get('sectors', []):
        if not isinstance(sector, dict) or not isinstance(sector.get('name'), str):
            continue
        row = {'name': sector['name'], **{field: _number(sector.get(field)) for field in SECTOR_FIELDS}}
        if (row['stock_count'] or 0) >= MIN_SECTOR_STOCKS:
            sectors.append(row)
    return sorted(sectors, key=lambda s: (-(s['above_sma50_percent'] or 0), s['name']))


def _indices(payload, session):
    by_symbol = {i.get('symbol'): i for i in (payload or {}).get('indices', []) if isinstance(i, dict)}
    cards = []
    for symbol in KEY_INDICES:
        index = by_symbol.get(symbol)
        if not index:
            continue
        records = [r for r in index.get('records', []) if isinstance(r, dict) and str(r.get('date', '')) <= session
                   and _number(r.get('close')) is not None]
        if len(records) < 2:
            continue
        last, previous = records[-1]['close'], records[-2]['close']
        cards.append({
            'symbol': symbol,
            'name': index.get('name') or symbol,
            'date': records[-1]['date'],
            'close': last,
            'changePct': round((last - previous) / previous * 100, 4) if previous else None,
            'series': [r['close'] for r in records[-INDEX_SESSIONS:]],
        })
    return cards


def stock_sectors(stocks):
    """Use the release's primary company labels for every sector summary."""
    groups = defaultdict(list)
    for stock in stocks:
        label = clean_label(stock.get('sector'))
        if label:
            groups[label].append(stock)
    sectors = []
    for label, rows in groups.items():
        count = len(rows)
        row = {'name':label, 'stock_count':count}
        for period in (20, 50, 200):
            above = 0
            for stock in rows:
                close = _number(stock.get('close'))
                average = _number(stock.get(f'sma{period}', (stock.get('metrics') or {}).get(f'sma{period}')))
                above += close is not None and average is not None and close > average
            row[f'above_sma{period}_percent'] = round(above / count * 100, 1)
        near = sum(abs(value) <= 5 for stock in rows if (value := _number(stock.get('dist52wHighPct'))) is not None)
        row['near_52w_high_5_percent'] = round(near / count * 100, 1)
        sectors.append(row)
    return _sectors({'sectors':sectors})


def market_overview(source_bytes, session, stocks=None):
    """Return the overview payload, or None when the pipeline produced no breadth data."""
    breadth = _breadth(_load(source_bytes, 'market_breadth_v2.json.gz'), session)
    if not breadth:
        return None
    return {
        'schemaVersion': MARKET_OVERVIEW_VERSION,
        'asOfDate': session,
        'breadth': breadth,
        'sectors': stock_sectors(stocks) if stocks is not None else _sectors(_load(source_bytes, 'sector_analytics.json.gz')),
        'indices': _indices(_load(source_bytes, 'all_indices_history_v2.json.gz'), session),
    }


BENCHMARK_SYMBOL = 'NIFTY'
BENCHMARK_VERSION = 1


def _csv_closes(path):
    closes = {}
    try:
        with open(path, newline='') as handle:
            for row in csv.DictReader(handle):
                close = _number(_float(row.get('Close')))
                if row.get('Date') and close is not None:
                    closes[row['Date'][:10]] = close
    except OSError:
        return {}
    return closes


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def index_closes(root, source_bytes, symbol, session, csv_name=None):
    """An index's daily closes up to the session: long CSV history, refreshed by the index snapshot."""
    closes = _csv_closes(Path(root) / 'indices_ohlcv_data' / f'{csv_name or symbol}.csv')
    history = _load(source_bytes, 'all_indices_history_v2.json.gz') or {}
    index = next((i for i in history.get('indices', []) if isinstance(i, dict) and i.get('symbol') == symbol), None)
    for record in (index or {}).get('records', []):
        close = _number(record.get('close')) if isinstance(record, dict) else None
        if close is not None and isinstance(record.get('date'), str):
            closes[record['date']] = close
    return [[date, closes[date]] for date in sorted(closes) if date <= session], index


def benchmark_series(root, source_bytes, session):
    """Nifty 50 daily closes up to the session."""
    records, index = index_closes(root, source_bytes, BENCHMARK_SYMBOL, session)
    if len(records) < 2:
        return None
    return {'schemaVersion': BENCHMARK_VERSION, 'symbol': BENCHMARK_SYMBOL, 'name': (index or {}).get('name') or 'Nifty 50',
            'asOfDate': session, 'records': records}
