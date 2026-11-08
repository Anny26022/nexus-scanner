"""Publish only the ETF snapshot into the live release, without rebuilding stocks.

For a day whose full refresh published stocks but not ETFs (the ETF source failed or was refused). It reads the live
current.json from R2, fetches the ETF bulk scan once, builds the ETF file for that release's session with the same
checks as the full publisher, uploads it under the release, and points current.json at it.

    python frontend/publish_etfs.py

The file is named by its content (`etfs-<hash>.json.gz`): release files are cached as immutable, so new content
always gets a new name. current.json is replaced last, and only if the live release is still the one read at the
start, so a full refresh that published meanwhile is never overwritten.
"""
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
from fetch_etf_snapshot import API_URL, COLUMNS, normalize
from pipeline_utils import post_json

CURRENT = f'{POINTER_PREFIX}/current.json'


def fetch_source():
    """The pipeline's one bulk TradingView request (fetch_etf_snapshot.py), normalized the same way."""
    payload = {'columns': COLUMNS, 'range': [0, 10000], 'markets': ['india'],
               'filter': [{'left': key, 'operation': 'equal', 'right': value}
                          for key, value in [('type', 'fund'), ('subtype', 'etf'), ('exchange', 'NSE')]]}
    return normalize(post_json(API_URL, payload, timeout=60, retries=1), datetime.now(timezone.utc).isoformat())


def read_current(store):
    return json.loads(store.cache_command('cat', store.remote(CURRENT)))


def publish_etfs(store, fetch=fetch_source):
    live = read_current(store)
    revision, session = live.get('revision', ''), live.get('sessionDate', '')
    if not REVISION.fullmatch(revision) or not session:
        raise RuntimeError('Live current.json has no valid revision and session')
    print(f'Live release {revision[:12]} for session {session}; ETFs now: {live.get("etfDatasetUrl") or "none"}', flush=True)

    snapshot = public(build_etf_snapshot(fetch(), session, revision))
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
        latest = read_current(store)
        if latest.get('revision') != revision:
            raise RuntimeError('A newer release went live during this run; it publishes its own ETFs. Nothing changed.')
        latest['etfDatasetUrl'] = f'/data/revisions/{revision}/{name}'
        (Path(folder) / 'current.json').write_text(json.dumps(latest, separators=(',', ':'), allow_nan=False))
        upload_pointer(store, Path(folder), 'current.json')
    print(f'ETF snapshot live for {session}: {latest["etfDatasetUrl"]}', flush=True)
    return latest


def main():
    missing = missing_r2_settings()
    if missing:
        print('R2 settings missing: ' + ', '.join(missing), file=sys.stderr)
        return 1
    publish_etfs(R2Store())
    return 0


if __name__ == '__main__':
    sys.exit(main())
