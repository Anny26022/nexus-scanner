"""US statement lines TradingView does not carry, from Dhan's stock pages, when a page can be trusted.

TradingView's daily request (tradingview.py) supplies the statements first: trailing revenue, profit, margin and EPS,
the latest balance sheet, cash flow and five-year growth, current and in dollars. A Dhan stock page fills only what
is left: total income and expense, profit before tax, tax, interest coverage and PEG.

Dhan pages are not trusted blindly. They do not say their currency (a foreign company's figures are in its home
currency, read as dollars: TSMC's assets come out as $10 trillion) and some are years out of date (Costco's balance
sheet is from 2009). A page is used only when its latest quarterly revenue agrees with TradingView's.

A page carries 10 quarters of income statement (`incomeStat_sq`), 10 balance sheets (`bs_s`), 10 years of cash flow
(`cF_sy`) and of revenue and profit (`rNp_s`), and a few ratios (`CV`), newest first, joined by "|"; `YEAR` names each
period's end month (yyyymm). Dhan writes 0 for lines a company does not report. Not taken: its TTM block (all zeros),
capex, dividend yield and book value (zeros), CWIP (repeats fixed assets), analyst ratings and similar stocks.

Pages are cached under `<root>/stock_pages/` and fetched again when a week old or when the company has reported since
(TradingView's last earnings date is after the fetch). Fetches are paced and stop at a time budget; the rest wait for
the next run, so a first run spreads over several days instead of overrunning the job.
"""

from __future__ import annotations

import gzip
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ohlcv_utils import symbol_csv_path

from . import dhan

KEPT = ('incomeStat_sq', 'bs_s', 'cF_sy', 'rNp_s', 'CV')
REFRESH_AFTER = timedelta(days=7)
# Statement amounts are already millions of dollars, this market's amount unit; India's field names say lakh or
# crore, and the release declares the unit (see build.engine_amounts).


# --- page cache -------------------------------------------------------------------------------------------------

def page_path(root: Path, symbol: str) -> Path:
    return symbol_csv_path(root / 'stock_pages', symbol).with_suffix('.json.gz')


def read_page(root: Path, symbol: str) -> dict | None:
    path = page_path(root, symbol)
    if not path.exists():
        return None
    try:
        return json.loads(gzip.decompress(path.read_bytes()))
    except (OSError, ValueError):
        return None


def write_page(root: Path, symbol: str, page: dict):
    path = page_path(root, symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_bytes(gzip.compress(json.dumps(page, separators=(',', ':')).encode(), mtime=0))
    temporary.replace(path)


def stale(page: dict | None, record: dict, now: datetime) -> bool:
    """Whether to fetch again: never fetched, a week old, or the company has reported since."""
    if not page:
        return True
    fetched = datetime.fromisoformat(page['fetched_at'])
    reported = record.get('latest_earnings_date')
    return now - fetched >= REFRESH_AFTER or bool(reported and reported > fetched.date().isoformat())


def refresh_pages(records: list[dict], root: Path, now: datetime | None = None, *, pages: dhan.StockPages | None = None,
                  interval: float = 0.25, workers: int = 4, budget_seconds: float = 1200) -> dict:
    """Fetch the stale pages, oldest need first, until the time budget; returns counts."""
    now = now or datetime.now(timezone.utc)
    pages = pages or dhan.StockPages()
    due = [record for record in records if record.get('slug') and stale(read_page(root, record['symbol']), record, now)]
    # Never-fetched pages first, then the ones whose company has reported.
    due.sort(key=lambda record: read_page(root, record['symbol']) is not None)
    deadline, pacer, stopped = time.monotonic() + budget_seconds, dhan.Pacer(interval), threading.Event()
    counts, lock = {'due': len(due), 'fetched': 0, 'missing': 0, 'failed': 0}, threading.Lock()

    def one(record):
        if stopped.is_set() or time.monotonic() > deadline:
            return
        pacer.wait()
        try:
            props = pages.fetch(record['slug'])
        except dhan.Throttled:
            stopped.set()
            return
        except Exception as error:  # one page must not stop the market
            outcome = 'missing' if '404' in str(error) else 'failed'
        else:
            data = props.get('fundamentalsData') or {}
            outcome = 'fetched' if data else 'missing'
            if data:
                write_page(root, record['symbol'], {'fetched_at': now.isoformat(), 'slug': record['slug'],
                                                    **{key: data.get(key) for key in KEPT}})
        with lock:
            counts[outcome] += 1

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, due))
    counts['throttled'] = stopped.is_set()
    counts['left'] = counts['due'] - counts['fetched'] - counts['missing'] - counts['failed']
    return counts


# --- statements -------------------------------------------------------------------------------------------------

def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float('inf') else None


def series(block: dict | None) -> list[dict]:
    """A statement block as periods, newest first: [{'period': 'yyyymm', field: value, ...}]."""
    if not isinstance(block, dict) or not block.get('YEAR'):
        return []
    periods = str(block['YEAR']).split('|')
    columns = {key: str(value).split('|') for key, value in block.items() if key != 'YEAR' and isinstance(value, str)}
    rows = []
    for index, period in enumerate(periods):
        if len(period) != 6 or not period.isdigit():
            continue
        row = {'period': period}
        for key, values in columns.items():
            row[key] = _number(values[index]) if index < len(values) and values[index] != '' else None
        rows.append(row)
    return sorted(rows, key=lambda row: row['period'], reverse=True)


def _months(period: str) -> int:
    return int(period[:4]) * 12 + int(period[4:]) - 1


def consecutive(quarters: list[dict], count: int) -> list[dict] | None:
    """The latest `count` quarters when each is three months after the next; None when a quarter is missing."""
    chosen = quarters[:count]
    if len(chosen) < count or any(_months(a['period']) - _months(b['period']) != 3 for a, b in zip(chosen, chosen[1:])):
        return None
    return chosen


def _total(quarters: list[dict] | None, field: str):
    if quarters is None:
        return None
    values = [quarter.get(field) for quarter in quarters]
    return None if any(value is None for value in values) else sum(values)


def _growth(current, previous):
    return (current / previous - 1) * 100 if current is not None and previous and previous > 0 else None


def _ratio(numerator, denominator, percent=False):
    if numerator is None or not denominator:
        return None
    return numerator / denominator * (100 if percent else 1)


def statement_fields(page: dict) -> dict:
    """India's statement fields from one page (amounts in millions of dollars under India's names)."""
    quarters = series(page.get('incomeStat_sq'))
    balances = series(page.get('bs_s'))
    cash_flows = series(page.get('cF_sy'))
    years = series(page.get('rNp_s'))
    ratios = page.get('CV') or {}
    latest = quarters[0] if quarters else {}
    trailing, earlier = consecutive(quarters, 4), consecutive(quarters, 8)
    prior = earlier[4:] if earlier else None
    revenue, net_profit = _total(trailing, 'REVENUE'), _total(trailing, 'NET_PROFIT')
    operating, interest = _total(trailing, 'OPERATING_PROFIT'), _total(trailing, 'INTEREST')
    before_tax = _total(trailing, 'PROFIT_BEFORE_TAX')
    # Dhan writes 0 for lines a company does not report (a bank has no current assets or operating profit).
    balance = {key: value or None for key, value in (balances[0] if balances else {}).items()}
    equity, assets = balance.get('TOTAL_EQUITY'), balance.get('TOTAL_ASSETS')
    current_assets, current_liabilities = balance.get('CURRENT_ASSETS'), balance.get('CURRENT_LIABILITIES')
    cash = cash_flows[0] if cash_flows else {}
    revenue_now = years[0].get('REVENUE') if years else None
    revenue_five = years[5].get('REVENUE') if len(years) > 5 else None
    fields = {
        # The latest quarter, as India's quarterly statement fields.
        'total_revenue_in_lakhs': latest.get('REVENUE'),
        'total_income_in_lakhs': (latest['REVENUE'] + (latest.get('OTHER_INCOME') or 0)) if latest.get('REVENUE') is not None else None,
        'total_expense_in_lakhs': latest.get('EXPENSES'),
        'profit_before_tax_in_lakhs': latest.get('PROFIT_BEFORE_TAX'),
        'total_tax_expenses_in_lakhs': latest.get('TAX_PAYMENT_ABSOLUTE'),
        'net_profit_in_lakhs': latest.get('NET_PROFIT'),
        # The last four quarters, and the four before them.
        'ttm_revenue_crore': revenue, 'ttm_sales_crore': _total(trailing, 'SALES') or revenue,
        'ttm_net_profit_crore': net_profit,
        'ttm_revenue_growth_percent': _growth(revenue, _total(prior, 'REVENUE')),
        'ttm_sales_growth_percent': _growth(_total(trailing, 'SALES') or revenue, _total(prior, 'SALES') or _total(prior, 'REVENUE')),
        'ttm_net_profit_growth_percent': _growth(net_profit, _total(prior, 'NET_PROFIT')),
        'operating_margin_ttm_percent': _ratio(operating, revenue, percent=True) if operating else None,
        # India's formulas (transforms/fundamentals.py), over the last four quarters.
        'interest_coverage': (before_tax + interest) / interest
        if before_tax is not None and interest and interest > 0 and operating else None,
        # "Last year" and "two years back" are the last four quarters and the four before (fiscal years differ).
        'eps_last_year': _total(trailing, 'EPS'), 'eps_2_years_back': _total(prior, 'EPS'),
        # The latest balance sheet.
        'total_assets_in_lakhs': assets, 'total_equity_in_lakhs': equity,
        'current_assets_in_lakhs': current_assets, 'current_liabilities_in_lakhs': current_liabilities,
        'non_current_liabilities_in_lakhs': balance.get('NON_CURRENT_LIABILITIES'),
        'non_current_assets_in_lakhs': assets - current_assets
        if assets is not None and current_assets is not None and assets >= current_assets else None,
        'total_liabilities_in_lakhs': current_liabilities + balance['NON_CURRENT_LIABILITIES']
        if current_liabilities is not None and balance.get('NON_CURRENT_LIABILITIES') is not None else None,
        'current_ratio': _ratio(current_assets, current_liabilities),
        'roa_percent': _ratio(net_profit, assets, percent=True),
        # The latest fiscal year's cash flow.
        'operating_cash_flow_in_lakhs': cash.get('OPERATING_ACTIVITIES'),
        'investing_cash_flow_in_lakhs': cash.get('INVESTING_ACTIVITIES'),
        'financing_cash_flow_crore': cash.get('FINANCING_ACTIVITIES'),
        'net_cash_flow_in_lakhs': cash.get('NET_CASH_FLOW'),
        'sales_growth_5_years_percent': (revenue_now / revenue_five) ** (1 / 5) * 100 - 100
        if revenue_now and revenue_five and revenue_now > 0 and revenue_five > 0 else None,
        'peg_ratio': _number(ratios.get('PEG')) or None,
    }
    return fields


# Dhan's latest quarter must match TradingView's to within this, or the page is stale or in another currency.
AGREEMENT = 0.10


def trusted(page: dict, record: dict) -> bool:
    """Whether a page's figures are this company's current dollars. Dhan does not say its currency and keeps some
    pages years out of date (Costco's balance sheet is from 2009; TSMC's amounts are Taiwan dollars), and ADRs carry
    US ISINs, so the only safe test is agreement: Dhan's latest quarterly revenue within 10% of TradingView's.
    """
    quarters = series(page.get('incomeStat_sq'))
    revenue, reference = (quarters[0].get('REVENUE') if quarters else None), record.get('total_revenue_in_lakhs')
    return bool(revenue and reference) and abs(revenue / reference - 1) <= AGREEMENT


def enrich(records: list[dict], root: Path) -> dict:
    """Fill what TradingView left empty from each record's cached page, when the page can be trusted."""
    read = refused = 0
    oldest = None
    for record in records:
        page = read_page(root, record['symbol'])
        if not page:
            continue
        if not trusted(page, record):
            refused += 1
            continue
        # TradingView's daily values come first (tradingview.py); the page fills what they leave empty.
        record.update({key: value for key, value in statement_fields(page).items() if value is not None and record.get(key) is None})
        record['financial_metadata'] = {
            'source': 'TradingView US scanner, then the Dhan US stock page', 'amount_unit': 'USD_MILLION',
            'fetched_at': page['fetched_at'],
            'quarter': (series(page.get('incomeStat_sq')) or [{}])[0].get('period'),
            'balance_sheet_year': (series(page.get('bs_s')) or [{}])[0].get('period'),
            'ttm_formula': 'sum of the last four consecutive quarters',
            'interest_coverage_formula': '(trailing profit before tax + interest) / interest',
            'non_current_assets_formula': 'total assets - current assets',
            'total_liabilities_formula': 'current liabilities + non-current liabilities',
        }
        fetched = page['fetched_at'][:10]
        oldest = fetched if oldest is None or fetched < oldest else oldest
        read += 1
    return {'with_statements': read, 'refused': refused, 'oldest_page': oldest}

