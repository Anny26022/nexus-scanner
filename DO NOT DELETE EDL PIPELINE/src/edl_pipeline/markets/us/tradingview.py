"""US values from TradingView's scanner: the whole market in a few paged requests (fetch_advanced_indicators is India's).

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
# Dhan's stock list also holds closed-end funds, units (SPACs) and some ETFs, which TradingView files as funds: without
# them about 600 listings would have no daily bar (2026-11-20).
TYPES = ('stock', 'dr', 'fund')
# Columns US screening reads beyond the shared metric list. The statement columns are a fallback: Dhan's stock page
# comes first when it can be trusted (statements.py), as Dhan does for India.
EXTRA = {'earnings_release_date': 'last_earnings', 'earnings_release_next_date': 'next_earnings',
         'earnings_release_next_time': 'next_earnings_time', 'ipo_offer_date': 'ipo_date', 'first_bar_time': 'first_trade',
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
         'cash_f_financing_activities_fy': 'financing_cash_flow', 'total_revenue_cagr_5y': 'revenue_cagr_5y',
         # Multiples, margins, ratios, beta, volatility and float (no analyst targets or ratings: not wanted in US data).
         'price_sales_current': 'ps_ratio',
         'gross_margin_ttm': 'gross_margin_percent', 'net_margin_ttm': 'net_margin_percent',
         'return_on_equity_fq': 'roe_percent', 'return_on_invested_capital_fq': 'roic_percent',
         'quick_ratio_fq': 'quick_ratio', 'long_term_debt_to_equity_fq': 'lt_debt_to_equity',
         'beta_1_year': 'beta', 'Volatility.W': 'volatility_week_percent', 'Volatility.M': 'volatility_month_percent',
         'float_shares_outstanding': 'float_shares', 'total_shares_outstanding': 'shares_outstanding',
         'earnings_per_share_forecast_next_fq': 'eps_forecast_next_quarter'}
# Index memberships, by TradingView's name -> the label the release publishes. TradingView's lists match the issuers'
# holdings (SPY: 503 of 503; DIA: 30 of 30, checked 2026-11-10); it does not carry the S&P 400 or 600.
INDEXES = {'S&P 500': 'S&P 500', 'NASDAQ 100': 'NASDAQ 100', 'Dow Jones Industrial Average': 'DOW JONES 30',
           'Russell 1000': 'RUSSELL 1000', 'Russell 2000': 'RUSSELL 2000'}
# EXTRA columns that are amounts: stated in millions of dollars, and only when the company reports in dollars.
EXTRA_AMOUNTS = frozenset({'free_cash_flow', 'total_debt', 'total_equity', 'ttm_revenue', 'ttm_net_profit',
                           'quarter_revenue', 'quarter_net_profit', 'total_assets', 'current_assets', 'current_liabilities',
                           'total_liabilities', 'operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow'})
# The session's daily bar (history.py appends it): `time` dates it, `close - change_abs` is the previous session's close.
BAR = ('name', 'open', 'high', 'low', 'volume', 'change_abs')
# Statement history, newest first: 32 quarters and up to 20 fiscal years, in dollars (foreign reporters converted).
# The arrays carry no period dates; `quarters` dates them from the latest period end and checks them (see there).
HISTORY = {'total_revenue_fq_h': 'revenue', 'net_income_fq_h': 'net_profit', 'earnings_per_share_diluted_fq_h': 'eps',
           'ebitda_fq_h': 'ebitda'}
ANNUAL = {'total_revenue_fy_h': 'revenue', 'net_income_fy_h': 'net_profit', 'earnings_per_share_diluted_fy_h': 'eps',
          'ebitda_fy_h': 'ebitda', 'total_assets_fy_h': 'total_assets'}
HISTORY_DATES = ('fiscal_period_end_fq', 'fiscal_period_end_fy')
COLUMNS = ['isin', 'time', 'close', 'update_mode', 'currency', 'fundamental_currency_code', 'exchange', 'is_primary', 'type',
           *[field['wire'] for field in FIELD_DEFINITIONS], *EXTRA, *BAR, *HISTORY, *ANNUAL, *HISTORY_DATES]
# Rows per request. The market is about 7,000 listings; one 12,000-row request was slow enough to time out, and a
# timed-out request lost every row. Pages are sorted by name so a row does not move between pages.
PAGE_SIZE = 5_000
PAGE_RETRIES = 2
MAX_PAGES = 10
# Fewer records matched than this share means TradingView's answer is not this market (enrich reports an error).
MIN_MATCHED_SHARE = 0.5


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


def fetch(*, post=post_json, page_size: int = PAGE_SIZE) -> dict:
    """Every row, page by page (each page retried), as one response: {'totalCount', 'data'}. `snapshots` refuses it
    unless the rows add up to the count."""
    rows, total = [], None
    for _ in range(MAX_PAGES):
        payload = {'columns': COLUMNS, 'markets': ['america'], 'options': {'lang': 'en'},
                   'range': [len(rows), len(rows) + page_size], 'sort': {'sortBy': 'name', 'sortOrder': 'asc'},
                   'filter': [{'left': 'type', 'operation': 'in_range', 'right': list(TYPES)},
                              {'left': 'exchange', 'operation': 'in_range', 'right': list(EXCHANGES)}]}
        response = post(API_URL, payload, timeout=60, retries=PAGE_RETRIES)
        page = response.get('data') if isinstance(response, dict) else None
        if not isinstance(page, list):
            raise ValueError('Unexpected TradingView scanner page')
        count = response.get('totalCount')
        if total is not None and count != total:
            raise ValueError(f'TradingView row count changed while paging ({total} -> {count})')
        total = count
        rows.extend(page)
        if not page or not isinstance(total, int) or len(rows) >= total:
            break
    return {'totalCount': total, 'data': rows}


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
        result[isin] = {'tradingview_snapshot': snapshot, **extra, 'bar': {key: values[key] for key in ('time', 'close', *BAR)},
                        'history': {key: values[key] for key in (*HISTORY, *ANNUAL, *HISTORY_DATES)}}
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


def daily_bar(found: dict, session: str) -> dict:
    """The session's bar and the previous session's close, for history.py.

    Checked against Yahoo and Nasdaq on 2026-11-20 (300 stocks): volume, open, high and low are the session's final
    values, but the close is not yet the official close for about 7% of stocks (late prints; V 402.425 against
    401.87), until the next session starts. The previous close (`close - change_abs`) is the official one, so each
    run corrects the bar the run before it appended. Only a bar dated to the session is returned.
    """
    bar = found.get('bar') or {}
    close, change = _number(bar.get('close')), _number(bar.get('change_abs'))
    previous = close - change if close is not None and change is not None and close - change > 0 else None
    prices = [_number(bar.get(key)) for key in ('open', 'high', 'low')] + [close]
    volume = _number(bar.get('volume'))  # 0 is a real (untraded) reading; a missing one is no bar
    if (_eastern_date(bar.get('time')) != session or any(price is None or price <= 0 for price in prices)
            or volume is None or volume < 0):
        return {'tradingview_bar': None, 'tradingview_previous_close': previous}
    return {'tradingview_bar': {'date': session, 'open': prices[0], 'high': prices[1], 'low': prices[2], 'close': close,
                                'volume': volume},
            'tradingview_previous_close': previous}


def _month(stamp) -> int | None:
    stamp = _number(stamp)
    if not stamp:
        return None
    day = datetime.fromtimestamp(stamp, timezone.utc)
    return day.year * 12 + day.month - 1


# Four quarters are one fiscal year when they add up to its revenue within this (rounding, small restatements), or
# within YEAR_ROUNDING dollars for a company so small that 1% is less than its figures' rounding.
YEAR_TOLERANCE = 0.01
YEAR_ROUNDING = 1_000


def _rows(columns: dict, history: dict, count: int, latest: int, step: int) -> list[dict]:
    """`count` dated rows, newest first: row i is `step` months before the previous one; amounts in millions."""
    rows = []
    for index in range(count):
        month = latest - step * index
        row = {'period': f'{month // 12}{month % 12 + 1:02d}'}
        for key, name in columns.items():
            values = history.get(key) or []
            value = _number(values[index]) if index < len(values) else None
            row[name] = value if value is None or name == 'eps' else value / UNITED_STATES.provider_amount_unit
        rows.append(row)
    return rows


def quarters(found: dict) -> dict:
    """The quarterly and annual history TradingView's arrays hold, dated, newest first, as far back as verified.

    The arrays carry no dates, so quarter i is dated i quarters before the latest quarter end. That holds until a
    quarter is missing: TradingView does not leave a gap but moves the older quarters up (seen for new listings,
    spin-offs and restatements: SPCX, LBTYA, CIRC, NEGG; 2026-11-22), which would date every older quarter wrong. So
    each fiscal year is checked: its four quarters must add up to TradingView's annual revenue. Quarters are kept up to
    the first year that disagrees, and none when the first does (most banks, whose quarterly and annual revenue are
    defined differently, and semi-annual reporters). The annual rows are the years that check verified. Amounts in
    millions of dollars.
    """
    history = found.get('history') or {}
    revenue, years = history.get('total_revenue_fq_h') or [], history.get('total_revenue_fy_h') or []
    latest, year_end = _month(history.get('fiscal_period_end_fq')), _month(history.get('fiscal_period_end_fy'))
    if not revenue or not years or latest is None or year_end is None or latest < year_end:
        return {'quarters': [], 'years': [], 'year_end_month': None}
    # Quarters after the latest fiscal year end (the current fiscal year so far) come first.
    start = round((latest - year_end) / 3)
    agreeing = 0
    for index, total in enumerate(years):
        part = revenue[start + 4 * index: start + 4 * index + 4]
        # Finite numbers only: a NaN would compare as agreeing and extend the dated history.
        if _number(total) is None or len(part) < 4 or any(_number(value) is None for value in part):
            break
        if abs(sum(part) - total) > max(abs(total) * YEAR_TOLERANCE, YEAR_ROUNDING):
            break
        agreeing += 1
    count = start + 4 * agreeing if agreeing else 0
    return {'quarters': _rows(HISTORY, history, count, latest, 3), 'years': _rows(ANNUAL, history, agreeing, year_end, 12),
            'year_end_month': f'{year_end % 12 + 1:02d}'}


def average_roa(found: dict, years: int = 3) -> float | None:
    """The average return on assets over the last `years` fiscal years, in percent: each year's net income over the
    average of its opening and closing total assets, TradingView's own ROA (AAPL FY2026: 34.61%). India's ScanX field
    (Year3ROA) has no US counterpart in Dhan's screener."""
    history = found.get('history') or {}
    income, assets = history.get('net_income_fy_h') or [], history.get('total_assets_fy_h') or []
    values = []
    for index in range(years):
        net, closing, opening = (_number(column[i]) if i < len(column) else None
                                 for column, i in ((income, index), (assets, index), (assets, index + 1)))
        if net is None or not closing or not opening or closing + opening <= 0:
            return None
        values.append(net / ((closing + opening) / 2) * 100)
    return sum(values) / years


def canonical(found: dict, record: dict, session: str) -> dict:
    """The engine's fields TradingView supplies for one record (India's names)."""
    snapshot = found['tradingview_snapshot']
    current = snapshot['as_of_date'] == session
    dollars = snapshot.get('financial_currency') == UNITED_STATES.currency
    market = snapshot['market']
    close = record.get('close')
    # TradingView's all-time high, never below the 52-week high.
    highs = [value for value in (market.get('all_time_high'), record.get('high_52w')) if _number(value)]
    high = max(highs) if highs else None
    last_earnings = _eastern_date(found['last_earnings'])
    return {
        'tradingview_snapshot': snapshot,
        'all_time_high': high if current else None,
        # As India's (enrich_published_fields.py): the positive distance below the high, which the filter compares.
        'percent_from_ath': (1 - close / high) * 100 if current and high and close else None,
        'latest_earnings_date': last_earnings if last_earnings and last_earnings <= session else None,
        # The next report's date (its time of day: -1 before the open, 1 after the close, 0 not yet known).
        'next_earnings_date': _eastern_date(found.get('next_earnings')),
        'next_earnings_time': _number(found.get('next_earnings_time')),
        # The listing (IPO) date; the first traded day where TradingView has none.
        'listing_date': _utc_date(found['ipo_date']) or _utc_date(found['first_trade']),
        'index_memberships': memberships(found['indexes']),
        'free_float_percent': _number(found['free_float_percent']),
        'dividend_yield_percent': _number(found['dividend_yield_percent']),
        'dividend_ex_date': _eastern_date(found['last_ex_dividend']),
        # Per-share values are in the company's reporting currency (ASML's in euros): kept only when that is dollars.
        'dividend_per_share_latest': _number(found['dividend_per_share']) if dollars else None,
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
        'eps_last_year': _number(found['eps_ttm']) if dollars else None,
        'eps_2_years_back': _prior(found['eps_ttm'], found['eps_growth']) if dollars else None,
        # Multiples, margins, ratios, beta, volatility and float.
        'ps_ratio': _number(found.get('ps_ratio')),
        'gross_margin_percent': _number(found.get('gross_margin_percent')),
        'net_margin_percent': _number(found.get('net_margin_percent')),
        'roe_percent': _number(found.get('roe_percent')),
        'roic_percent': _number(found.get('roic_percent')),
        'quick_ratio': _number(found.get('quick_ratio')),
        'lt_debt_to_equity': _number(found.get('lt_debt_to_equity')),
        'beta': _number(found.get('beta')),
        'volatility_week_percent': _number(found.get('volatility_week_percent')),
        'volatility_month_percent': _number(found.get('volatility_month_percent')),
        'float_shares': _number(found.get('float_shares')),
        'shares_outstanding': _number(found.get('shares_outstanding')),
        'eps_forecast_next_quarter': _number(found.get('eps_forecast_next_quarter')) if dollars else None,
        # India's averageRoa3yPct; a ratio, so it holds in any reporting currency.
        'average_roa_3y_percent': average_roa(found),
    }


def enrich(records: list[dict], session: str, *, fetch_response=fetch, now: datetime | None = None) -> dict:
    """Attach TradingView values to `records` in place. Any failure is in the report's `error`, which the release
    refuses to publish with (listing dates, index memberships, earnings dates and all-time highs would be missing):
    a failed or incomplete request, or fewer than MIN_MATCHED_SHARE of the records matched (an answer that is not
    this market's listings). Records matched before the share check keep their values; the build goes on."""
    fetched_at = (now or datetime.now(timezone.utc)).isoformat()
    try:
        found = snapshots(fetch_response(), fetched_at)
    except Exception as error:  # reported to the caller, which refuses to publish
        print(f'::warning::TradingView US values unavailable: {error}', flush=True)
        return {'matched': 0, 'current': 0, 'error': str(error) or type(error).__name__}
    matched = current = 0
    # A listing whose ISIN differs between the two providers is matched by its ticker instead, but only when one
    # listing has that ticker: the scan spans four exchanges and funds, and another security's values must not apply.
    by_ticker: dict[str, list] = {}
    for values in found.values():
        ticker = (values.get('bar') or {}).get('name')
        if ticker:
            by_ticker.setdefault(ticker, []).append(values)
    for record in records:
        candidates = by_ticker.get(record.get('symbol')) or []
        values = found.get(record.get('isin')) or (candidates[0] if len(candidates) == 1 else None)
        if values is None:
            continue
        record.update(canonical(values, record, session))
        record.update(daily_bar(values, session))
        record['tradingview_quarters'] = quarters(values)
        matched += 1
        current += values['tradingview_snapshot']['as_of_date'] == session
    report = {'matched': matched, 'current': current, 'listed': len(found)}
    if records and matched < len(records) * MIN_MATCHED_SHARE:
        report['error'] = f'TradingView matched {matched} of {len(records)} records'
        print(f"::warning::{report['error']}", flush=True)
    return report

