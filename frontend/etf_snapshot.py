"""Adapt the ETF bulk response to the existing packed scanner snapshot."""
from datetime import date, datetime, timedelta
import math
from zoneinfo import ZoneInfo

import scanner_bridge  # noqa: F401  puts the pipeline checkout on sys.path, as for publish_snapshot
from ohlcv_utils import is_nse_session_day
from pipeline_utils import load_json, resource_path


def next_session(session, market='in'):
    if market == 'us':
        from edl_pipeline.markets.us.calendar import is_nyse_session_day
        day = date.fromisoformat(session) + timedelta(days=1)
        while not is_nyse_session_day(day):
            day += timedelta(days=1)
        return day.isoformat()
    day = date.fromisoformat(session) + timedelta(days=1)
    while not is_nse_session_day(day):
        day += timedelta(days=1)
    return day.isoformat()


def build_etf_snapshot(source, session, revision, market=None):
    market = market or source.get('market') or ('us' if 'america' in str(source.get('source', '')) else 'in')
    labels = load_json(resource_path('etf_enum_labels.json'))
    registry = load_json(resource_path('etf_fields.json'))
    fields = registry['columns']
    rows, observed_labels = [], {}
    def number(record, key):
        value = record.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None
    fetched = datetime.fromisoformat(source['fetchedAt'].replace('Z', '+00:00')).timestamp()
    upcoming = next_session(session, market=market)
    tz = ZoneInfo('America/New_York') if market == 'us' else ZoneInfo('Asia/Kolkata')
    for record in source['records']:
        stamp = number(record, 'time')
        quote_date = datetime.fromtimestamp(stamp, tz).date().isoformat() if stamp else None
        # TradingView can stamp a closed session's quote with the next session's opening time before that session
        # starts (75 ETFs after the 2026-11-08 Muhurat session read 2026-11-09 09:15, with Muhurat's prices and
        # volumes). A quote time still in the future when fetched cannot be that session's trading, so it is the
        # stock session's. Any other quote dated after the session is still refused.
        if quote_date == upcoming and stamp > fetched:
            quote_date = session
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
        row['rupeeVolumeCrore'] = (turnover / 1e6 if market == 'us' else turnover / 1e7) if turnover is not None else None
        rows.append(row)
    min_coverage = 0.70 if market == 'us' else 0.90
    if not rows or sum(row['asOfDate'] == session for row in rows) / len(rows) < min_coverage:
        raise ValueError(f'ETF data not advanced to expected stock session {session}')
    return dict(revision=revision, asOfDate=session, totalStocks=len(rows), stocks=rows,
                assetType='etf', etfLabels=observed_labels, fetchedAt=source['fetchedAt'],
                **({'market': market, 'currency': 'USD'} if market == 'us' else {'market': market} if market != 'in' else {}))


def prune_etf_snapshots(output, revision):
    """Run after successful publication; stock history and the active ETF file stay intact."""
    for path in output.glob('revisions/*/etfs.json.gz'):
        if path.parent.name != revision:
            try:
                path.unlink()
            except OSError as error:
                print(f'WARNING: old ETF snapshot could not be removed: {path}: {error}', flush=True)
