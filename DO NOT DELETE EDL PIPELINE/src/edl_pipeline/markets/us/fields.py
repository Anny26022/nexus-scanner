"""Dhan's US screener fields mapped onto the scanner's canonical stock record.

Unit-free values keep India's canonical names (close, perf_12m, high_52w, pe_ratio, roe_percent, ...), so filters that
read them work for both markets unchanged. Amounts never reuse India's unit-named fields (market_cap_crore,
rupee_volume): they are full amounts in the record's `currency`, named without a unit.

Dhan's US market cap is in millions of US dollars (Apple: 4,976,937). Volume and share counts are plain numbers.
"""

from __future__ import annotations

from datetime import datetime
from math import isfinite
from zoneinfo import ZoneInfo

from .. import UNITED_STATES

# Requested from the global screener; all are filled for US stocks (ETFs leave the fundamentals empty).
SNAPSHOT_FIELDS = [
    'Sym', 'DispSym', 'Seosym', 'Isin', 'Sid', 'Exch', 'Cust_Exch', 'Inst', 'OgInst', 'Seg', 'LastTradeTime',
    'Ltp', 'BcClose', 'Open', 'High', 'Low', 'Volume', 'Pchange', 'PPerchange',
    'PricePerchng1week', 'PricePerchng2week', 'PricePerchng1mon', 'PricePerchng3mon', 'PricePerchng6mon',
    'PricePerchng1year', 'PricePerchng3year', 'PricePerchng5year',
    'High1Wk', 'High1Yr', 'Low1Yr', 'High3Yr', 'High5yr', 'RtAwayFrom1MonthHigh', 'RtAwayFrom5YearHigh',
    'Mcap', 'TotalShares', 'Sector', 'Pe', 'Ind_Pe', 'ReturnOnEquity', 'ROCE', 'NetProfitMargin',
    'Year1RevenueGrowth', 'YearlyEarningPerShare', 'Year1CAGREPSGrowth', 'YoYLastQtrlyProfitGrowth',
]

# Screener field -> canonical field, for values that carry over as they are.
DIRECT = {
    'Sym': 'symbol', 'DispSym': 'name', 'Isin': 'isin', 'Sid': 'security_id', 'Cust_Exch': 'exchange', 'Sector': 'sector',
    'Ltp': 'close', 'BcClose': 'previous_close', 'Open': 'open', 'High': 'high', 'Low': 'low', 'Volume': 'volume',
    'PPerchange': 'change_percent',
    'PricePerchng1week': 'perf_1w', 'PricePerchng2week': 'perf_2w', 'PricePerchng1mon': 'perf_1m', 'PricePerchng3mon': 'perf_3m',
    'PricePerchng6mon': 'perf_6m', 'PricePerchng1year': 'perf_12m', 'PricePerchng3year': 'perf_3y', 'PricePerchng5year': 'perf_5y',
    'High1Wk': 'high_1w', 'High1Yr': 'high_52w', 'Low1Yr': 'low_52w', 'High3Yr': 'high_3y', 'High5yr': 'high_5y',
    'RtAwayFrom1MonthHigh': 'percent_from_1m_high', 'RtAwayFrom5YearHigh': 'percent_from_5y_high',
    'TotalShares': 'shares_outstanding', 'Pe': 'pe_ratio', 'Ind_Pe': 'industry_pe_ratio', 'ReturnOnEquity': 'roe_percent',
    'ROCE': 'roce_percent', 'NetProfitMargin': 'net_margin_percent', 'Year1RevenueGrowth': 'revenue_growth_1y_percent',
    'YearlyEarningPerShare': 'eps_ttm', 'Year1CAGREPSGrowth': 'eps_growth_1y_percent',
    'YoYLastQtrlyProfitGrowth': 'quarterly_profit_growth_yoy_percent',
}
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
        record[target] = value if isinstance(value, str) or value is None else _number(value)
    if record['security_id'] is not None:
        record['security_id'] = int(record['security_id'])
    if not record['symbol'] or record['security_id'] is None or not record['close'] or record['close'] <= 0:
        return None
    market_cap = _number(row.get('Mcap'))
    record['market_cap'] = market_cap * UNITED_STATES.provider_amount_unit if market_cap is not None else None
    record['dollar_volume'] = record['close'] * record['volume'] if record['volume'] is not None else None
    if record['high_52w'] and record['low_52w']:
        record['distance_from_52w_high_percent'] = (record['close'] / record['high_52w'] - 1) * 100
        record['distance_from_52w_low_percent'] = (record['close'] / record['low_52w'] - 1) * 100
    record['slug'] = row.get('Seosym')
    record['provider_last_trade_ist'] = _last_trade(row.get('LastTradeTime'))
    return record
