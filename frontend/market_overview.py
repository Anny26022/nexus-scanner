"""Compact market overview (breadth, sectors, key indices) for one published session."""
import gzip
import json
import math

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


def market_overview(source_bytes, session):
    """Return the overview payload, or None when the pipeline produced no breadth data."""
    breadth = _breadth(_load(source_bytes, 'market_breadth_v2.json.gz'), session)
    if not breadth:
        return None
    return {
        'schemaVersion': MARKET_OVERVIEW_VERSION,
        'asOfDate': session,
        'breadth': breadth,
        'sectors': _sectors(_load(source_bytes, 'sector_analytics.json.gz')),
        'indices': _indices(_load(source_bytes, 'all_indices_history_v2.json.gz'), session),
    }
