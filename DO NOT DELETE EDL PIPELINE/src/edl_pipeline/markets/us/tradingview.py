"""US values from TradingView's scanner: one request for the whole market, as India's fetch_advanced_indicators.

It carries what Dhan cannot: all-time highs (Dhan's history starts in 2021), the last earnings date, listing date,
index memberships (S&P 500, Nasdaq-100, Dow 30, Russell 1000 and 2000), free float,
dividend yield, dividend per share and ex-date, VWAP, debt and free cash flow, and India's published TradingView metrics
(`tradingview_fields.json`, shared so the catalogue, publisher and both markets read one list). Its statement values
are the fallback for stocks whose Dhan page is missing or cannot be trusted (statements.py).

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
# Columns US screening reads beyond the shared metric list. The statement columns are a fallback: Dhan's stock page
# comes first when it can be trusted (statements.py), as Dhan does for India.
EXTRA = {'earnings_release_date': 'last_earnings', 'ipo_offer_date': 'ipo_date', 'first_bar_time': 'first_trade',
         'indexes': 'indexes',
         'float_shares_percent_current': 'free_float_percent', 'dividends_yield_current': 'dividend_yield_percent',
         'ex_dividend_date_recent': 'last_ex_dividend',
         'free_cash_flow_ttm': 'free_cash_flow', 'dps_common_stock_prim_issue_fy': 'dividend_per_share',
         'price_book_fq': 'pb_ratio', 'VWAP': 'vwap', 'total_debt_fq': 'total_debt', 'total_equity_fq': 'total_equity',
         # Trailing twelve months, where Dhan's quarters have a gap.
         'total_revenue_ttm': 'ttm_revenue', 'net_income_ttm': 'ttm_net_profit', 'operating_margin_ttm': 'operating_margin',
         'earnings_per_share_diluted_ttm': 'eps_ttm', 'earnings_per_share_diluted_yoy_growth_ttm': 'eps_growth',
         'total_revenue_yoy_growth_ttm': 'revenue_growth', 'net_income_yoy_growth_ttm': 'net_profit_growth',
         'return_on_assets_fq': 'roa', 'current_ratio_fq': 'current_ratio',
         # The latest quarter and balance sheet, the latest fiscal year's cash flow, and five-year revenue growth.
         'total_revenue_fq': 'quarter_revenue', 'net_income_fq': 'quarter_net_profit',
         'total_assets_fq': 'total_assets', 'total_current_assets_fq': 'current_assets',
         'total_current_liabilities_fq': 'current_liabilities', 'total_liabilities_fq': 'total_liabilities',
         'cash_f_operating_activities_fy': 'operating_cash_flow', 'cash_f_investing_activities_fy': 'investing_cash_flow',
         'cash_f_financing_activities_fy': 'financing_cash_flow', 'total_revenue_cagr_5y': 'revenue_cagr_5y'}
# Index memberships, by TradingView's name -> the label the release publishes. TradingView's lists match the issuers'
# holdings (SPY: 503 of 503; DIA: 30 of 30, checked 2026-11-10); it does not carry the S&P 400 or 600.
INDEXES = {'S&P 500': 'S&P 500', 'NASDAQ 100': 'NASDAQ 100', 'Dow Jones Industrial Average': 'DOW JONES 30',
           'Russell 1000': 'RUSSELL 1000', 'Russell 2000': 'RUSSELL 2000'}
# EXTRA columns that are amounts: stated in millions of dollars, and only when the company reports in dollars.
EXTRA_AMOUNTS = frozenset({'free_cash_flow', 'total_debt', 'total_equity', 'ttm_revenue', 'ttm_net_profit',
                           'quarter_revenue', 'quarter_net_profit', 'total_assets', 'current_assets', 'current_liabilities',
                           'total_liabilities', 'operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow'})
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
        dollars = values['fundamental_currency_code'] == UNITED_STATES.currency
        extra = {name: (_number(values[column]) / UNITED_STATES.provider_amount_unit
                        if dollars and _number(values[column]) is not None else None) if name in EXTRA_AMOUNTS
                 else values[column] for column, name in EXTRA.items()}
        result[isin] = {'tradingview_snapshot': snapshot, **extra}
    if not result:
        raise ValueError('TradingView returned no US listings')
    return result


def _difference(total, part):
    return total - part if total is not None and part is not None and total >= part else None


def _sum(*values):
    return None if any(value is None for value in values) else sum(values)


def _prior(value, growth_percent):
    """The value a year earlier, from today's value and its growth; None when the growth cannot say."""
    value, growth_percent = _number(value), _number(growth_percent)
    return value / (1 + growth_percent / 100) if value is not None and growth_percent is not None and growth_percent > -100 else None


def _utc_date(stamp) -> str | None:
    stamp = _number(stamp)
    return datetime.fromtimestamp(stamp, timezone.utc).date().isoformat() if stamp else None


def memberships(indexes) -> list[str]:
    names = {item.get('name') for item in indexes or [] if isinstance(item, dict)}
    return [label for name, label in INDEXES.items() if name in names]


def canonical(found: dict, record: dict, session: str) -> dict:
    """The engine's fields TradingView supplies for one record (India's names)."""
    snapshot = found['tradingview_snapshot']
    current = snapshot['as_of_date'] == session
    market = snapshot['market']
    close = record.get('close')
    # TradingView's all-time high, never below the 52-week high.
    highs = [value for value in (market.get('all_time_high'), record.get('high_52w')) if _number(value)]
    high = max(highs) if highs else None
    last_earnings = _eastern_date(found['last_earnings'])
    return {
        'tradingview_snapshot': snapshot,
        'all_time_high': high if current else None,
        'percent_from_ath': (close / high - 1) * 100 if current and high and close else None,
        'latest_earnings_date': last_earnings if last_earnings and last_earnings <= session else None,
        # The listing (IPO) date; the first traded day where TradingView has none.
        'listing_date': _utc_date(found['ipo_date']) or _utc_date(found['first_trade']),
        'index_memberships': memberships(found['indexes']),
        'free_float_percent': _number(found['free_float_percent']),
        'dividend_yield_percent': _number(found['dividend_yield_percent']),
        'dividend_ex_date': _eastern_date(found['last_ex_dividend']),
        'dividend_per_share_latest': _number(found['dividend_per_share']),
        'pb_ratio': _number(found['pb_ratio']),
        'vwap': _number(found['vwap']) if current else None,
        'vwap_as_of_date': session if current and _number(found['vwap']) else None,
        # Amounts in millions of dollars under India's names; debt over equity only for positive equity.
        'free_cash_flow_crore': found['free_cash_flow'],
        'borrowings_crore': found['total_debt'],
        'debt_to_equity': found['total_debt'] / found['total_equity']
        if found['total_debt'] is not None and found['total_equity'] and found['total_equity'] > 0 else None,
        'ttm_revenue_crore': found['ttm_revenue'], 'ttm_sales_crore': found['ttm_revenue'],
        'ttm_net_profit_crore': found['ttm_net_profit'],
        'ttm_revenue_growth_percent': _number(found['revenue_growth']), 'ttm_sales_growth_percent': _number(found['revenue_growth']),
        'ttm_net_profit_growth_percent': _number(found['net_profit_growth']),
        'operating_margin_ttm_percent': _number(found['operating_margin']),
        'roa_percent': _number(found['roa']), 'current_ratio': _number(found['current_ratio']),
        # India's statement fields (its names say lakh or crore; the US release states millions of dollars).
        'total_revenue_in_lakhs': found['quarter_revenue'], 'net_profit_in_lakhs': found['quarter_net_profit'],
        'total_assets_in_lakhs': found['total_assets'], 'total_equity_in_lakhs': found['total_equity'],
        'current_assets_in_lakhs': found['current_assets'], 'current_liabilities_in_lakhs': found['current_liabilities'],
        'total_liabilities_in_lakhs': found['total_liabilities'],
        'non_current_assets_in_lakhs': _difference(found['total_assets'], found['current_assets']),
        'non_current_liabilities_in_lakhs': _difference(found['total_liabilities'], found['current_liabilities']),
        'operating_cash_flow_in_lakhs': found['operating_cash_flow'], 'investing_cash_flow_in_lakhs': found['investing_cash_flow'],
        'financing_cash_flow_crore': found['financing_cash_flow'],
        'net_cash_flow_in_lakhs': _sum(found['operating_cash_flow'], found['investing_cash_flow'], found['financing_cash_flow']),
        'sales_growth_5_years_percent': _number(found['revenue_cagr_5y']),
        # "Last year" is the trailing twelve months; the year before follows from its growth (fiscal years differ).
        'eps_last_year': _number(found['eps_ttm']), 'eps_2_years_back': _prior(found['eps_ttm'], found['eps_growth']),
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

