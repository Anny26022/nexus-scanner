"""R2 steps shared by the mutual fund publishers (daily snapshot, weekly holdings).

A release is a folder of gzipped JSON under `releases/<namespace>/<revision>/`, uploaded and download-checked before
its pointer under `site/data/` is replaced. Private run-to-run state lives under `pipeline-state/`, like the stock
pipeline's (tools/pipeline_state.py), with the previous copy kept beside it.
"""
import gzip
import hashlib
import json
from pathlib import Path
import tempfile

from site_data import POINTER_PREFIX, stored_pointers, upload_pointer, upload_revision

STATE_PREFIX = 'pipeline-state'


def gzip_json(payload):
    """Canonical bytes: the same payload always gives the same file, so a retried upload cannot change one."""
    return gzip.compress(json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), mtime=0)


def write_release(folder, files):
    """Write {relative path: payload} as gzipped JSON under `folder`; the revision is a digest of every file."""
    digest = hashlib.sha256()
    for name in sorted(files):
        parts = Path(name).parts
        if Path(name).is_absolute() or not parts or any(part in ('', '.', '..') for part in parts):
            raise ValueError(f'Unsafe release file name: {name!r}')
        data = gzip_json(files[name])
        path = Path(folder) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        digest.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
    return digest.hexdigest()


def read_pointer(store, name):
    if name not in stored_pointers(store):
        return None
    return json.loads(store.cache_command('cat', store.remote(f'{POINTER_PREFIX}/{name}')))


def publish_release(store, folder, namespace, revision, pointer_name, pointer):
    """Upload the release (read back by rclone check), then replace the pointer; the pointer goes last."""
    upload_revision(store, Path(folder), f'releases/{namespace}/{revision}')
    publish_pointer(store, pointer_name, pointer)


def publish_pointer(store, pointer_name, pointer):
    """Replace a pointer (read back) to a release already in R2."""
    with tempfile.TemporaryDirectory() as staging:
        path = Path(staging) / pointer_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(pointer, separators=(',', ':'), allow_nan=False))
        upload_pointer(store, Path(staging), pointer_name)


def prune_releases(store, namespace, keep):
    """Remove releases of `namespace` other than `keep` (the new one and the one open tabs may still be on)."""
    listing = store.cache_command('lsf', store.remote(f'releases/{namespace}/'), '--dirs-only').decode().split()
    removed = []
    for name in (entry.rstrip('/') for entry in listing):
        if name and name not in keep:
            store.run('purge', store.remote(f'releases/{namespace}/{name}'))
            removed.append(name)
    if removed:
        print(f'Removed {len(removed)} superseded {namespace} release(s)', flush=True)
    return removed


def read_state(store, name):
    """A private state file, or None before the first run."""
    listing = store.cache_command('lsf', store.remote(f'{STATE_PREFIX}/'), '--files-only').decode().split()
    if name not in listing:
        return None
    return json.loads(gzip.decompress(store.cache_command('cat', store.remote(f'{STATE_PREFIX}/{name}'))))


def write_state(store, name, payload):
    """Replace a private state file, keeping the previous copy, and read it back."""
    data = gzip_json(payload)
    key = f'{STATE_PREFIX}/{name}'
    listing = store.cache_command('lsf', store.remote(f'{STATE_PREFIX}/'), '--files-only').decode().split()
    if name in listing:
        store.run('copyto', store.remote(key), store.remote(f'{STATE_PREFIX}/previous/{name}'))
    with tempfile.TemporaryDirectory() as staging:
        local = Path(staging) / name
        local.write_bytes(data)
        store.run('copyto', str(local), store.remote(key))
    if store.cache_command('cat', store.remote(key)) != data:
        raise RuntimeError(f'State read-back mismatch: {key}')
    print(f'Saved {key} ({len(data) / 1e6:.1f} MB)', flush=True)
