"""One-time copy of the Git-served site data into R2, before the Worker starts serving /data/* from there.

Copies every revision folder still in frontend/public/data/revisions (the current release and the one open tabs
may be on) to releases/<rev>/, every company revision to releases/company/<rev>/, then the pointers to
site/data/ with current.json last, the same order and layout the daily publisher uses (frontend/site_data.py).
Revision files are copied with --immutable and download-checked; pointers are read back.

It is safe to run again: identical revision files are skipped, and pointers are replaced by the checkout's.
Run it from an up-to-date main checkout, after the day's refresh commit, with the R2 settings the workflows use:

    R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \\
    R2_PUBLIC_BASE_URL=https://nexus-scanner-data.aniketmahato26.workers.dev \\
        python tools/seed_site_data.py           # lists what would be copied
        python tools/seed_site_data.py --write   # copies it
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'frontend'))
import site_data  # noqa: E402


def plan(output):
    """(local folder, R2 key) for each content-addressed folder, and the pointers in publication order."""
    current = json.loads((output / 'current.json').read_text())
    revisions = sorted(path for path in (output / 'revisions').iterdir()
                       if path.is_dir() and site_data.REVISION.fullmatch(path.name))
    if current['revision'] not in {path.name for path in revisions}:
        raise RuntimeError('current.json names a revision that is not in the checkout')
    folders = [(path, f'releases/{path.name}') for path in revisions]
    company = output / 'company' / 'revisions'
    if company.is_dir():
        folders += [(path, f'releases/company/{path.name}') for path in sorted(company.iterdir())
                    if path.is_dir() and site_data.REVISION.fullmatch(path.name)]
    # Like a release: the catalogue, then the other pointers, current.json last.
    pointers = [site_data.AI_FILTER_CHOICES] + [name for name in site_data.POINTERS
                                                if name not in (site_data.AI_FILTER_CHOICES, 'current.json')
                                                and (output / name).is_file()] + ['current.json']
    return current, folders, pointers


def seed(store, output=site_data.OUTPUT):
    current, folders, pointers = plan(output)
    for source, key in folders:
        site_data.upload_revision(store, source, key)
    site_data.build_ai_filter_choices(output, current)
    for name in pointers:
        site_data.upload_pointer(store, output, name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--write', action='store_true', help='copy to R2 (without it, only list the plan)')
    args = parser.parse_args(argv)
    current, folders, pointers = plan(site_data.OUTPUT)
    print(f'Release {current["revision"][:12]} for session {current["sessionDate"]}')
    for source, key in folders:
        print(f'  {source.relative_to(ROOT)} ({sum(1 for p in source.rglob("*") if p.is_file())} files) -> {key}/')
    for name in pointers:
        print(f'  frontend/public/data/{name} -> {site_data.POINTER_PREFIX}/{name}')
    if not args.write:
        print('Nothing copied; pass --write to copy.')
        return 0
    seed(site_data.R2Store())
    print('Seeded. Check https://<worker>/data/current.json once the Worker serves /data/* from R2.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
