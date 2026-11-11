"""Finviz thematic taxonomy, news, and insider activity provider for the US market.

Provides deep niche and thematic classification (40 high-level themes, 268 sub-themes/niches)
to power US Thematic Rotation (mirroring India's Theme Tracker), along with live news headlines
and SEC Form 4 insider trading activity.
"""

from __future__ import annotations

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
            {'value': opt['value'], 'label': opt['label']}
            for opt in filters.get('theme', {}).get('options', [])
            if opt.get('value') and not opt.get('isEliteOnly')
        ]
        subthemes = [
            {'value': opt['value'], 'label': opt['label'], 'group': opt.get('group')}
            for opt in filters.get('subtheme', {}).get('options', [])
            if opt.get('value') and not opt.get('isEliteOnly')
        ]
        return themes, subthemes
    except (requests.RequestException, ValueError, KeyError):
        return [], []


def fetch_tickers_for_filter(filter_param: str, *, session: requests.Session | None = None,
                             delay: float = 0.2) -> list[str]:
    """Fetch all tickers matching a single filter parameter (e.g. 'theme_artificialintelligence')."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    url = f"{SCREENER_URL}?f={filter_param}"
    
    try:
        resp = sess.get(url, timeout=15)
        if resp.status_code != 200:
            return []
        tickers = re.findall(r'"ticker"\s*:\s*"([A-Z0-9_\.\-]+)"', resp.text)
        tc_match = re.search(r'"totalCount"\s*:\s*([0-9]+)', resp.text)
        total_count = int(tc_match.group(1)) if tc_match else len(tickers)
        
        all_tickers = list(tickers)
        # Paginate if more than 20 results
        for offset in range(21, min(total_count + 1, 500), 20):
            time.sleep(delay)
            p_resp = sess.get(f"{url}&r={offset}", timeout=15)
            if p_resp.status_code == 200:
                p_tickers = re.findall(r'"ticker"\s*:\s*"([A-Z0-9_\.\-]+)"', p_resp.text)
                all_tickers.extend(p_tickers)
        return sorted(set(all_tickers))
    except (requests.RequestException, ValueError):
        return []


def crawl_thematic_universe(*, delay: float = 0.15, session: requests.Session | None = None,
                            log: Callable[[str], None] = print) -> dict[str, dict]:
    """Crawl Finviz themes and subthemes with polite pacing (runs weekly/monthly)."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    
    themes, subthemes = fetch_theme_catalog(session=sess)
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
    """Fetch recent news headlines and SEC Form 4 insider transactions for a single ticker."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    url = f"{QUOTE_URL}?t={symbol}"
    
    try:
        resp = sess.get(url, timeout=15)
        if resp.status_code != 200:
            return {'news': [], 'insiders': []}
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
            
        return {'news': news_items, 'insiders': insider_items}
    except (requests.RequestException, ValueError, KeyError):
        return {'news': [], 'insiders': []}


SECTOR_SHARDS = [
    'sec_basicmaterials', 'sec_communicationservices', 'sec_consumercyclical', 'sec_consumerdefensive',
    'sec_energy', 'sec_industrials', 'sec_realestate', 'sec_technology', 'sec_utilities',
    'sec_financial,exch_nasd', 'sec_financial,exch_nyse', 'sec_financial,exch_amex',
    'sec_healthcare,exch_nasd', 'sec_healthcare,exch_nyse', 'sec_healthcare,exch_amex',
]


def crawl_ownership_universe(*, delay: float = 0.05, workers: int = 3, session: requests.Session | None = None,
                             log: Callable[[str], None] = print) -> dict[str, dict]:
    """Crawl Finviz ownership & short interest data for all listed US stocks across sector shards."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)
    
    ownership_map: dict[str, dict] = {}
    
    def _round(val):
        return round(float(val), 2) if isinstance(val, (int, float)) and val == val else None

    def parse_rows(rows):
        for r in rows:
            ticker = (r.get('text') or {}).get('ticker')
            if not ticker or ticker in ownership_map:
                continue
            num = r.get('numbers') or {}
            ownership_map[ticker] = {
                'short_float_percent': _round(num.get('shortInterestShare')),
                'short_ratio': _round(num.get('shortInterestRatio')),
                'insider_own_percent': _round(num.get('insiderOwn')),
                'insider_trans_percent': _round(num.get('insiderTrans')),
                'institutional_own_percent': _round(num.get('instOwn')),
                'institutional_trans_percent': _round(num.get('instTrans')),
            }

    log(f"Crawling ownership & short interest across {len(SECTOR_SHARDS)} sector shards...")
    
    def fetch_shard(filter_spec):
        shard_url = f"{SCREENER_URL}?v=131&f={filter_spec}"
        try:
            resp = sess.get(shard_url, timeout=15)
            if resp.status_code != 200:
                return []
            data = _extract_screener_json(resp.text)
            if not data or 'data' not in data:
                return []
            screener_data = data['data']
            total_count = screener_data.get('totalCount', 0)
            rows = list(screener_data.get('rows', []))
            
            for offset in range(21, total_count + 1, 20):
                time.sleep(delay)
                p_resp = sess.get(f"{shard_url}&r={offset}", timeout=15)
                if p_resp.status_code == 200:
                    p_data = _extract_screener_json(p_resp.text)
                    if p_data and 'data' in p_data:
                        rows.extend(p_data['data'].get('rows', []))
            return rows
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for idx, shard_rows in enumerate(pool.map(fetch_shard, SECTOR_SHARDS)):
            parse_rows(shard_rows)
            log(f"[{idx + 1}/{len(SECTOR_SHARDS)}] Shard complete: {len(ownership_map)} total stocks mapped")
                
    log(f"Ownership crawl complete: successfully mapped {len(ownership_map)} US tickers.")
    return ownership_map


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Finviz US Thematic & Ownership Crawler")
    parser.add_argument("--thematic-output", type=Path, default=Path(__file__).parents[4] / "us_thematic_universe.json",
                        help="Path to save us_thematic_universe.json")
    parser.add_argument("--ownership-output", type=Path, default=Path(__file__).parents[4] / "us_ownership_universe.json",
                        help="Path to save us_ownership_universe.json")
    parser.add_argument("--crawl", choices=["all", "thematic", "ownership"], default="all",
                        help="Which universe to crawl (default: all)")
    parser.add_argument("--delay", type=float, default=0.05, help="Request pacing delay in seconds")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent workers for ownership pagination")
    args = parser.parse_args()
    
    if args.crawl in ("all", "thematic"):
        print(f"Crawling Finviz thematic universe to {args.thematic_output}...")
        thematic_univ = crawl_thematic_universe(delay=max(args.delay, 0.15))
        save_thematic_universe(args.thematic_output, thematic_univ)
        print(f"Saved {len(thematic_univ)} mapped US tickers to {args.thematic_output}.")
        
    if args.crawl in ("all", "ownership"):
        print(f"Crawling Finviz ownership & short interest universe to {args.ownership_output}...")
        ownership_univ = crawl_ownership_universe(delay=args.delay, workers=args.workers)
        save_ownership_universe(args.ownership_output, ownership_univ)
        print(f"Saved {len(ownership_univ)} mapped US tickers to {args.ownership_output}.")
