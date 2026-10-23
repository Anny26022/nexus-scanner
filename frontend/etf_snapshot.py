"""Adapt the ETF bulk response to the existing packed scanner snapshot."""
from datetime import datetime
import math
from zoneinfo import ZoneInfo

import scanner_bridge  # noqa: F401  puts the pipeline checkout on sys.path, as for publish_snapshot
from pipeline_utils import load_json, resource_path


def build_etf_snapshot(source, session, revision):
    labels = load_json(resource_path('etf_enum_labels.json'))
    registry = load_json(resource_path('etf_fields.json'))
    fields = registry['columns']
    rows, observed_labels = [], {}
    def number(record, key):
        value = record.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None
    for record in source['records']:
        stamp = number(record, 'time')
        quote_date = datetime.fromtimestamp(stamp, ZoneInfo('Asia/Kolkata')).date().isoformat() if stamp else None
        if quote_date and quote_date > session:
            raise ValueError('ETF quote is newer than the stock session')
        values = {field: record.get(field) for field in fields}
        for field, dictionary in labels.items():
            value = str(values.get(field))
            if value in dictionary:
                observed_labels.setdefault(field, {})[value] = dictionary[value]
        row = dict(symbol=record['symbol'], name=record.get('description') or record['symbol'],
                   listingDate=record.get('inception_date') or '', sector='', industry='', series='ETF',
                   close=number(record, 'close'), open=number(record, 'open'), high=number(record, 'high'),
                   low=number(record, 'low'), changePct=number(record, 'change'), volume=number(record, 'volume'),
                   rvol=None, marketCapCrore=None, rupeeVolumeCrore=None, isFno=False,
                   peRatio=None, rsi14=number(record, 'RSI'), adr20Pct=number(record, 'ADRP'),
                   atr14=number(record, 'ATR'), sma20=number(record, 'SMA20'), sma50=number(record, 'SMA50'),
                   sma200=number(record, 'SMA200'), ema20=number(record, 'EMA20'), ema50=number(record, 'EMA50'),
                   ema200=number(record, 'EMA200'), earningsDate=None, daysSinceEarnings=None, fnoBan=None,
                   circuitLimit='', deliveryPct=None, rsRating=None, roePct=None, freeFloatPct=None,
                   dist52wHighPct=None, dist52wLowPct=None, distAthPct=None, dataCompleteness=0,
                   asOfDate=quote_date, metadataAsOfDate=session, historyAligned=False,
                   indexMemberships=[], metrics={}, presetMatches={}, etf=values)
        turnover = number(record, 'Value.Traded')
        row['rupeeVolumeCrore'] = turnover / 1e7 if turnover is not None else None
        rows.append(row)
    if not rows or sum(row['asOfDate'] == session for row in rows) / len(rows) < .9:
        raise ValueError(f'ETF data not advanced to expected stock session {session}')
    return dict(revision=revision, asOfDate=session, totalStocks=len(rows), stocks=rows,
                assetType='etf', etfLabels=observed_labels, fetchedAt=source['fetchedAt'])


def prune_etf_snapshots(output, revision):
    """Run after successful publication; stock history and the active ETF file stay intact."""
    for path in output.glob('revisions/*/etfs.json.gz'):
        if path.parent.name != revision:
            try:
                path.unlink()
            except OSError as error:
                print(f'WARNING: old ETF snapshot could not be removed: {path}: {error}', flush=True)
