"""Finviz thematic taxonomy, news, and insider activity provider for the US market.

Provides deep niche and thematic classification (40 high-level themes, 268 sub-themes/niches)
to power US Thematic Rotation (mirroring India's Theme Tracker), along with live news headlines
and SEC Form 4 insider trading activity.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import requests

BASE_URL = "https://finviz.com"
SCREENER_URL = f"{BASE_URL}/screener/stocks"
QUOTE_URL = f"{BASE_URL}/quote.ashx"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
DEFAULT_FILE = "us_thematic_universe.json"
DEFAULT_OWNERSHIP_FILE = "us_ownership_universe.json"
# A refreshed universe smaller than this share of the committed one is treated as a partial crawl and not saved.
MIN_COVERAGE_RATIO = 0.8
# Typos in Finviz's own labels, corrected so every weekly refresh keeps them fixed.
LABEL_CORRECTIONS = {'Pheriperals': 'Peripherals'}


class FinvizFetchError(RuntimeError):
    """A Finviz request failed or returned incomplete data; the crawl stops instead of saving partial results."""


def normalize_label(label) -> str:
    """Finviz's label with its spacing tidied ('Quantum  - Applications') and known typos corrected."""
    text = ' '.join(str(label or '').split())
    for wrong, right in LABEL_CORRECTIONS.items():
        text = text.replace(wrong, right)
    return text


def canonical_symbol(ticker: str) -> str:
    """Finviz's ticker in the pipeline's (Dhan's) convention: share classes take a dot (BRK-B -> BRK.B)."""
    return ticker.strip().upper().replace('-', '.')


def check_coverage(new: dict, previous: dict, name: str, ratio: float = MIN_COVERAGE_RATIO):
    """Raise unless the refreshed universe is non-empty and not much smaller than the committed one."""
    if not new:
        raise FinvizFetchError(f"{name}: crawl returned no stocks; keeping the committed file")
    if previous and len(new) < ratio * len(previous):
        raise FinvizFetchError(f"{name}: crawl mapped {len(new)} stocks, under {ratio:.0%} of the committed "
                               f"{len(previous)}; keeping the committed file")


def load_thematic_universe(path: Path) -> dict[str, dict]:
    """Load cached thematic universe mapping from JSON."""
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {}


def save_thematic_universe(path: Path, data: dict):
    """Save thematic universe mapping atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
    temp.replace(path)


def load_ownership_universe(path: Path) -> dict[str, dict]:
    """Load cached ownership & short interest mapping from JSON."""
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {}


def save_ownership_universe(path: Path, data: dict):
    """Save ownership universe mapping atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
    temp.replace(path)


def _extract_screener_json(html: str) -> dict | None:
    """Extract embedded SSR screener JSON from Finviz HTML."""
    scripts = re.findall(r'<script[^>]*>([^<]+)</script>', html)
    for s in scripts:
        if '"screenerType"' in s and 'filters' in s:
            start = s.find('{')
            end = s.rfind('}')
            if start != -1 and end != -1:
                try:
                    return json.loads(s[start:end + 1])
                except (json.JSONDecodeError, ValueError):
                    pass
    return None


def fetch_theme_catalog(session: requests.Session | None = None) -> tuple[list[dict], list[dict]]:
    """Discover available theme and subtheme options from Finviz screener metadata."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    try:
        resp = sess.get(SCREENER_URL, timeout=15)
        if resp.status_code != 200:
            return [], []
        data = _extract_screener_json(resp.text)
        if not data or 'filters' not in data:
            return [], []
        filters = {f['key']: f for f in data['filters'].get('filters', [])}
        
        themes = [
            {'value': opt['value'], 'label': normalize_label(opt['label'])}
            for opt in filters.get('theme', {}).get('options', [])
            if opt.get('value') and not opt.get('isEliteOnly')
        ]
        subthemes = [
            {'value': opt['value'], 'label': normalize_label(opt['label']), 'group': opt.get('group')}
            for opt in filters.get('subtheme', {}).get('options', [])
            if opt.get('value') and not opt.get('isEliteOnly')
        ]
        return themes, subthemes
    except (requests.RequestException, ValueError, KeyError):
        return [], []


def theme_catalog_payload(themes: list[dict], subthemes: list[dict]) -> dict:
    """Finviz's theme catalog: each theme with its sub-themes (labels normalized as in the thematic universe).

    The per-ticker thematic universe can't say which theme a sub-theme belongs to; consumers that lay out themes and
    sub-themes (the Theme Tracker's US map) read it from here.
    """
    by_value = {t['value']: {'value': t['value'], 'label': normalize_label(t['label']), 'subthemes': []} for t in themes}
    for sub in subthemes:
        parent = by_value.get(sub.get('group'))
        if parent:
            parent['subthemes'].append({'value': sub['value'], 'label': normalize_label(sub['label'])})
    return {'themes': list(by_value.values())}


def save_theme_catalog(path: Path, catalog: dict):
    """Save the theme catalog atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(catalog, handle, indent=2)
    temp.replace(path)


def fetch_tickers_for_filter(filter_param: str, *, session: requests.Session | None = None,
                             delay: float = 0.2) -> list[str]:
    """Fetch all tickers matching a single filter parameter (e.g. 'theme_artificialintelligence').

    Tickers are in the pipeline's convention (BRK.B). Raises FinvizFetchError when any page fails, so a crawl never
    mistakes a failed request for a filter with no stocks.
    """
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    url = f"{SCREENER_URL}?f={filter_param}"

    def page(page_url):
        try:
            resp = sess.get(page_url, timeout=15)
        except requests.RequestException as error:
            raise FinvizFetchError(f"{page_url}: {error}") from error
        if resp.status_code != 200:
            raise FinvizFetchError(f"{page_url}: HTTP {resp.status_code}")
        return resp.text

    text = page(url)
    tickers = re.findall(r'"ticker"\s*:\s*"([A-Z0-9_\.\-]+)"', text)
    tc_match = re.search(r'"totalCount"\s*:\s*([0-9]+)', text)
    if not tc_match:
        # A block page or a layout change, not a filter with no stocks: those still report "totalCount": 0.
        raise FinvizFetchError(f"{url}: no totalCount in the screener page")
    total_count = int(tc_match.group(1))

    all_tickers = list(tickers)
    # Paginate if more than 20 results
    for offset in range(21, total_count + 1, 20):
        time.sleep(delay)
        all_tickers.extend(re.findall(r'"ticker"\s*:\s*"([A-Z0-9_\.\-]+)"', page(f"{url}&r={offset}")))
    if len(set(all_tickers)) < total_count:
        raise FinvizFetchError(f"{url}: fetched {len(set(all_tickers))} of {total_count} tickers")
    return sorted({canonical_symbol(t) for t in all_tickers})


def crawl_thematic_universe(*, delay: float = 0.15, session: requests.Session | None = None,
                            log: Callable[[str], None] = print,
                            catalog: tuple[list[dict], list[dict]] | None = None) -> dict[str, dict]:
    """Crawl Finviz themes and subthemes with polite pacing (runs weekly/monthly).

    `catalog` is fetch_theme_catalog's result when the caller already has it. Raises FinvizFetchError when the catalog
    is empty or any filter's request fails, so a failed crawl never replaces the committed universe.
    """
    sess = session or requests.Session()
    sess.headers.update(HEADERS)

    themes, subthemes = catalog if catalog is not None else fetch_theme_catalog(session=sess)
    if not themes:
        raise FinvizFetchError("Finviz theme catalog is empty (request failed or page layout changed)")
    theme_by_group = {t['value']: t['label'] for t in themes}
    log(f"Discovered {len(themes)} themes and {len(subthemes)} sub-themes on Finviz.")
    
    ticker_map: dict[str, dict] = {}
    
    # 1. Themes
    for i, t in enumerate(themes):
        val, label = t['value'], t['label']
        tickers = fetch_tickers_for_filter(f"theme_{val}", session=sess, delay=delay)
        for sym in tickers:
            rec = ticker_map.setdefault(sym, {'themes': [], 'subthemes': [], 'primary_theme': label})
            if label not in rec['themes']:
                rec['themes'].append(label)
        if (i + 1) % 10 == 0 or i == len(themes) - 1:
            log(f"[{i+1}/{len(themes)}] Themes crawled: latest '{label}' ({len(tickers)} stocks)")
        time.sleep(delay)
        
    # 2. Sub-themes
    for i, st in enumerate(subthemes):
        val, label, grp = st['value'], st['label'], st.get('group')
        parent_theme = theme_by_group.get(grp)
        tickers = fetch_tickers_for_filter(f"subtheme_{val}", session=sess, delay=delay)
        for sym in tickers:
            rec = ticker_map.setdefault(sym, {'themes': [], 'subthemes': [], 'primary_theme': parent_theme})
            if label not in rec['subthemes']:
                rec['subthemes'].append(label)
            if parent_theme and parent_theme not in rec['themes']:
                rec['themes'].append(parent_theme)
        if (i + 1) % 50 == 0 or i == len(subthemes) - 1:
            log(f"[{i+1}/{len(subthemes)}] Sub-themes crawled: latest '{label}' ({len(tickers)} stocks)")
        time.sleep(delay)
        
    # Ensure every mapped stock has a primary theme
    for sym, rec in ticker_map.items():
        if not rec['primary_theme'] and rec['themes']:
            rec['primary_theme'] = rec['themes'][0]
        elif not rec['primary_theme'] and rec['subthemes']:
            rec['primary_theme'] = rec['subthemes'][0].split(' - ')[0]
            
    log(f"Crawl complete. Successfully mapped {len(ticker_map)} US tickers.")
    return ticker_map


def fetch_news_and_insiders(symbol: str, *, session: requests.Session | None = None) -> dict:
    """Fetch recent news headlines and SEC Form 4 insider transactions for a single ticker.

    Keyed as `stock_record` reads them (`news_feed`, `insider_activity`), so the result can be merged straight into a
    stock's thematic entry. Takes the pipeline's symbol (BRK.B) and asks Finviz for its own (BRK-B).
    """
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    url = f"{QUOTE_URL}?t={symbol.strip().upper().replace('.', '-')}"

    try:
        resp = sess.get(url, timeout=15)
        if resp.status_code != 200:
            return {'news_feed': [], 'insider_activity': []}
        html = resp.text
        
        # 1. Parse News
        news_items = []
        news_rows = re.findall(
            r'<tr[^>]*class="news-link-container"[^>]*>.*?<td[^>]*>(.*?)</td>.*?<a[^>]*href="([^"]+)"[^>]*class="tab-link-news"[^>]*>(.*?)</a>.*?<span[^>]*class="news-link-right"[^>]*>(.*?)</span>',
            html, re.DOTALL
        )
        for date_str, link, title, source in news_rows:
            news_items.append({
                'date': date_str.strip(),
                'url': link.strip(),
                'title': title.strip(),
                'source': source.strip().strip('()'),
            })
            
        # 2. Parse Insiders
        insider_items = []
        # Matches rows in the insider trading table
        insider_rows = re.findall(
            r'<tr[^>]*class="insider-row[^"]*"[^>]*>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>',
            html, re.DOTALL
        )
        for row in insider_rows:
            insider_items.append({
                'name': re.sub(r'<[^>]+>', '', row[0]).strip(),
                'relationship': row[1].strip(),
                'date': row[2].strip(),
                'transaction': row[3].strip(),
                'cost': row[4].strip(),
                'shares': row[5].strip(),
                'value': row[6].strip(),
                'shares_total': row[7].strip(),
                'filing_date': row[8].strip(),
            })
            
        return {'news_feed': news_items, 'insider_activity': insider_items}
    except (requests.RequestException, ValueError, KeyError):
        return {'news_feed': [], 'insider_activity': []}


# Finviz's sector for each sector filter; the ownership view's rows carry the industry but not the sector.
SECTOR_LABELS = {
    'basicmaterials': 'Basic Materials', 'communicationservices': 'Communication Services',
    'consumercyclical': 'Consumer Cyclical', 'consumerdefensive': 'Consumer Defensive', 'energy': 'Energy',
    'financial': 'Financial', 'healthcare': 'Healthcare', 'industrials': 'Industrials', 'realestate': 'Real Estate',
    'technology': 'Technology', 'utilities': 'Utilities',
}


def shard_sector(filter_spec: str) -> str | None:
    """The Finviz sector a shard filter selects ('sec_financial,exch_nasd' -> 'Financial')."""
    for part in filter_spec.split(','):
        if part.startswith('sec_'):
            return SECTOR_LABELS.get(part[4:])
    return None


SECTOR_SHARDS = [
    'sec_basicmaterials', 'sec_communicationservices', 'sec_consumercyclical', 'sec_consumerdefensive',
    'sec_energy', 'sec_industrials', 'sec_realestate', 'sec_technology', 'sec_utilities',
    'sec_financial,exch_nasd', 'sec_financial,exch_nyse', 'sec_financial,exch_amex',
    'sec_healthcare,exch_nasd', 'sec_healthcare,exch_nyse', 'sec_healthcare,exch_amex',
]


def crawl_ownership_universe(*, delay: float = 0.05, workers: int = 3, session: requests.Session | None = None,
                             log: Callable[[str], None] = print) -> dict[str, dict]:
    """Crawl Finviz ownership & short interest data for all listed US stocks across sector shards.

    Raises FinvizFetchError when any shard or page fails or a shard returns fewer rows than Finviz reports, so an
    incomplete crawl never replaces the committed universe.
    """
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    
    ownership_map: dict[str, dict] = {}
    
    def _round(val):
        return round(float(val), 2) if isinstance(val, (int, float)) and val == val else None

    def parse_rows(rows, sector=None):
        for r in rows:
            ticker = (r.get('text') or {}).get('ticker')
            ticker = canonical_symbol(ticker) if ticker else None
            if not ticker or ticker in ownership_map:
                continue
            num = r.get('numbers') or {}
            text = r.get('text') or {}
            ownership_map[ticker] = {
                # Finviz's own classification, read from the same rows (every listed stock has one).
                'finviz_sector': text.get('sector') or sector,
                'finviz_industry': text.get('industry') or None,
                'security_type': text.get('securityType') or None,
                'short_float_percent': _round(num.get('shortInterestShare')),
                'short_ratio': _round(num.get('shortInterestRatio')),
                'insider_own_percent': _round(num.get('insiderOwn')),
                'insider_trans_percent': _round(num.get('insiderTrans')),
                'institutional_own_percent': _round(num.get('instOwn')),
                'institutional_trans_percent': _round(num.get('instTrans')),
            }

    log(f"Crawling ownership & short interest across {len(SECTOR_SHARDS)} sector shards...")
    
    def fetch_page(page_url):
        try:
            resp = sess.get(page_url, timeout=15)
        except requests.RequestException as error:
            raise FinvizFetchError(f"{page_url}: {error}") from error
        if resp.status_code != 200:
            raise FinvizFetchError(f"{page_url}: HTTP {resp.status_code}")
        data = _extract_screener_json(resp.text)
        if not data or not isinstance(data.get('data'), dict):
            raise FinvizFetchError(f"{page_url}: no screener data in the page")
        return data['data']

    def fetch_shard(filter_spec):
        shard_url = f"{SCREENER_URL}?v=131&f={filter_spec}"
        screener_data = fetch_page(shard_url)
        total_count = int(screener_data.get('totalCount') or 0)
        rows = list(screener_data.get('rows', []))
        for offset in range(21, total_count + 1, 20):
            time.sleep(delay)
            rows.extend(fetch_page(f"{shard_url}&r={offset}").get('rows', []))
        if not total_count or len(rows) < total_count:
            raise FinvizFetchError(f"{filter_spec}: fetched {len(rows)} of {total_count} rows")
        return rows

    with ThreadPoolExecutor(max_workers=workers) as pool:
        # pool.map re-raises a shard's FinvizFetchError here, aborting the crawl.
        for idx, (spec, shard_rows) in enumerate(zip(SECTOR_SHARDS, pool.map(fetch_shard, SECTOR_SHARDS))):
            parse_rows(shard_rows, shard_sector(spec))
            log(f"[{idx + 1}/{len(SECTOR_SHARDS)}] Shard complete: {len(ownership_map)} total stocks mapped")
                
    log(f"Ownership crawl complete: successfully mapped {len(ownership_map)} US tickers.")
    return ownership_map


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be a positive integer, got {value}")
    return number


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Finviz US Thematic & Ownership Crawler")
    parser.add_argument("--thematic-output", type=Path, default=Path(__file__).parents[4] / "us_thematic_universe.json",
                        help="Path to save us_thematic_universe.json")
    parser.add_argument("--ownership-output", type=Path, default=Path(__file__).parents[4] / "us_ownership_universe.json",
                        help="Path to save us_ownership_universe.json")
    parser.add_argument("--catalog-output", type=Path, default=Path(__file__).parents[4] / "us_theme_catalog.json",
                        help="Path to save us_theme_catalog.json (themes and their sub-themes)")
    parser.add_argument("--crawl", choices=["all", "thematic", "ownership"], default="all",
                        help="Which universe to crawl (default: all)")
    parser.add_argument("--delay", type=float, default=0.05, help="Request pacing delay in seconds")
    parser.add_argument("--workers", type=_positive_int, default=3, help="Concurrent workers for ownership pagination")
    args = parser.parse_args()

    # Every crawl fails closed: on any request failure or a short result the committed files are kept and the run
    # exits non-zero, so the weekly sync commits nothing.
    if args.crawl in ("all", "thematic"):
        print(f"Crawling Finviz thematic universe to {args.thematic_output}...")
        raw_catalog = fetch_theme_catalog()
        thematic_univ = crawl_thematic_universe(delay=max(args.delay, 0.15), catalog=raw_catalog)
        check_coverage(thematic_univ, load_thematic_universe(args.thematic_output), "thematic universe")
        catalog = theme_catalog_payload(*raw_catalog)
        save_theme_catalog(args.catalog_output, catalog)
        print(f"Saved {len(catalog['themes'])} themes to {args.catalog_output}.")
        save_thematic_universe(args.thematic_output, thematic_univ)
        print(f"Saved {len(thematic_univ)} mapped US tickers to {args.thematic_output}.")

    if args.crawl in ("all", "ownership"):
        print(f"Crawling Finviz ownership & short interest universe to {args.ownership_output}...")
        ownership_univ = crawl_ownership_universe(delay=args.delay, workers=args.workers)
        check_coverage(ownership_univ, load_ownership_universe(args.ownership_output), "ownership universe")
        save_ownership_universe(args.ownership_output, ownership_univ)
        print(f"Saved {len(ownership_univ)} mapped US tickers to {args.ownership_output}.")
