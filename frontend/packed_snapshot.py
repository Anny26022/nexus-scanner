"""Lossless wire representation; scanner records and calculations stay unchanged."""
NESTED_FIELDS = ('presetMatches', 'metrics', 'financialMetadata', 'historyMetadata')


def pack_records(records):
    keys = list(dict.fromkeys(key for row in records for key in row))
    return {
        'keys': keys,
        'values': [[row.get(key) for key in keys] for row in records],
        'missing': [[i for i, key in enumerate(keys) if key not in row] for row in records],
    }


def pack_snapshot(payload):
    rows = [dict(row) for row in payload['stocks']]
    nested = {}
    for field in (*NESTED_FIELDS, *(('etf',) if any('etf' in row for row in rows) else ())):
        indexes = [i for i, row in enumerate(rows) if isinstance(row.get(field), dict)]
        nested[field] = {'indexes': indexes, 'table': pack_records([rows[i].pop(field) for i in indexes])}
    return {
        **{key: value for key, value in payload.items() if key != 'stocks'},
        'stockEncoding': 'columnar-v1',
        'stocksTable': pack_records(rows),
        'nestedTables': nested,
    }


def snapshot_stocks(data):
    """Top-level stock rows of a plain or packed archive. Nested tables are not reattached."""
    if data.get('stockEncoding') is None:
        stocks = data.get('stocks') or []
        return list(stocks.values()) if isinstance(stocks, dict) else stocks
    if data['stockEncoding'] != 'columnar-v1':
        raise ValueError(f"Unknown snapshot encoding {data['stockEncoding']!r}")
    table = data['stocksTable']
    rows = []
    for row, missing in zip(table['values'], map(set, table['missing'])):
        rows.append({key: value for i, (key, value) in enumerate(zip(table['keys'], row)) if i not in missing})
    return rows
