"""Per-stock earnings facts for the scanner's Earnings scans, from data both markets already publish.

Each stock row gets an `earnings` object built from its quarterly results (`financial_statement_history`), its latest
results date and its daily bars:

- `q`: the last four reported quarters, oldest first, each with its year-on-year growth in sales, EPS and net profit,
  net margin, net profit and year-ago EPS. Growth is always against the same quarter a year earlier: Indian quarters
  are seasonal. EPS growth is taken from net profit where the share count moved (a split, bonus or issue) by more than
  SHARE_DRIFT, since unadjusted EPS would then mislead (`epsBasis: 'PAT'`).
- `behind`: how many quarters the latest result lags the quarter it should have reported by now.
- `basis`: CONSOLIDATED, or STANDALONE where the consolidated quarters are missing or stale (one basis per stock).
- `taxCredit`: a quarter among the last three booked a tax credit worth at least TAX_CREDIT_SHARE of its profit, a
  one-off the streak scans skip.
- `reaction`: the session that could react to the results (two when the filing's timing is unknown), each with its gap, day move, close in
  the day's range, close against open and how far the gap is still unfilled.
- `declared`: the latest results date (the later of the stock's own record and Earnings Pulse's filing day, see
  merge_results_dates), with `declaredAge` in sessions.
- `next` and `nextTiming`: the next scheduled results date (the earnings calendar, else Earnings Pulse's upcoming
  list) and when in the day it falls (Pre, During, After) where Earnings Pulse says.

The thresholds live in the app's scan recipes, so a reader can tune them as on any other scan.

On the row, `q` and `reaction` are lists of positional arrays in QUARTER_FIELDS and REACTION_FIELDS order (every
row carries them, so the field names are not repeated); the app's earningsConditions.ts reads the same orders.
"""
import gzip
import json
import math
from datetime import date, timedelta

QUARTERS = 4
# A quarter's results are due within about 45 days of its end (60 for the year-end quarter); allow the longer one.
RESULTS_LAG_DAYS = 60
# Implied share counts (net profit / EPS) further apart than this mean EPS is not comparable year on year.
SHARE_DRIFT = 0.2
# A negative tax line at least this share of the quarter's profit is a one-off credit, not earnings.
TAX_CREDIT_SHARE = 0.1
# The row's positional orders (see the module docstring); `epsBasis` is 1 for EPS, 0 where growth is from profit.
QUARTER_FIELDS = ('end', 'sales', 'eps', 'pat', 'npm', 'np', 'np0', 'eps0', 'epsBasis')
REACTION_FIELDS = ('age', 'gap', 'move', 'pos', 'vsOpen', 'unfilled')
# Earnings Pulse's `timing` of a filing against market hours.
TIMINGS = ('Pre', 'During', 'After')


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _day(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _growth(now, then):
    """Percent change from a positive base; None from a loss or zero, where a percentage means nothing."""
    return round((now / then - 1) * 100, 1) if now is not None and then is not None and then > 0 else None


def _year_ago(quarters, index):
    """The quarter ending about a year before `quarters[index]`."""
    end = _day(quarters[index].get('period_end'))
    for other in reversed(quarters[:index]):
        then = _day(other.get('period_end'))
        if then and abs((end - then).days - 365) <= 20:
            return other
    return None


def _quarters_behind(latest_end, session):
    """Whole quarters between the latest reported quarter and the one that should be out by now."""
    expected = session - timedelta(days=RESULTS_LAG_DAYS)
    months = (expected.year - latest_end.year) * 12 + expected.month - latest_end.month
    return max(0, months // 3)


def quarter_facts(history, session):
    """The last QUARTERS quarters' year-on-year facts, or None without enough dated quarters."""
    history = history or {}
    standalone = bool(history.get('standalone_quarterly'))
    source = history['standalone_quarterly'] if standalone else history.get('quarterly') or []
    rows = sorted((row for row in source if _day(row.get('period_end'))), key=lambda row: row['period_end'])
    if len(rows) < 5:
        return None
    facts, tax_credit = [], False
    for index in range(max(4, len(rows) - QUARTERS), len(rows)):
        now, then = rows[index], _year_ago(rows, index)
        if then is None:
            continue
        sales, sales0 = (_number(now.get('sales')) or _number(now.get('revenue'))), (_number(then.get('sales')) or _number(then.get('revenue')))
        pat, pat0 = _number(now.get('net_profit')), _number(then.get('net_profit'))
        eps, eps0 = _number(now.get('eps')), _number(then.get('eps'))
        tax = _number(now.get('tax_expenses'))
        # Net profit / EPS is the share count; a drift means EPS was not restated for a split, bonus or issue.
        shares, shares0 = (pat / eps if pat and eps else None), (pat0 / eps0 if pat0 and eps0 else None)
        comparable = shares and shares0 and shares > 0 and shares0 > 0 and abs(shares / shares0 - 1) <= SHARE_DRIFT
        facts.append({
            'end': now['period_end'][:10],
            'sales': _growth(sales, sales0), 'eps': _growth(eps, eps0) if comparable else _growth(pat, pat0),
            'pat': _growth(pat, pat0), 'npm': round(pat / sales * 100, 1) if pat is not None and sales else None,
            'np': round(pat, 1) if pat is not None else None, 'np0': round(pat0, 1) if pat0 is not None else None, 'eps0': eps0 if comparable else None, 'epsBasis': 'EPS' if comparable else 'PAT',
        })
        if index >= len(rows) - 3 and pat and pat > 0 and tax is not None and -tax >= TAX_CREDIT_SHARE * pat:
            tax_credit = True
    if not facts:
        return None
    return {'q': facts, 'behind': _quarters_behind(_day(facts[-1]['end']), session), 'taxCredit': tax_credit,
            'basis': 'STANDALONE' if standalone else history.get('report_type') or 'CONSOLIDATED'}


def pulse_dates(pulse, session):
    """Per symbol from Earnings Pulse rows: the latest filing day and the next scheduled one, each with its timing."""
    dates = {}
    for row in (pulse or {}).get('reported') or []:
        symbol, day = row.get('symbol'), str(row.get('filing_day') or '')[:10]
        if symbol and len(day) == 10 and day <= session and day > dates.get(symbol, {}).get('declared', ''):
            dates.setdefault(symbol, {}).update(declared=day, declaredTiming=row.get('timing') if row.get('timing') in TIMINGS else None)
    for row in (pulse or {}).get('upcoming') or []:
        symbol, day = row.get('symbol'), str(row.get('filing_day') or '')[:10]
        entry = dates.setdefault(symbol, {}) if symbol and len(day) == 10 and day >= session else None
        if entry is not None and day < entry.get('next', '9999'):
            entry.update(next=day, nextTiming=row.get('timing') if row.get('timing') in TIMINGS else None)
    return dates


def merge_results_dates(stocks, pulse):
    """Each stock's `latest_earnings_date` becomes the later of its own and Earnings Pulse's filing day, so Days Since
    Earnings, the presets on it and the Earnings scans all count from one date. The date its published growth figures
    were announced on stays in `statement_earnings_date`: the Earnings Growth rule ages those figures by it."""
    for symbol, stock in stocks.items():
        declared = (pulse.get(symbol) or {}).get('declared')
        if declared and declared > str(stock.get('latest_earnings_date') or '')[:10]:
            stock['statement_earnings_date'] = stock.get('latest_earnings_date')
            stock['latest_earnings_date'] = declared


def reaction(frame, declared, timing=None):
    """The sessions that could react to results declared on `declared`: each one's gap, move and range position, and
    how far its gap is still unfilled by every low since.

    With a known `timing` that is one session, as on the Earnings page: the filing day's own (or the next one, off a
    non-trading day) before or during market hours, the next session after hours. Unknown, both are kept."""
    day = _day(declared)
    if day is None or frame is None or frame.empty:
        return None
    dates = frame['Date'].dt.date.tolist()
    first = next((i for i, value in enumerate(dates) if (value > day if timing == 'After' else value >= day)), None)
    if first is None or first == 0:
        return None
    opens, highs, lows = frame['Open'].tolist(), frame['High'].tolist(), frame['Low'].tolist()
    closes = frame['Close'].tolist()
    events = []
    for index in (first,) if timing in TIMINGS else (first, first + 1):
        if index >= len(dates):
            break
        before = closes[index - 1]
        if not before or before <= 0:
            continue
        span = highs[index] - lows[index]
        events.append({
            'date': dates[index].isoformat(), 'age': len(dates) - 1 - index,
            'gap': round((opens[index] / before - 1) * 100, 2), 'move': round((closes[index] / before - 1) * 100, 2),
            'pos': round((closes[index] - lows[index]) / span, 3) if span > 0 else None,
            'vsOpen': round((closes[index] / opens[index] - 1) * 100, 2) if opens[index] else None,
            # Above zero: no low since the gap session has traded back to the close before it.
            'unfilled': round((min(lows[index:]) / before - 1) * 100, 2),
        })
    return events or None


def earnings_signals(stock, frame, session, next_results=None, pulse=None):
    """The row's `earnings` object, or None when the stock has no quarterly results and no results date."""
    pulse = pulse or {}
    facts = quarter_facts(stock.get('financial_statement_history'), _day(session))
    # merge_results_dates has already folded Earnings Pulse's filing day into the stock's own.
    declared = str(stock.get('latest_earnings_date') or '')[:10] or None
    events = reaction(frame, declared, pulse.get('declaredTiming') if declared == pulse.get('declared') else None)
    upcoming = next_results or pulse.get('next')
    if facts is None and declared is None and upcoming is None:
        return None
    age = None
    if declared and frame is not None and not frame.empty:
        age = int((frame['Date'].dt.date >= _day(declared)).sum()) - 1 if _day(declared) <= frame['Date'].iloc[-1].date() else None
    facts = dict(facts or {})
    if facts.get('q'):
        # Profit growth and the year-ago base are read for the latest quarter only; earlier ones send null.
        latest_only, last = ('pat', 'np0', 'eps0'), len(facts['q']) - 1
        facts['q'] = [[(1 if quarter['epsBasis'] == 'EPS' else 0) if field == 'epsBasis'
                       else None if field in latest_only and index < last else quarter[field]
                       for field in QUARTER_FIELDS] for index, quarter in enumerate(facts['q'])]
    return {'asOf': session, **facts, 'declared': declared, 'declaredAge': age,
            'reaction': [[event[field] for field in REACTION_FIELDS] for event in events] if events else None,
            'next': upcoming, 'nextTiming': pulse.get('nextTiming') if upcoming and upcoming == pulse.get('next') else None}


def next_results(calendar_bytes, session):
    """Each symbol's next scheduled results date on or after `session`, from the market's earnings_calendar.json.gz."""
    if calendar_bytes is None:
        return {}
    try:
        events = json.loads(gzip.decompress(calendar_bytes)).get('events') or []
    except (OSError, ValueError, AttributeError):
        return {}
    upcoming = {}
    for event in events:
        day = str(event.get('scheduled_date') or '')[:10]
        if event.get('symbol') and day >= session and day < upcoming.get(event['symbol'], '9999'):
            upcoming[event['symbol']] = day
    return upcoming
