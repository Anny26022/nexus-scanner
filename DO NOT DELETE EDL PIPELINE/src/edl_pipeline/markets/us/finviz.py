"""Finviz thematic taxonomy, news, and insider activity provider for the US market.

Provides deep niche and thematic classification (40 high-level themes, 268 sub-themes/niches)
to power US Thematic Rotation (mirroring India's Theme Tracker), along with live news headlines
and SEC Form 4 insider trading activity.
"""

from __future__ import annotations

import json
import re
import time
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


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Finviz US Thematic Crawler")
    parser.add_argument("--output", type=Path, default=Path(__file__).parents[4] / "us_thematic_universe.json",
                        help="Path to save us_thematic_universe.json")
    parser.add_argument("--delay", type=float, default=0.15, help="Request pacing delay in seconds")
    args = parser.parse_args()
    
    print(f"Crawling Finviz thematic universe to {args.output}...")
    universe = crawl_thematic_universe(delay=args.delay)
    save_thematic_universe(args.output, universe)
    print(f"Saved {len(universe)} mapped US tickers to {args.output}.")


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
