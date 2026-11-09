"""Publish the weekly mutual fund portfolios to R2.

    python frontend/publish_mf_holdings.py

Fetches holdings, AUM history and asset mix for every Direct-Growth fund, the fund-house list and NFOs
(DO NOT DELETE EDL PIPELINE/fetch_mutual_fund_holdings.py), uploads `releases/mf-holdings/<revision>/`, checks it, then
replaces the `mf/holdings.json` pointer and removes older weekly releases. Its own pointer and release area keep it
clear of the daily snapshot (publish_mutual_funds.py).

Served as /data/mf/holdings.json and /data/mf/holdings/revisions/<rev>/... (workers/screener-ai/siteData.ts):
    summary.json.gz             per fund: portfolio date, holding counts, top-10 weight, sector weights, asset mix, AUM history
    holdings/<fund ISIN>.json.gz   the fund's holdings
    holders/<stock ISIN>.json.gz   the funds holding an Indian equity
    fund-houses.json.gz, nfos.json.gz
"""
from datetime import datetime, timedelta, timezone
import gzip
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'DO NOT DELETE EDL PIPELINE'))
from fetch_mutual_fund_holdings import fetch_week  # noqa: E402

from chart_publication import R2Store, missing_r2_settings  # noqa: E402
from mf_release import prune_releases, publish_release, read_pointer, write_release  # noqa: E402

POINTER = 'mf/holdings.json'
NAMESPACE = 'mf-holdings'
SCHEMA_VERSION = 1
MIN_SHARE_OF_LIVE = 0.9
# AUM history is month-end data; last week's is reused until it is this old.
AUM_REFRESH_DAYS = 28


def check_against_live(report, live):
    if not live:
        return
    if report['withHoldings'] < MIN_SHARE_OF_LIVE * live.get('withHoldings', 0):
        raise ValueError(f"Holdings for only {report['withHoldings']} funds against {live['withHoldings']} live")
    newest, live_newest = (report.get('portfolioDates') or {}).get('newest') or '', (live.get('portfolioDates') or {}).get('newest') or ''
    if newest < live_newest:
        raise ValueError(f'Newest portfolio date {newest} is older than the live {live_newest}')


def pointer_for(report, revision):
    base = f'/data/mf/holdings/revisions/{revision}'
    return dict(report, schemaVersion=SCHEMA_VERSION, revision=revision, summaryUrl=f'{base}/summary.json.gz',
                holdingsUrlTemplate=f'{base}/holdings/{{isin}}.json.gz', holdersUrlTemplate=f'{base}/holders/{{isin}}.json.gz',
                fundHousesUrl=f'{base}/fund-houses.json.gz', nfosUrl=f'{base}/nfos.json.gz')


def previous_aums(store, live, now=None):
    """Last week's AUM histories ({ISIN: history}) while they are under AUM_REFRESH_DAYS old, else None."""
    fetched = (live or {}).get('aumFetchedAt')
    now = now or datetime.now(timezone.utc)
    if not fetched or now - datetime.fromisoformat(fetched.replace('Z', '+00:00')) >= timedelta(days=AUM_REFRESH_DAYS):
        return None
    summary = json.loads(gzip.decompress(store.cache_command('cat', store.remote(f"releases/{NAMESPACE}/{live['revision']}/summary.json.gz"))))
    return {fund['isin']: fund['aumHistory'] for fund in summary['funds'] if fund.get('aumHistory')}


def publish_holdings(store, fetch=fetch_week):
    live = read_pointer(store, POINTER)
    aums = previous_aums(store, live)
    files, report = fetch(previous_aums=aums, aum_fetched_at=(live or {}).get('aumFetchedAt') if aums else None)
    check_against_live(report, live)
    with tempfile.TemporaryDirectory() as folder:
        revision = write_release(folder, files)
        if live and live.get('revision') == revision:
            print(f'Mutual fund holdings unchanged ({revision[:12]}); nothing published', flush=True)
            return live
        pointer = pointer_for(report, revision)
        publish_release(store, folder, NAMESPACE, revision, POINTER, pointer)
    prune_releases(store, NAMESPACE, keep={revision, (live or {}).get('revision')})
    print(f"Mutual fund holdings live: {report['withHoldings']} funds, {report['stockCount']} stocks held, "
          f"portfolios {report['portfolioDates']}, revision {revision[:12]}", flush=True)
    return pointer


def main():
    missing = missing_r2_settings()
    if missing:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            print('::error::R2 settings missing (' + ', '.join(missing) + '); mutual fund holdings were not published.', flush=True)
            return 1
        files, report = fetch_week()
        print(f'R2 settings missing; built {len(files)} files locally and published nothing: {report}', flush=True)
        return 0
    publish_holdings(R2Store())
    return 0


if __name__ == '__main__':
    sys.exit(main())
