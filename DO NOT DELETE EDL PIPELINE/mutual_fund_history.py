"""Daily NAV history for the mutual fund snapshot, and the risk metrics computed from it.

The history is one file kept in private R2 storage between runs (frontend/publish_mutual_funds.py moves it):

    {"schemaVersion": 1, "funds": {"<ISIN>": {"code": "<Dhan scheme code>", "start": "YYYY-MM-DD",
                                              "gaps": [0, 1, 3, ...], "nav": [10.0, 10.02, ...]}}}

`gaps[i]` is the number of days from point i-1 to point i (0 for the first), which keeps the file small.

Each day the snapshot's NAV (AMFI's where available) is appended. A fund that is new, or whose history stops more
than `MAX_APPEND_GAP_DAYS` before the new NAV (a missed run, a long holiday), is refetched from Dhan's NAV chart,
which goes back to the fund's launch. Dhan's chart and AMFI quote the same NAVs (checked when this was written).

Dhan answers 403 for a few minutes after a burst (about 1,800 requests in a minute did it), so chart requests are
paced, at most `CHART_LIMIT` funds are refilled per run, and the first 403/429 defers the rest to the next run.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import math
import threading
import time

import numpy as np
import requests

from pipeline_utils import get_headers, http_session

CHART_URL = 'https://mf-openweb-search.dhan.co/chart'
SCHEMA_VERSION = 1
# Friday to Monday is 3 days, plus a holiday; anything longer may have skipped NAVs, so the chart refills it.
MAX_APPEND_GAP_DAYS = 4
# A NAV this far from the previous one is a data error, not a fund move (even a segregated portfolio is announced).
MAX_DAILY_MOVE = 0.5
CHART_WORKERS = 3
# Seconds between chart request starts, across workers: about 3 a second. The first backfill takes ~10 minutes.
CHART_INTERVAL = 0.35
# Funds refilled per run; a full rebuild (about 1,850 funds) spreads over two days.
CHART_LIMIT = 1000
RISK_FREE_RATE = 0.065  # Dhan's own comparison rate (dmfm_fd_returns), as a fraction a year
TRADING_DAYS = 252
DAYS_PER_YEAR = 365.25


# --- the stored series -----------------------------------------------------------------------------------------

def decode(entry):
    """(dates as day numbers, NAVs) of one stored fund."""
    start = date.fromisoformat(entry['start']).toordinal()
    return np.cumsum(np.asarray(entry['gaps'], dtype=np.int64)) + start, np.asarray(entry['nav'], dtype=float)


def encode(code, days, navs):
    days = np.asarray(days, dtype=np.int64)
    gaps = np.diff(days, prepend=days[0]).tolist()
    return {'code': code, 'start': date.fromordinal(int(days[0])).isoformat(), 'gaps': gaps,
            'nav': [round(float(nav), 6) for nav in navs]}


def after_last_jump(days, navs):
    """The series after its last day-to-day move over `MAX_DAILY_MOVE`: such a move is a re-based NAV (a face-value
    change; e.g. some liquid and overnight funds in Dhan's chart), so earlier points are on another scale."""
    if len(navs) < 2:
        return days, navs, False
    ratios = np.asarray(navs[1:], dtype=float) / np.asarray(navs[:-1], dtype=float)
    jumps = np.nonzero(np.abs(ratios - 1) > MAX_DAILY_MOVE)[0]
    if not len(jumps):
        return days, navs, False
    start = int(jumps[-1]) + 1
    return days[start:], navs[start:], True


def last_date(entry):
    return date.fromordinal(int(decode(entry)[0][-1]))


def clean_series(dates, navs):
    """Sorted unique (day, NAV) points with positive finite NAVs."""
    points = {}
    for day, nav in zip(dates, navs):
        try:
            ordinal = date.fromisoformat(str(day)[:10]).toordinal()
            value = float(nav)
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value > 0:
            points[ordinal] = value
    days = sorted(points)
    return days, [points[day] for day in days]


# --- Dhan's NAV chart ------------------------------------------------------------------------------------------

class Throttled(Exception):
    """Dhan refused a request for rate (403/429): stop asking until the next run."""


class Pacer:
    """Spaces request starts across threads."""
    def __init__(self, interval):
        self.interval, self.next, self.lock = interval, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next)
            self.next = start + self.interval
        if start > now:
            time.sleep(start - now)


def fetch_chart(code, since='2000-01-01', until=None):
    """Dhan's daily NAVs for one fund (its `dmfm_cmots_scheme_code`), launch to today by default."""
    headers = dict(get_headers(), Origin='https://dhan.co', Referer='https://dhan.co/')
    body = {'entity_id': 'Openweb', 'source': 'W', 'aes_key': '', 'ip': '',
            'data': {'client_id': '', 'sCode': str(code), 'period': '', 'start_date': since,
                     'end_date': until or (date.today() + timedelta(days=1)).isoformat()}}
    for attempt in range(2):
        try:
            response = http_session().post(CHART_URL, json=body, headers=headers, timeout=60)
        except (requests.ConnectionError, requests.Timeout):
            if attempt:
                raise
            time.sleep(2)
            continue
        if response.status_code in (403, 429):
            raise Throttled(f'Dhan answered {response.status_code}')
        if response.status_code >= 500 and not attempt:
            time.sleep(2)
            continue
        break
    response.raise_for_status()
    data = (response.json() or {}).get('data') or []
    series = data[0] if data and isinstance(data[0], dict) else {}
    return clean_series(series.get('d') or [], series.get('n') or [])


# --- daily update ----------------------------------------------------------------------------------------------

def update_history(history, funds, fetch=fetch_chart, workers=CHART_WORKERS, interval=CHART_INTERVAL, limit=CHART_LIMIT):
    """Add today's snapshot NAVs to `history` (changed in place); refetch new funds and gaps from Dhan's chart.

    Returns counts for the run report. Funds that leave the universe keep their history: they may come back.
    """
    stored = history.setdefault('funds', {})
    history['schemaVersion'] = SCHEMA_VERSION
    appended, refetch, rejected = 0, [], []
    for fund in funds:
        isin, code, nav = fund['isin'], fund.get('dhanSchemeCode'), fund.get('nav')
        if not nav or not fund.get('navDate'):
            continue
        new_day = date.fromisoformat(fund['navDate']).toordinal()
        entry = stored.get(isin)
        if entry is None:
            refetch.append(fund)
            continue
        days, navs = decode(entry)
        if new_day <= days[-1]:
            continue  # already stored (a re-run, or AMFI not yet past the stored day)
        if new_day - days[-1] > MAX_APPEND_GAP_DAYS:
            refetch.append(fund)
            continue
        if abs(nav / navs[-1] - 1) > MAX_DAILY_MOVE:
            rejected.append(isin)
            continue
        stored[isin] = encode(code or entry.get('code'), np.append(days, new_day), np.append(navs, nav))
        appended += 1

    pacer, throttled = Pacer(interval), threading.Event()

    def refill(fund):
        if throttled.is_set():
            return fund, None, Throttled('deferred')
        pacer.wait()
        try:
            return fund, fetch(fund['dhanSchemeCode']), None
        except Throttled as error:
            throttled.set()
            return fund, None, error
        except Exception as error:  # one fund's chart must not stop the others
            return fund, None, error

    # Largest funds first: when the run is capped or throttled, they get their history soonest.
    queue = sorted((fund for fund in refetch if fund.get('dhanSchemeCode')), key=lambda fund: -(fund.get('aumCrore') or 0))
    deferred = max(0, len(queue) - limit)
    refetched, rebased, failed = 0, 0, []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for fund, series, error in pool.map(refill, queue[:limit]):
            if isinstance(error, Throttled):
                deferred += 1
                continue
            if error is not None or not series or not series[0]:
                failed.append(fund['isin'])
                continue
            days, navs = list(series[0]), list(series[1])
            # The snapshot's NAV (AMFI's) is the newest word for its day.
            new_day = date.fromisoformat(fund['navDate']).toordinal()
            if new_day >= days[-1]:
                if new_day == days[-1]:
                    days, navs = days[:-1], navs[:-1]
                days.append(new_day)
                navs.append(fund['nav'])
            # Checked with today's NAV included, so a chart on another scale than AMFI's NAV restarts at today.
            days, navs, cut = after_last_jump(days, navs)
            rebased += cut
            stored[fund['isin']] = encode(fund['dhanSchemeCode'], days, navs)
            refetched += 1
    if throttled.is_set():
        print(f'Dhan rate-limited the NAV chart; {deferred} fund(s) wait for the next run', flush=True)
    return {'appended': appended, 'refetched': refetched, 'refetchFailed': len(failed), 'refetchDeferred': deferred,
            'throttled': throttled.is_set(), 'rebased': rebased, 'rejectedMoves': len(rejected), 'stored': len(stored)}


# --- metrics ---------------------------------------------------------------------------------------------------

def pct(value):
    return None if value is None or not math.isfinite(value) else round(value * 100, 4)


def value_on_or_before(days, navs, day):
    index = np.searchsorted(days, day, side='right') - 1
    return (int(days[index]), float(navs[index])) if index >= 0 else None


def months_before(day, months):
    """The same calendar day `months` earlier, clamped to the month's end (31 Mar - 1 month = 28/29 Feb)."""
    total = day.year * 12 + day.month - 1 - months
    year, month = divmod(total, 12)
    for clamp in range(4):
        try:
            return date(year, month + 1, day.day - clamp)
        except ValueError:
            continue
    raise ValueError(day)


def trailing_return(days, navs, months=0, weeks=0):
    """Return to the latest NAV from the same calendar day `months`/`weeks` earlier, using the NAV on or before
    that day, annualised beyond a year. Dhan's convention: it reproduces Dhan's figures exactly."""
    end = date.fromordinal(int(days[-1]))
    target = (months_before(end, months) if months else end - timedelta(weeks=weeks)).toordinal()
    start = value_on_or_before(days, navs, target)
    if not start or target - start[0] > 7:
        return None  # history starts after the target day, or has a hole there
    growth = float(navs[-1]) / start[1]
    return growth ** (12 / months) - 1 if months > 12 else growth - 1


TRAILING = {'1w': {'weeks': 1}, '1m': {'months': 1}, '3m': {'months': 3}, '6m': {'months': 6}, '1y': {'months': 12},
            '3y': {'months': 36}, '5y': {'months': 60}, '10y': {'months': 120}}


def cagr(days, navs, years):
    """Annualised return over the last `years` (None when the history is shorter)."""
    return trailing_return(days, navs, months=12 * years)


def window(days, navs, years):
    keep = days >= days[-1] - round(years * DAYS_PER_YEAR)
    if days[keep][0] > days[-1] - round(years * DAYS_PER_YEAR) + 7:
        return None  # history does not reach back that far
    return days[keep], navs[keep]


def volatility(navs):
    returns = np.diff(np.log(navs))
    return float(np.std(returns, ddof=1) * math.sqrt(TRADING_DAYS)) if len(returns) > 20 else None


def downside_deviation(navs):
    returns = np.diff(np.log(navs))
    return float(math.sqrt(np.mean(np.minimum(returns, 0) ** 2)) * math.sqrt(TRADING_DAYS)) if len(returns) > 20 else None


def max_drawdown(navs):
    peaks = np.maximum.accumulate(navs)
    return float(np.min(navs / peaks - 1))


def rolling(days, navs, years, since_day=None):
    """Returns over every `years`-long holding period ending on a stored day (annualised beyond one year)."""
    span = round(years * DAYS_PER_YEAR)
    ends = np.arange(len(days)) if since_day is None else np.nonzero(days >= since_day)[0]
    starts = np.searchsorted(days, days[ends] - span, side='right') - 1
    valid = (starts >= 0) & (days[ends] - days[np.maximum(starts, 0)] >= span - 7)
    if not valid.any():
        return None
    ends, starts = ends[valid], starts[valid]
    growth = navs[ends] / navs[starts]
    held = (days[ends] - days[starts]) / DAYS_PER_YEAR
    values = growth ** (1 / held) - 1 if years > 1 else growth - 1
    return {'min': pct(float(values.min())), 'max': pct(float(values.max())), 'avg': pct(float(values.mean())),
            'positivePct': round(float((values > 0).mean()) * 100, 2), 'periods': int(len(values))}


def fund_metrics(entry):
    """Risk and return metrics from one fund's stored NAVs, all as percentages (Sharpe and Sortino as ratios)."""
    days, navs = decode(entry)
    if len(days) < 2:
        return None
    launch_years = (days[-1] - days[0]) / DAYS_PER_YEAR
    metrics = {
        'historyStart': date.fromordinal(int(days[0])).isoformat(),
        'historyEnd': date.fromordinal(int(days[-1])).isoformat(),
        'navPoints': int(len(days)),
        'returns': {period: pct(trailing_return(days, navs, **span)) for period, span in TRAILING.items()},
        'cagrSinceLaunch': pct((navs[-1] / navs[0]) ** (1 / launch_years) - 1) if launch_years >= 1 else None,
        'maxDrawdown': pct(max_drawdown(navs)),
        'currentDrawdown': pct(float(navs[-1] / navs.max() - 1)),
    }
    for years in (1, 3, 5):
        span = window(days, navs, years)
        metrics[f'volatility{years}y'] = pct(volatility(span[1])) if span else None
    three = window(days, navs, 3)
    growth3 = cagr(days, navs, 3)
    if three and growth3 is not None:
        vol, downside = volatility(three[1]), downside_deviation(three[1])
        metrics['maxDrawdown3y'] = pct(max_drawdown(three[1]))
        metrics['sharpe3y'] = round((growth3 - RISK_FREE_RATE) / vol, 3) if vol else None
        metrics['sortino3y'] = round((growth3 - RISK_FREE_RATE) / downside, 3) if downside else None
    else:
        metrics.update(maxDrawdown3y=None, sharpe3y=None, sortino3y=None)
    metrics['rolling1y5y'] = rolling(days, navs, 1, since_day=days[-1] - round(5 * DAYS_PER_YEAR))
    metrics['rolling3y'] = rolling(days, navs, 3)
    metrics['rolling5y'] = rolling(days, navs, 5)
    return metrics


def nav_series(isin, entry):
    """A fund's published NAV chart: the stored form, which the site decodes the same way."""
    return {'isin': isin, 'start': entry['start'], 'gaps': entry['gaps'], 'nav': entry['nav']}
