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
    for field in NESTED_FIELDS:
        indexes = [i for i, row in enumerate(rows) if isinstance(row.get(field), dict)]
        nested[field] = {'indexes': indexes, 'table': pack_records([rows[i].pop(field) for i in indexes])}
    return {
        **{key: value for key, value in payload.items() if key != 'stocks'},
        'stockEncoding': 'columnar-v1',
        'stocksTable': pack_records(rows),
        'nestedTables': nested,
    }
