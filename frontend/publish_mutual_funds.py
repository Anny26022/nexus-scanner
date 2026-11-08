"""Publish the daily mutual fund snapshot to R2, apart from the stock release.

    python frontend/publish_mutual_funds.py

Fetches Dhan's fund screener and AMFI's NAV file (DO NOT DELETE EDL PIPELINE/fetch_mutual_funds.py), uploads the
snapshot as `releases/mf/<sha256>/funds.json.gz`, reads it back, and only then replaces the `mf/current.json`
pointer. Served as /data/mf/current.json and /data/mf/revisions/<rev>/funds.json.gz (workers/screener-ai/siteData.ts).

The live snapshot stays when the new one is older, much smaller, or unchanged. Without R2 settings the files are
written under frontend/public/data/mf/ for local development.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'DO NOT DELETE EDL PIPELINE'))
from fetch_mutual_funds import fetch_snapshot  # noqa: E402

from chart_publication import R2Store, missing_r2_settings  # noqa: E402
from site_data import IMMUTABLE, OUTPUT, POINTER_PREFIX, stored_pointers, upload_pointer  # noqa: E402

POINTER = 'mf/current.json'
# A universe this much smaller than the live one is a partial answer, not funds closing.
MIN_SHARE_OF_LIVE = 0.9


def pack(snapshot):
    """The file's bytes, and a revision from its data alone: a re-fetch of the same NAVs is not a new release."""
    data = gzip.compress(json.dumps(snapshot, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
    content = {key: value for key, value in snapshot.items() if key != 'fetchedAt'}
    revision = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    return data, revision


def pointer_for(snapshot, revision):
    return {'schemaVersion': snapshot['schemaVersion'], 'revision': revision, 'navDate': snapshot['navDate'],
            'fetchedAt': snapshot['fetchedAt'], 'fundCount': snapshot['fundCount'], 'navCheck': snapshot['navCheck'],
            'fundsUrl': f'/data/mf/revisions/{revision}/funds.json.gz'}


def check_against_live(snapshot, live):
    if not live:
        return
    if snapshot['navDate'] < live.get('navDate', ''):
        raise ValueError(f"New NAV date {snapshot['navDate']} is older than the live {live['navDate']}")
    if snapshot['fundCount'] < MIN_SHARE_OF_LIVE * live.get('fundCount', 0):
        raise ValueError(f"Only {snapshot['fundCount']} funds against {live['fundCount']} live")


def read_live(store):
    if POINTER not in stored_pointers(store):
        return None  # The first publication.
    return json.loads(store.cache_command('cat', store.remote(f'{POINTER_PREFIX}/{POINTER}')))


def publish_mutual_funds(store, fetch=fetch_snapshot):
    live = read_live(store)
    snapshot = fetch()
    check_against_live(snapshot, live)
    data, revision = pack(snapshot)
    if live and live.get('revision') == revision:
        print(f'Mutual fund snapshot unchanged ({revision[:12]}); nothing published', flush=True)
        return live
    key = f'releases/mf/{revision}/funds.json.gz'
    with tempfile.TemporaryDirectory() as folder:
        local = Path(folder) / 'funds.json.gz'
        local.write_bytes(data)
        store.cache_command('copyto', str(local), store.remote(key), '--metadata',
                            '--metadata-set', 'content-type=application/gzip', '--metadata-set', IMMUTABLE)
        if store.cache_command('cat', store.remote(key)) != data:
            raise RuntimeError(f'Mutual fund snapshot read-back mismatch: {key}')
        print(f'Verified: {key} ({snapshot["fundCount"]} funds, {len(data) / 1e6:.2f} MB)', flush=True)
        pointer = pointer_for(snapshot, revision)
        (Path(folder) / 'mf').mkdir()
        (Path(folder) / POINTER).write_text(json.dumps(pointer, separators=(',', ':'), allow_nan=False))
        upload_pointer(store, Path(folder), POINTER)
    print(f"Mutual funds live: {snapshot['fundCount']} funds, NAV date {snapshot['navDate']}, revision {revision[:12]}", flush=True)
    return pointer


def write_local(snapshot, output=OUTPUT):
    data, revision = pack(snapshot)
    release = output / 'mf' / 'revisions' / revision
    release.mkdir(parents=True, exist_ok=True)
    (release / 'funds.json.gz').write_bytes(data)
    (output / POINTER).write_text(json.dumps(pointer_for(snapshot, revision), separators=(',', ':'), allow_nan=False))
    print(f'R2 settings missing; wrote {output / POINTER} locally only', flush=True)


def main():
    if missing_r2_settings():
        write_local(fetch_snapshot())
        return 0
    publish_mutual_funds(R2Store())
    return 0


if __name__ == '__main__':
    sys.exit(main())
