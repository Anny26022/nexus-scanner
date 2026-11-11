"""Yahoo Finance historical daily price provider for US stocks and ETFs.

Supplies deep split-adjusted daily OHLCV (back to 1980 / IPO) as the long-history baseline for US screening,
mirroring India's EOD2 repository. When a ticker is missing or Yahoo is unreachable, callers fall back to Dhan's
INX ticks service (2021 onwards).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

import requests

API_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
HEADERS = {'User-Agent': 'Mozilla/5.0'}


def yahoo_symbol(symbol: str) -> str:
    """Map US share classes with dots (e.g. BRK.B, BF.B) to Yahoo's hyphen convention (BRK-B, BF-B)."""
    return symbol.strip().upper().replace('.', '-')


def fetch_history(symbol: str, start: datetime | None = None, end: datetime | None = None, *,
                  get: Callable[..., requests.Response] = requests.get, timeout: float = 15) -> list[dict]:
    """Daily split-adjusted bars for `symbol`, oldest first; returns empty list on 404 or network failure."""
    ysym = yahoo_symbol(symbol)
    period1 = int(start.timestamp()) if start else 0
    period2 = int(end.timestamp()) if end else 9999999999
    url = API_URL.format(symbol=ysym)
    params = {'period1': period1, 'period2': period2, 'interval': '1d'}

    try:
        response = get(url, params=params, headers=HEADERS, timeout=timeout)
        if response.status_code != 200:
            return []
        data = response.json()
    except (requests.RequestException, ValueError, TypeError, KeyError):
        return []

    result = (data.get('chart') or {}).get('result')
    if not isinstance(result, list) or not result:
        return []

    chart = result[0]
    timestamps = chart.get('timestamp') or []
    indicators = chart.get('indicators') or {}
    quotes = indicators.get('quote') or []
    if not quotes or not isinstance(quotes[0], dict):
        return []

    quote = quotes[0]
    opens = quote.get('open') or []
    highs = quote.get('high') or []
    lows = quote.get('low') or []
    closes = quote.get('close') or []
    volumes = quote.get('volume') or []

    length = len(timestamps)
    bars = []
    for i in range(length):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        v = volumes[i] if i < len(volumes) else None
        if None in (o, h, l, c):
            continue
        # Unix timestamp to session date string (YYYY-MM-DD)
        dt = datetime.fromtimestamp(timestamps[i], timezone.utc).date().isoformat()
        bars.append({
            'date': dt,
            'open': float(o),
            'high': float(h),
            'low': float(l),
            'close': float(c),
            'volume': float(v or 0),
        })
    return bars
