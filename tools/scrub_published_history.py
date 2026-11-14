"""One-off: rewrite data published before neutral publication so it no longer names its sources.

New publications already pass through frontend/public_payload.py. This job applies the same filter to what
R2 still holds from earlier runs:

- snapshots/<date>.json.gz, the daily history back to 2021 (served no-cache, so rewrites apply at once);
- releases/<revision>/stocks.json, index.json and release.json, and monthly/**/releases/*.json;
- complete filing backups, which older release indexes listed under objects/. They move to the private
  backups/ prefix the data Worker never serves, and the indexes stop referencing them.

Without --apply it only reports what would change. Rewrites keep each file's revision and are read back
before the next file; a rerun skips files that are already clean.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'frontend'))

from public_payload import public  # noqa: E402

# Upload settings per prefix, matching how each file was first published.
METADATA = {
    'snapshots': ['--metadata', '--metadata-set', 'content-type=application/gzip'],
    'stocks': ['--metadata', '--metadata-set', 'content-type=application/json',
               '--metadata-set', 'cache-control=public,max-age=31536000,immutable'],
    'reference': [],
}
BACKUP_KEYS = ('archives', 'archivesAsOf')


def encode(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode()


def scrub_index(index):
    """Public form of a release index, plus the backups it used to reference."""
    archives = {name: digest for name, digest in (index.get('archives') or {}).items()}
    if archives and index.get('archivesAsOf'):
        archives['asOf'] = index['archivesAsOf']
    clean = public({key: value for key, value in index.items() if key not in BACKUP_KEYS})
    return clean, archives


def plan(key, data):
    """(kind, new bytes or None, backups) for one stored file; None means already clean."""
    if key.startswith('snapshots/'):
        value = json.loads(gzip.decompress(data))
        clean = public(value)
        return 'snapshots', None if clean == value else gzip.compress(encode(clean), compresslevel=6, mtime=0), {}
    value = json.loads(data)
    if key.endswith('/index.json'):
        clean, archives = scrub_index(value)
    else:
        clean, archives = public(value), {}
    kind = 'stocks' if key.endswith('/stocks.json') else 'reference'
    return kind, None if clean == value else encode(clean), archives


class Remote:
    """The few rclone operations this job needs, on the publication bucket."""
    def __init__(self, store):
        self.store = store

    def list(self, prefix, *flags):
        out = self.store.cache_command('lsf', *flags, self.store.remote(prefix))
        return [prefix + line for line in out.decode().splitlines() if line]

    def exists(self, key):
        try:
            return bool(self.store.cache_command('lsf', self.store.remote(key)).strip())
        except Exception:
            return False

    def read(self, key):
        return self.store.cache_command('cat', self.store.remote(key))

    def write(self, key, data, kind):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'file'
            path.write_bytes(data)
            self.store.run('copyto', str(path), self.store.remote(key), '--checksum', *METADATA[kind])
        if self.read(key) != data:
            raise RuntimeError(f'Read-back mismatch after rewrite: {key}')

    def move_backup(self, digest):
        source, target = f'objects/{digest}.json.gz', f'backups/{digest}.json.gz'
        self.store.run('copyto', self.store.remote(source), self.store.remote(target), '--immutable', '--checksum')
        self.store.run('check', self.store.remote(source), self.store.remote(target), '--one-way', '--download')
        self.store.run('deletefile', self.store.remote(source))


def targets(remote):
    keys = remote.list('snapshots/', '--files-only')
    keys += [key for key in remote.list('releases/', '-R', '--files-only')
             if key.endswith(('/stocks.json', '/index.json', '/release.json'))]
    # Monthly archives also hold thousands of chart files; walk only down to their release manifests.
    for month in remote.list('monthly/', '--dirs-only'):
        for revision in remote.list(month, '--dirs-only'):
            keys += [key for key in remote.list(revision + 'releases/', '--files-only') if key.endswith('.json')]
    return keys


def run(remote, *, apply, workers=4):
    report = {'checked': 0, 'clean': 0, 'rewritten': 0, 'wouldRewrite': 0, 'backupsMoved': 0, 'errors': {}}
    backups, lock = {}, threading.Lock()

    def handle(key):
        kind, data, archives = plan(key, remote.read(key))
        if archives:
            revision = key.split('/')[1]
            with lock:
                backups[revision] = archives
            if apply:
                # Record the backups privately before the index stops referencing them.
                remote.write(f'backups/releases/{revision}.json', encode(archives), 'reference')
        if data is not None and apply:
            remote.write(key, data, kind)
        return data is not None

    keys = targets(remote)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for key, future in [(key, pool.submit(handle, key)) for key in keys]:
            try:
                changed = future.result()
            except Exception as error:  # Report and continue; a rerun picks up whatever failed.
                report['errors'][key] = str(error)
                continue
            report['checked'] += 1
            if not changed:
                report['clean'] += 1
            else:
                report['rewritten' if apply else 'wouldRewrite'] += 1
    digests = sorted({digest for archives in backups.values() for name, digest in archives.items() if name != 'asOf'})
    report['backupsReferenced'] = len(digests)
    if apply:
        for digest in digests:
            if not remote.exists(f'objects/{digest}.json.gz'):
                continue  # Already moved by an earlier run.
            try:
                remote.move_backup(digest)
                report['backupsMoved'] += 1
            except Exception as error:
                report['errors'][f'backup {digest}'] = str(error)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='Rewrite files and move backups (default: report only)')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    from chart_publication import R2Store
    report = run(Remote(R2Store()), apply=args.apply, workers=args.workers)
    print(json.dumps(report, indent=2), flush=True)
    return int(bool(report['errors']))


if __name__ == '__main__':
    sys.exit(main())
