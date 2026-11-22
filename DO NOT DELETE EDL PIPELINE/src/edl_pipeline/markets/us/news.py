"""US company news from Dhan, in India's `market_news/<symbol>_news.json` files (fetch_market_news.py).

India's endpoint (news-live.dhan.co/v2/news/getLiveNews) returns nothing for US ISINs. Dhan's US stock pages read
theirs from `news/getarticlebyisin` (found in the page's own script, 2026-11-22): one POST per stock with its ISIN.
On 400 stocks it had news for 91-95% of the 3,000 largest and 70% of the rest, the newest a few days old. It carries
no sentiment, so none is written. build_chart_artifacts publishes the files as each chart's market news, as for India.
"""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import requests

from . import dhan

API_URL = 'https://news-live.dhan.co/news/getarticlebyisin'
ARTICLE_URL = 'https://scanx.trade/stock-market-news'
COUNT = 50  # as India's NEWS_LIMIT
DIRECTORY = 'market_news'


def fetch(isin: str, *, post=requests.post, timeout: float = 15) -> list[dict]:
    """The stock's latest articles, newest first. Raises dhan.Throttled on 403/429, and on any other failure."""
    response = post(API_URL, json={'isin': isin, 'count': COUNT},
                    headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}, timeout=timeout)
    if response.status_code in (403, 429):
        raise dhan.Throttled(f'Dhan news answered {response.status_code}')
    response.raise_for_status()
    data = response.json().get('data') or {}
    return data.get('latest') or data.get('next') or []


def _published(stamp) -> int | None:
    """An article's ISO publish time as epoch milliseconds, the form India's files hold."""
    try:
        return int(datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return None


def rows(articles: list[dict]) -> list[dict]:
    """India's news rows (fetch_market_news.py), with each article's link."""
    result = []
    for article in articles:
        if not isinstance(article, dict) or not article.get('articletitle'):
            continue
        link = (f"{ARTICLE_URL}/{article['category']}/{article['slug']}/{article['id']}"
                if article.get('category') and article.get('slug') and article.get('id') is not None else None)
        result.append({'Title': article['articletitle'], 'Summary': article.get('summary') or '',
                       'PublishDate': _published(article.get('pubdate')), 'Source': article.get('category') or '',
                       'Url': link})
    return result


def refresh(records: list[dict], root: Path, *, interval: float = 0.1, workers: int = 4, budget_seconds: float = 900,
            post=requests.post) -> dict:
    """Write each stock's news file; paced, stopping at the first rate limit or the time budget. Returns counts.

    A stock whose request fails gets no new file this run."""
    directory = root / DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    pacer, stopped, lock = dhan.Pacer(interval), threading.Event(), threading.Lock()
    deadline = time.monotonic() + budget_seconds
    counts = {'with_news': 0, 'empty': 0, 'failed': 0, 'skipped': 0}

    def one(record):
        status = 'skipped'
        if record.get('isin') and not stopped.is_set():
            pacer.wait()
            if stopped.is_set() or time.monotonic() > deadline:
                status = 'skipped'
            else:
                try:
                    found = rows(fetch(record['isin'], post=post))
                    path = directory / f"{record['symbol']}_news.json"
                    temporary = path.with_suffix('.tmp')
                    temporary.write_text(json.dumps({'Symbol': record['symbol'], 'ISIN': record['isin'], 'News': found}))
                    temporary.replace(path)
                    status = 'with_news' if found else 'empty'
                except dhan.Throttled:
                    stopped.set()
                    status = 'failed'
                except Exception:  # one stock's news must not stop the rest
                    status = 'failed'
        with lock:
            counts[status] += 1

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, records))
    return {**counts, 'throttled': stopped.is_set()}
