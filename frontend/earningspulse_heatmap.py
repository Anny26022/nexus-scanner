"""Earnings Pulse Heatmap scraper and historical archiver.

Fetches post-earnings price move and quality data from https://earningspulse.ai/heatmap
Supports both India (IN) and US markets, versioning records by content-addressed R2 objects.
Follows the same immutable R2 store & lightweight Git index architecture as earningspulse_history.py.
"""
import argparse
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

import requests

from chart_publication import R2Store, write_json

SOURCE = 'https://earningspulse.ai/heatmap'
OUTPUT_INDEX = Path(__file__).parent / 'public/data/heatmap/index.json'
REPORT = Path(__file__).parent / 'heatmap-refresh-report.json'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'RSC': '1',
}

REQUIRED_FIELDS = {'symbol', 'sector', 'cmp', 'live_cmp', 'post_earnings_pct', 'quarter_label'}


def parse_heatmap_rsc(text: str) -> list[dict]:
    """Extract individual JSON stock objects from Next.js RSC Flight streaming response."""
    unique = {}
    for line in text.split('\n'):
        m = re.search(r'^[0-9a-f]+:(\{.*\"symbol\".*\})$', line)
        if not m:
            continue
        try:
            row = json.loads(m.group(1))
            if not isinstance(row, dict) or not REQUIRED_FIELDS.issubset(row):
                continue
            symbol = row.get('symbol', '').strip()
            if not symbol:
                continue
            # Preserve all fields sent by the provider without pruning
            unique[symbol] = row
        except json.JSONDecodeError:
            continue

    rows = [unique[sym] for sym in sorted(unique)]
    # Validate serializeability (reject NaNs/Infinities)
    json.dumps(rows, allow_nan=False)
    return rows


def fetch_heatmap(session: requests.Session, market: str = 'IN', max_retries: int = 3) -> list[dict]:
    """Fetch current heatmap data with automatic retries."""
    params = {'market': market}
    for attempt in range(max_retries):
        try:
            response = session.get(SOURCE, params=params, headers=HEADERS, timeout=(10, 45))
            response.raise_for_status()
            rows = parse_heatmap_rsc(response.text)
            if not rows:
                raise ValueError(f'Empty heatmap response for market={market}')
            return rows
        except (requests.RequestException, ValueError) as error:
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)
    return []


def refresh_heatmap(output_index: Path, markets: list[str], *, checked_at: str, store: R2Store):
    """Refreshes and archives heatmap datasets for requested markets into R2."""
    previous = json.loads(output_index.read_text()) if output_index.exists() else {'version': 1, 'markets': {}}
    if previous.get('version') != 1 or not isinstance(previous.get('markets'), dict):
        previous = {'version': 1, 'markets': {}}

    market_entries = dict(previous.get('markets', {}))
    report = {'checkedAt': checked_at, 'markets': {}, 'errors': {}}

    with tempfile.TemporaryDirectory(prefix='heatmap-') as folder:
        objects_dir = Path(folder)

        with requests.Session() as session:
            for market in markets:
                try:
                    rows = fetch_heatmap(session, market=market)
                    # Detect predominant quarter_label in the batch
                    quarter_counts = {}
                    for r in rows:
                        q = r.get('quarter_label') or 'unknown'
                        quarter_counts[q] = quarter_counts.get(q, 0) + 1
                    active_quarter = max(quarter_counts, key=quarter_counts.get) if quarter_counts else 'unknown'

                    payload = {
                        'schemaVersion': 1,
                        'market': market,
                        'activeQuarter': active_quarter,
                        'records': rows,
                    }

                    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
                    compressed = gzip.compress(raw, mtime=0)
                    digest = hashlib.sha256(compressed).hexdigest()

                    # Save compressed object in temp directory for upload
                    (objects_dir / f'{digest}.json.gz').write_bytes(compressed)

                    entry = {
                        'checkedAt': checked_at,
                        'activeQuarter': active_quarter,
                        'sha256': digest,
                        'url': f'{store.base_url}/objects/{digest}.json.gz',
                        'count': len(rows),
                    }

                    market_entries[market] = entry
                    report['markets'][market] = {'status': 'updated', 'count': len(rows), 'quarter': active_quarter}
                except Exception as error:
                    report['errors'][market] = str(error)
                    print(f'WARNING: Heatmap {market}: {error}', file=sys.stderr, flush=True)

        # Upload to R2 using verified immutable uploader
        if report['markets']:
            known = {item['sha256'] + '.json.gz' for item in previous.get('markets', {}).values()
                     if item.get('url') == f"{store.base_url}/objects/{item.get('sha256')}.json.gz"}
            store.upload_objects(objects_dir, known)
            write_json(output_index, {'version': 1, 'markets': market_entries})

    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--markets', nargs='+', default=['IN', 'US'], help='Markets to fetch (default: IN US)')
    args = parser.parse_args()

    now = datetime.now(ZoneInfo('Asia/Kolkata'))
    try:
        report = refresh_heatmap(OUTPUT_INDEX, args.markets, checked_at=now.isoformat(), store=R2Store())
    except Exception as error:
        report = {'checkedAt': now.isoformat(), 'errors': {'publication': str(error)}}

    write_json(REPORT, report)

    if report.get('errors'):
        print('::warning::Heatmap refresh encountered errors; see heatmap-refresh-report.json', flush=True)
    print(json.dumps(report, indent=2), flush=True)
    return int(bool(report.get('errors')))


if __name__ == '__main__':
    sys.exit(main())
