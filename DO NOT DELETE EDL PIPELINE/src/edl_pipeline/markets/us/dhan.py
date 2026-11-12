"""Dhan's US data: the universe and daily snapshot, daily history, and each stock's page.

Dhan lists US stocks and ETFs under its own exchange code `INX`, with the real listing exchange (NASDAQ, NYSE,
NYSE ARCA) in `Cust_Exch`. Three services carry them:

- the global screener (scanx-global-analytics), the same request shape as the Indian one: every stock or ETF with
  prices, 1W-5Y returns and highs, valuation and growth, in one page;
- the INX ticks service: split-adjusted daily OHLCV from March 2021, which wants the listing exchange (not `INX`) and
  stamps each bar at midnight IST of its US session date;
- each stock's page data (dhan.co/_next/data/<build>/us-stocks/<slug>.json): ten years of statements, ten quarters,
  ratios, analyst ratings, corporate actions and USD/INR. The build id changes with each deploy of dhan.co.
"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

import requests

from pipeline_utils import get_headers

SCREENER_URL = 'https://scanx-global-analytics.dhan.co/customscan/fetchdt'
HISTORY_URL = 'https://openweb-ticks-inx.dhan.co/getDataH'
SITE = 'https://dhan.co'
DHAN_EXCHANGE = 'INX'
KINDS = {'stock': 'ES', 'etf': 'ETF'}
# One page holds the whole US list today (6,436 stocks); paging follows tot_pg should Dhan cap it.
PAGE_SIZE = 10_000
# Bars are stamped at midnight IST of the session date: 2026-11-06's bar is 2026-11-05T18:30:00Z.
_STAMP_OFFSET = timedelta(hours=5, minutes=30)
_BUILD_ID = re.compile(r'"buildId":"([^"]+)"')

Post = Callable[[str, dict], dict]


class Throttled(RuntimeError):
    """Dhan refused with 403 or 429: stop and leave the rest for the next run."""


class Pacer:
    """At most one request per `interval` seconds, across threads."""

    def __init__(self, interval: float):
        self.interval = interval
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self):
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next - now)
            self._next = max(now, self._next) + self.interval
        if delay:
            time.sleep(delay)


def _headers():
    headers = get_headers()
    headers.update({'Origin': SITE, 'Referer': f'{SITE}/'})
    return headers


def _checked(response):
    if response.status_code in (403, 429):
        raise Throttled(f'Dhan answered {response.status_code} for {response.url}')
    response.raise_for_status()
    return response


def post(url: str, payload: dict, timeout: float = 60) -> dict:
    return _checked(requests.post(url, json=payload, headers=_headers(), timeout=timeout)).json()


def get_text(url: str, timeout: float = 30) -> str:
    return _checked(requests.get(url, headers=_headers(), timeout=timeout)).text


def fetch_universe(kind: str = 'stock', fields: list[str] | None = None, *, post: Post = post,
                   page_size: int = PAGE_SIZE) -> list[dict]:
    """Every US stock (or ETF) Dhan lists, largest first, with the requested screener fields."""
    from .fields import SNAPSHOT_FIELDS
    rows, page, pages = [], 1, 1
    while page <= pages:
        response = post(SCREENER_URL, {'data': {
            'sort': 'Mcap', 'sorder': 'desc', 'count': page_size, 'pgno': page, 'fields': fields or SNAPSHOT_FIELDS,
            'params': [{'field': 'Exch', 'op': '', 'val': DHAN_EXCHANGE}, {'field': 'OgInst', 'op': '', 'val': KINDS[kind]}],
        }})
        if response.get('code') not in (0, None):
            raise ValueError(f"Dhan's US screener refused the {kind} list: {response.get('remarks')!r}")
        rows.extend(response.get('data') or [])
        pages = int(response.get('tot_pg') or 1)
        page += 1
    return rows


def session_date(stamp: float) -> str:
    """A history bar's US session date from Dhan's midnight-IST timestamp."""
    return (datetime.fromtimestamp(stamp, timezone.utc) + _STAMP_OFFSET).date().isoformat()


def fetch_history(symbol: str, security_id: int, listing_exchange: str, start: datetime, end: datetime, *,
                  post: Post = post) -> list[dict]:
    """Daily split-adjusted bars for one stock between `start` and `end`, oldest first."""
    response = post(HISTORY_URL, {
        'EXCH': listing_exchange, 'SYM': symbol, 'SEG': 'E', 'INST': 'EQUITY', 'SEC_ID': int(security_id),
        'EXPCODE': 0, 'INTERVAL': 'D', 'START': int(start.timestamp()), 'END': int(end.timestamp()),
    })
    data = response.get('data') or {}
    stamps = data.get('t') or []
    columns = [data.get(key) or [] for key in ('o', 'h', 'l', 'c', 'v')]
    bars = []
    for index, stamp in enumerate(stamps):
        values = [column[index] if index < len(column) else None for column in columns]
        if None in values[:4]:
            continue
        bars.append({'date': session_date(stamp), 'open': values[0], 'high': values[1], 'low': values[2],
                     'close': values[3], 'volume': values[4]})
    return bars


class StockPages:
    """Each stock's page data, re-reading dhan.co's build id once when a deploy has replaced it.

    Shared by the page-fetch workers: the build id is read under a lock, and a 404 is judged against the build id
    that request used, so another worker's refresh is never mistaken for a missing page on the same deploy.
    """

    def __init__(self, get: Callable[[str], str] = get_text, fetch_json: Callable[[str], dict] | None = None,
                 pace: Callable[[], None] = lambda: None):
        # `pace` runs before every request (a page can take three: the data, a fresh build id, the data again).
        self._get = lambda url: (pace(), get(url))[1]
        fetch_json = fetch_json or (lambda url: _checked(requests.get(url, headers=_headers(), timeout=30)).json())
        self._fetch_json = lambda url: (pace(), fetch_json(url))[1]
        self._build = None
        self._lock = threading.Lock()

    def build_id(self, refresh: bool = False, stale: str | None = None) -> str:
        """The current build id; with `refresh`, read again unless another worker already replaced `stale`."""
        with self._lock:
            if self._build is None or (refresh and (stale is None or self._build == stale)):
                match = _BUILD_ID.search(self._get(f'{SITE}/us-stocks/'))
                if not match:
                    raise ValueError("dhan.co's page did not carry a build id")
                self._build = match.group(1)
            return self._build

    def _page(self, build: str, slug: str) -> dict:
        return self._fetch_json(f'{SITE}/_next/data/{build}/us-stocks/{slug}-share-price.json').get('pageProps') or {}

    def fetch(self, slug: str) -> dict:
        """The page props for `slug` (the screener's `Seosym`, e.g. 'AAPL-apple-inc')."""
        build = self.build_id()
        try:
            return self._page(build, slug)
        except requests.HTTPError as error:
            if error.response is None or error.response.status_code != 404:
                raise
            missed = error
        fresh = self.build_id(refresh=True, stale=build)
        if fresh == build:
            raise missed  # the same deploy: the page does not exist, so the data is not asked for twice
        return self._page(fresh, slug)
