"""Publish only the ETF snapshot into the live release, without rebuilding stocks.

For a day whose full refresh published stocks but not ETFs (the ETF source failed or was refused). It reads the live
current.json from R2, fetches the ETF bulk scan once, builds the ETF file for that release's session with the same
checks as the full publisher, uploads it under the release, and points current.json at it.

    python frontend/publish_etfs.py

The file is named by its content (`etfs-<hash>.json.gz`): release files are cached as immutable, so new content
always gets a new name. current.json is replaced last, and only if the live release is still the one read at the
start, so a full refresh that published meanwhile is never overwritten.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile

from etf_snapshot import build_etf_snapshot  # also puts the pipeline checkout on sys.path
from packed_snapshot import pack_snapshot
from public_payload import public
from chart_publication import R2Store, missing_r2_settings
from site_data import IMMUTABLE, POINTER_PREFIX, REVISION, upload_pointer
from fetch_etf_snapshot import API_URL, COLUMNS, normalize, fetch_us
from pipeline_utils import post_json

CURRENT = f'{POINTER_PREFIX}/current.json'
CURRENT_US = f'{POINTER_PREFIX}/us/current.json'


def fetch_source():
    """The pipeline's one bulk TradingView request (fetch_etf_snapshot.py), normalized the same way."""
    payload = {'columns': COLUMNS, 'range': [0, 10000], 'markets': ['india'],
               'filter': [{'left': key, 'operation': 'equal', 'right': value}
                          for key, value in [('type', 'fund'), ('subtype', 'etf'), ('exchange', 'NSE')]]}
    return normalize(post_json(API_URL, payload, timeout=60, retries=1), datetime.now(timezone.utc).isoformat())


def read_current(store, current_key=CURRENT):
    return json.loads(store.cache_command('cat', store.remote(current_key)))


def publish_etfs(store, fetch=None, market='in'):
    current_key = CURRENT_US if market == 'us' else CURRENT
    pointer_filename = 'us/current.json' if market == 'us' else 'current.json'
    fetch_fn = fetch or (fetch_us if market == 'us' else fetch_source)
    live = read_current(store, current_key)
    revision, session = live.get('revision', ''), live.get('sessionDate', '')
    if not REVISION.fullmatch(revision) or not session:
        raise RuntimeError(f'Live {pointer_filename} has no valid revision and session')
    print(f'Live release {revision[:12]} ({market.upper()}) for session {session}; ETFs now: {live.get("etfDatasetUrl") or "none"}', flush=True)

    snapshot = public(build_etf_snapshot(fetch_fn(), session, revision, market=market))
    data = gzip.compress(json.dumps(pack_snapshot(snapshot), separators=(',', ':'), allow_nan=False).encode(), mtime=0)
    name = f'etfs-{hashlib.sha256(data).hexdigest()[:16]}.json.gz'
    key = f'releases/{revision}/{name}'
    with tempfile.TemporaryDirectory() as folder:
        local = Path(folder) / name
        local.write_bytes(data)
        store.cache_command('copyto', str(local), store.remote(key), '--metadata',
                            '--metadata-set', 'content-type=application/gzip', '--metadata-set', IMMUTABLE)
        if store.cache_command('cat', store.remote(key)) != data:
            raise RuntimeError(f'ETF file read-back mismatch: {key}')
        print(f'Verified: {key} ({snapshot["totalStocks"]} ETFs, {len(data) / 1e6:.1f} MB)', flush=True)

        # A full refresh may have gone live while this ran; never put an older release back.
        latest = read_current(store, current_key)
        if latest.get('revision') != revision:
            raise RuntimeError('A newer release went live during this run; it publishes its own ETFs. Nothing changed.')
        latest['etfDatasetUrl'] = f'/data/revisions/{revision}/{name}'
        pointer_path = Path(folder) / pointer_filename
        pointer_path.parent.mkdir(parents=True, exist_ok=True)
        pointer_path.write_text(json.dumps(latest, separators=(',', ':'), allow_nan=False))
        upload_pointer(store, Path(folder), pointer_filename)
    print(f'ETF snapshot live for {session}: {latest["etfDatasetUrl"]}', flush=True)
    return latest


def main(argv=None):
    parser = argparse.ArgumentParser(prog='publish_etfs')
    parser.add_argument('--market', choices=['in', 'us'], default='in', help='market to publish ETFs for')
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    missing = missing_r2_settings()
    if missing:
        print('R2 settings missing: ' + ', '.join(missing), file=sys.stderr)
        return 1
    publish_etfs(R2Store(), market=args.market)
    return 0


if __name__ == '__main__':
    sys.exit(main())
