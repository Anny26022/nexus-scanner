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
import os
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
    """The release file and its revision. The fetch time stays in the pointer, so the same data always has the same
    bytes: a re-fetch publishes nothing, and a retried upload rewrites an identical immutable object."""
    content = {key: value for key, value in snapshot.items() if key != 'fetchedAt'}
    data = gzip.compress(json.dumps(content, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
    return data, hashlib.sha256(data).hexdigest()


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


def replace_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)


def write_local(snapshot, output=OUTPUT):
    """Local development: the same checks and order as R2, into frontend/public/data/mf/."""
    pointer_path = output / POINTER
    check_against_live(snapshot, json.loads(pointer_path.read_text()) if pointer_path.is_file() else None)
    data, revision = pack(snapshot)
    replace_file(output / 'mf' / 'revisions' / revision / 'funds.json.gz', data)
    replace_file(pointer_path, json.dumps(pointer_for(snapshot, revision), separators=(',', ':'), allow_nan=False).encode())
    print(f'R2 settings missing; wrote {pointer_path} locally only', flush=True)


def main():
    missing = missing_r2_settings()
    if missing and os.environ.get('GITHUB_ACTIONS') == 'true':
        print('::error::R2 settings missing (' + ', '.join(missing) + '); the mutual fund snapshot was not published.', flush=True)
        return 1
    if missing:
        write_local(fetch_snapshot())
        return 0
    publish_mutual_funds(R2Store())
    return 0


if __name__ == '__main__':
    sys.exit(main())
