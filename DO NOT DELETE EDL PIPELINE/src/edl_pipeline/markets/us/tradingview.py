"""US values from TradingView's scanner: one request for the whole market, as India's fetch_advanced_indicators.

It carries what Dhan's US snapshot and its 2021-onward history cannot: all-time highs, the last and next earnings
dates, free float, dividend yield and ex-dates, and India's published TradingView metrics (`tradingview_fields.json`,
shared so the catalogue, publisher and both markets read one list).

Rows are matched by ISIN. Secondary share classes (BRK.B) and ADRs (ASML) are not TradingView's "primary" listing and
ADRs are type `dr`, so both types are requested on the four exchanges Dhan lists; OTC is left out. Amount fields
(`*_crore`) are stated in this market's amount unit (millions of dollars), and only when the values are in dollars.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

from fetch_advanced_indicators import FIELD_DEFINITIONS
from pipeline_utils import post_json

from .. import UNITED_STATES
from .calendar import EASTERN

API_URL = 'https://scanner.tradingview.com/america/scan'
EXCHANGES = ('NYSE', 'NASDAQ', 'AMEX', 'CBOE')
# Columns US screening reads beyond the shared metric list.
EXTRA = {'earnings_release_date': 'last_earnings', 'earnings_release_next_date': 'next_earnings',
         'float_shares_percent_current': 'free_float_percent', 'dividends_yield_current': 'dividend_yield_percent',
         'ex_dividend_date_recent': 'last_ex_dividend', 'ex_dividend_date_upcoming': 'next_ex_dividend'}
COLUMNS = ['isin', 'time', 'close', 'update_mode', 'currency', 'fundamental_currency_code', 'exchange', 'is_primary', 'type',
           *[field['wire'] for field in FIELD_DEFINITIONS], *EXTRA]
LIMIT = 12_000


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _eastern_date(stamp) -> str | None:
    stamp = _number(stamp)
    return datetime.fromtimestamp(stamp, timezone.utc).astimezone(EASTERN).date().isoformat() if stamp else None


def _section(values: dict, section: str, currency: str | None) -> dict:
    """One section of India's metric list in this market's units; amounts only when they are in dollars."""
    result = {}
    for field in FIELD_DEFINITIONS:
        if field['section'] != section:
            continue
        value = _number(values.get(field['wire']))
        amount = field['key'].endswith('_crore')
        if value is None or currency != UNITED_STATES.currency:
            result[field['key']] = None
        else:
            result[field['key']] = value / UNITED_STATES.provider_amount_unit if amount else value
    return result


def fetch(*, post=post_json) -> dict:
    payload = {'columns': COLUMNS, 'markets': ['america'], 'options': {'lang': 'en'}, 'range': [0, LIMIT],
               'filter': [{'left': 'type', 'operation': 'in_range', 'right': ['stock', 'dr']},
                          {'left': 'exchange', 'operation': 'in_range', 'right': list(EXCHANGES)}]}
    return post(API_URL, payload, timeout=60, retries=1)


def snapshots(response: dict, fetched_at: str) -> dict[str, dict]:
    """ISIN -> the record's `tradingview_snapshot` (India's shape) plus the canonical values it supplies."""
    rows = response.get('data')
    if not isinstance(rows, list) or not rows or response.get('totalCount') != len(rows):
        raise ValueError('Incomplete TradingView scanner response')
    by_isin: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('d'), list) or len(row['d']) != len(COLUMNS):
            raise ValueError('Unexpected TradingView scanner row/column alignment')
        values = dict(zip(COLUMNS, row['d']))
        isin = values['isin']
        if not isin or values['exchange'] not in EXCHANGES:
            continue
        # One ISIN listed twice keeps its primary listing.
        if isin in by_isin and not values['is_primary']:
            continue
        values['listing_symbol'] = row.get('s')
        by_isin[isin] = values
    result = {}
    for isin, values in by_isin.items():
        as_of = _eastern_date(values['time'])
        if as_of is None or _number(values['close']) is None:
            continue
        snapshot = {
            'source': API_URL, 'as_of_date': as_of, 'fetched_at': fetched_at, 'update_mode': values['update_mode'],
            'currency': values['currency'], 'financial_currency': values['fundamental_currency_code'],
            'market': _section(values, 'market', values['currency']),
            'financials': _section(values, 'financials', values['fundamental_currency_code']),
            'technicals': _section(values, 'technicals', values['currency']),
            'exchange': values['exchange'], 'is_primary': values['is_primary'], 'primary_exchange': values['exchange'],
            'listing_symbol': values['listing_symbol'],
        }
        extra = {name: values[column] for column, name in EXTRA.items()}
        result[isin] = {'tradingview_snapshot': snapshot, **extra}
    if not result:
        raise ValueError('TradingView returned no US listings')
    return result


def canonical(found: dict, record: dict, session: str) -> dict:
    """The engine's fields TradingView supplies for one record (India's names)."""
    snapshot = found['tradingview_snapshot']
    current = snapshot['as_of_date'] == session
    market = snapshot['market']
    close = record.get('close')
    # TradingView's all-time high, never below what the stored history has seen.
    highs = [value for value in (market.get('all_time_high'), record.get('high_52w'), record.get('high_5y')) if _number(value)]
    high = max(highs) if highs else None
    last_earnings = _eastern_date(found['last_earnings'])
    return {
        'tradingview_snapshot': snapshot,
        'all_time_high': high if current else None,
        'percent_from_ath': (close / high - 1) * 100 if current and high and close else None,
        'latest_earnings_date': last_earnings if last_earnings and last_earnings <= session else None,
        'next_earnings_date': _eastern_date(found['next_earnings']),
        'free_float_percent': _number(found['free_float_percent']),
        'dividend_yield_percent': _number(found['dividend_yield_percent']),
        'dividend_ex_date': _eastern_date(found['last_ex_dividend']),
        'next_dividend_ex_date': _eastern_date(found['next_ex_dividend']),
    }


def enrich(records: list[dict], session: str, *, fetch_response=fetch, now: datetime | None = None) -> dict:
    """Attach TradingView values to `records` in place; a failed request leaves them without (reported, not fatal)."""
    fetched_at = (now or datetime.now(timezone.utc)).isoformat()
    try:
        found = snapshots(fetch_response(), fetched_at)
    except Exception as error:  # the release still publishes; these filters report unavailable for the session
        print(f'::warning::TradingView US values unavailable: {error}', flush=True)
        return {'matched': 0, 'current': 0, 'error': str(error)}
    matched = current = 0
    for record in records:
        values = found.get(record.get('isin'))
        if values is None:
            continue
        record.update(canonical(values, record, session))
        matched += 1
        current += values['tradingview_snapshot']['as_of_date'] == session
    return {'matched': matched, 'current': current, 'listed': len(found)}

