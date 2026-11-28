"""Keep the US pipeline's carried-over state in private R2 storage, as India's (tools/pipeline_state.py).

The US root carries price history, Dhan stock pages and SEC filings between runs: about 20,000 small files. They
were kept in GitHub's Actions cache, which is shared with India's caches (10 GB for the repository, oldest evicted
first) and dropped after 7 idle days. Here each folder travels as one compressed archive, a few objects a run:

    pull                  restore every archive and file R2 holds into the US root (nothing there yet: a cold start)
    push [NAME ...]       upload them (all, or the ones named), the current R2 copy first moved to previous/
    push --keep-previous  upload without touching previous/: a build that failed its release checks or found no new
                          session, and the ledger's second push, so previous/ stays the state of the last good run
    pulse                 copy the Earnings Pulse US archive (results/us_index.json and its objects) into the root

`push` refuses to run unless `pull` completed in this root, so a run whose restore failed never overwrites the
stored state with an empty one. The prefix is not served by the public data Worker.
"""
import argparse
import json
import os
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'frontend'))

PREFIX = 'pipeline-state/us'
# Folders packed one archive each. CSVs and news JSON compress well; the page and filing caches are compressed already.
# News is carried so a stock whose news request fails keeps its last articles (news.refresh writes only on success).
FOLDERS = {'ohlcv_data': 'w:gz', 'indices_ohlcv_data': 'w:gz', 'stock_pages': 'w', 'sec_filings': 'w', 'market_news': 'w:gz'}
FILES = ('rotation_membership_ledger.json.gz', 'quarterly_financial_history.json.gz')
PULLED = '.us-state-pulled'
# Earnings Pulse's US archive, as the US refresh's calendar step publishes it (frontend/earningspulse_history.py).
PULSE_INDEX = 'site/data/results/us_index.json'
PULSE_DIRECTORY = 'earnings_pulse'


def archive_name(folder):
    return folder + ('.tar.gz' if FOLDERS[folder] == 'w:gz' else '.tar')


def pack(directory: Path, mode: str, target: Path):
    """The folder's files as one archive at `target`, written straight to disk."""
    with tarfile.open(target, mode=mode) as archive:
        for path in sorted(directory.rglob('*')):
            # A *.tmp is a write a killed run left half-done (history.py writes a temp file, then renames it).
            if path.is_file() and path.suffix != '.tmp':
                archive.add(path, arcname=str(path.relative_to(directory)))


def unpack(source: Path, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    with tarfile.open(source, mode='r:*') as archive:
        for member in archive.getmembers():
            # Only plain files inside the folder (no links, no absolute or parent paths).
            target = (directory / member.name).resolve()
            if not member.isfile() or directory.resolve() not in target.parents:
                raise RuntimeError(f'Unexpected entry in the state archive: {member.name}')
        archive.extractall(directory)


def stored_names(store) -> set:
    try:
        return set(store.cache_command('lsf', store.remote(PREFIX + '/'), '--files-only').decode().split())
    except Exception as error:  # an unreadable listing is not an empty one: stop rather than cold-start
        raise RuntimeError(f'US state in R2 could not be listed: {error}') from error


def pull(store, root: Path):
    present = stored_names(store)
    root.mkdir(parents=True, exist_ok=True)
    for folder in FOLDERS:
        name = archive_name(folder)
        if name in present:
            local = root / name
            store.run('copyto', store.remote(f'{PREFIX}/{name}'), str(local))
            unpack(local, root / folder)
            local.unlink()
            print(f'{name}: restored ({sum(1 for _ in (root / folder).rglob("*"))} files)', flush=True)
        else:
            print(f'{name}: not in R2 yet; starts empty', flush=True)
    for name in FILES:
        if name in present:
            store.run('copyto', store.remote(f'{PREFIX}/{name}'), str(root / name))
    (root / PULLED).write_text(json.dumps(sorted(present)))


def push(store, root: Path, names=(), keep_previous=False):
    if not (root / PULLED).exists():
        raise RuntimeError('US state was not pulled into this root; refusing to overwrite R2')
    present = stored_names(store)
    wanted = set(names) or set(FOLDERS) | set(FILES)
    for folder in sorted(set(FOLDERS) & wanted):
        directory, name = root / folder, archive_name(folder)
        if not directory.is_dir() or not any(directory.iterdir()):
            print(f'{name}: nothing in this run; R2 copy kept', flush=True)
            continue
        local = root / name
        pack(directory, FOLDERS[folder], local)
        _upload(store, present, local, name, keep_previous)
        local.unlink()
    for name in sorted(set(FILES) & wanted):
        if (root / name).exists():
            _upload(store, present, root / name, name, keep_previous)


def _upload(store, present, local: Path, name: str, keep_previous=False):
    key = f'{PREFIX}/{name}'
    if name in present and not keep_previous:
        store.run('copyto', store.remote(key), store.remote(f'{PREFIX}/previous/{name}'))
    store.run('copyto', str(local), store.remote(key))
    # Compare sizes: the archives are hundreds of megabytes, too large to read back whole through a pipe.
    listed = store.cache_command('lsjson', store.remote(key))
    size = json.loads(listed)[0]['Size'] if listed else None
    if size != local.stat().st_size:
        raise RuntimeError(f'US state upload mismatch: {key} ({size} != {local.stat().st_size} bytes)')
    print(f'{name}: pushed ({local.stat().st_size / 1e6:.1f} MB)', flush=True)


def pulse(store, root: Path):
    """The Earnings Pulse US archive into root/earnings_pulse/: the index and every object it names, from R2."""
    directory = root / PULSE_DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    index = json.loads(store.cache_command('cat', store.remote(PULSE_INDEX)))
    (directory / 'us_index.json').write_text(json.dumps(index))
    for quarter in (index.get('quarters') or {}).values():
        for part in ('published', 'upcoming'):
            digest = (quarter.get(part) or {}).get('sha256')
            if digest and (quarter.get(part) or {}).get('count'):
                store.run('copyto', store.remote(f'objects/{digest}.json.gz'), str(directory / f'{digest}.json.gz'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('action', choices=('pull', 'push', 'pulse'))
    parser.add_argument('names', nargs='*', help='push only these folders or files')
    parser.add_argument('--keep-previous', action='store_true', help='push without moving the R2 copy to previous/')
    args = parser.parse_args(argv)
    from chart_publication import R2Store, missing_r2_settings
    missing = missing_r2_settings()
    if missing:
        print('US state in R2 skipped; missing ' + ', '.join(missing), flush=True)
        return 0 if args.action != 'push' else 1
    root = Path(os.environ['US_ROOT'])
    store = R2Store()
    if args.action == 'pulse':
        try:
            pulse(store, root)
        except Exception as error:  # the build falls back to TradingView's earnings dates
            print(f'::warning::Earnings Pulse US archive unavailable from R2: {error}', flush=True)
        return 0
    if args.action == 'pull':
        pull(store, root)
    else:
        push(store, root, args.names, keep_previous=args.keep_previous)
    return 0


if __name__ == '__main__':
    sys.exit(main())
