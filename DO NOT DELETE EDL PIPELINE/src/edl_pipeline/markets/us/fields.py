"""Dhan's US screener fields mapped onto the scanner's canonical stock record.

Values keep India's canonical names (close, perf_12m, high_52w, pe_ratio, roe_percent, ...), so filters that read them
work for both markets unchanged. Only fields the release reads are requested. Amounts never reuse India's unit-named fields (market_cap_crore,
rupee_volume): they are full amounts in the record's `currency`, named without a unit.

Dhan's US market cap is in millions of US dollars (Apple: 4,976,937). Volume and share counts are plain numbers.
"""

from __future__ import annotations

from datetime import datetime
from math import isfinite
from zoneinfo import ZoneInfo

from .. import UNITED_STATES

# Requested from the global screener: what the release reads, nothing more. Exch, Inst and Seg label the breadth
# universe; the rest map through DIRECT. Mcap and LastTradeTime are read in canonical_row.
SNAPSHOT_FIELDS = [
    'Sym', 'DispSym', 'Seosym', 'Isin', 'Sid', 'Exch', 'Cust_Exch', 'Inst', 'OgInst', 'Seg', 'LastTradeTime',
    'Ltp', 'BcClose', 'Open', 'High', 'Low', 'Volume', 'PPerchange',
    'PricePerchng1week', 'PricePerchng1mon', 'PricePerchng3mon', 'PricePerchng6mon',
    'PricePerchng1year', 'PricePerchng3year', 'PricePerchng5year', 'High1Yr', 'Low1Yr',
    'Mcap', 'Sector', 'SubSector', 'Pe', 'Ind_Pe', 'ReturnOnEquity', 'ROCE', 'YearlyEarningPerShare', 'Year1CAGREPSGrowth',
    # India's SCREEN_METRICS tags the US screener fills; percentages only (its amounts, such as FixedAssets and CWIP,
    # are in each company's home currency for foreign listings and do not say so).
    'Year3ROE', 'Year5AvgOperatingProfit', 'Year5MedianSalesGrowth', 'Year3CAGREPSGrowth', 'Year3CAGRRevenueGrowth',
]

# Screener field -> India's canonical field.
DIRECT = {
    'Sym': 'symbol', 'DispSym': 'name', 'Isin': 'isin', 'Sid': 'security_id', 'Cust_Exch': 'exchange', 'Seosym': 'slug',
    'Sector': 'sector', 'SubSector': 'industry',
    'Ltp': 'close', 'BcClose': 'previous_close', 'Open': 'open', 'High': 'high', 'Low': 'low', 'Volume': 'volume',
    'PPerchange': 'change_percent', 'High1Yr': 'high_52w', 'Low1Yr': 'low_52w',
    'PricePerchng1week': 'perf_1w', 'PricePerchng1mon': 'perf_1m', 'PricePerchng3mon': 'perf_3m', 'PricePerchng6mon': 'perf_6m',
    'PricePerchng1year': 'perf_12m', 'PricePerchng3year': 'return_3y', 'PricePerchng5year': 'return_5y',
    'Pe': 'pe_ratio', 'Ind_Pe': 'industry_pe_ratio', 'ReturnOnEquity': 'roe_percent', 'ROCE': 'roce_percent',
    'YearlyEarningPerShare': 'eps_ttm', 'Year1CAGREPSGrowth': 'eps_growth_1y_percent',
    'Year3ROE': 'average_roe_3y_percent', 'Year5AvgOperatingProfit': 'average_opm_5y_percent',
    'Year5MedianSalesGrowth': 'median_sales_growth_5y_percent', 'Year3CAGREPSGrowth': 'eps_cagr_3y_percent',
    'Year3CAGRRevenueGrowth': 'revenue_cagr_3y_percent',
}
TEXT_FIELDS = frozenset({'symbol', 'name', 'isin', 'exchange', 'slug', 'sector', 'industry'})
KIND_BY_INSTRUMENT = {'ES': 'stock', 'ETF': 'etf'}
# Dhan stamps its own times in Indian time, whatever the market.
_DHAN_TIME = ZoneInfo('Asia/Kolkata')


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _last_trade(value):
    """Dhan's 'DD/MM/YYYY HH:MM:SS' (IST) as an ISO timestamp."""
    try:
        return datetime.strptime(value, '%d/%m/%Y %H:%M:%S').replace(tzinfo=_DHAN_TIME).isoformat()
    except (TypeError, ValueError):
        return None


def canonical_row(row: dict) -> dict | None:
    """One screener row as a canonical US record; None for a row without a symbol, id or price."""
    record = {'market': UNITED_STATES.id, 'currency': UNITED_STATES.currency,
              'instrument': KIND_BY_INSTRUMENT.get(row.get('OgInst'), 'stock')}
    for source, target in DIRECT.items():
        value = row.get(source)
        # Text stays text; every other field is a number (Dhan sometimes sends numbers as strings).
        record[target] = value if target in TEXT_FIELDS or value is None else _number(value)
    if record['security_id'] is not None:
        try:
            record['security_id'] = int(record['security_id'])
        except (TypeError, ValueError, OverflowError):
            return None
    if not record['symbol'] or record['security_id'] is None or not record['close'] or record['close'] <= 0:
        return None
    market_cap = _number(row.get('Mcap'))
    record['market_cap'] = market_cap * UNITED_STATES.provider_amount_unit if market_cap is not None else None
    record['dollar_volume'] = record['close'] * record['volume'] if record['volume'] is not None else None
    # Read while building (the snapshot's session); not published.
    record['provider_last_trade_ist'] = _last_trade(row.get('LastTradeTime'))
    return record
