"""Publish the site's /data files to R2, so a data refresh needs neither a commit nor a Worker rebuild.

The `nexus-scanner` Worker serves `/data/...` from these keys (workers/screener-ai/siteData.ts). The layout is
the one Nexus Journal's R2 mode already reads (packages/nexus-scanner/src/api/origins.ts there), so both sites
share the immutable files:

    /data/revisions/<rev>/<file>          -> releases/<rev>/<file>          immutable
    /data/company/revisions/<rev>/<file>  -> releases/company/<rev>/<file>  immutable
    /data/<pointer>                       -> site/data/<pointer>            revalidated

`releases/<rev>/` already holds the chart index, release.json and the plain stock list of each release. Pointers
live outside `daily/`, whose lifecycle rule expires objects after 90 days, and outside the journal's
`daily/journal/`, so the two pipelines never overwrite each other's pointers.

A release goes live in this order: its revision files (uploaded and read back), the AI filter catalogue built from
it, the price-band ledger and sessions.json, and current.json last. A run that fails part-way leaves the previous
release live, as an uncommitted Git refresh used to.

    python frontend/site_data.py pull          # before a refresh: the pointers the pipeline reads and extends
    python frontend/site_data.py push-indexes  # after the Earnings Pulse and Tijori steps
    python frontend/site_data.py push-sessions # after a backfill registers archived sessions
    python frontend/site_data.py ai-choices    # rebuild public/data/ai-filter-choices.json locally
"""
import argparse
import gzip
import json
import math
import os
from pathlib import Path
import re
import sys

from chart_publication import R2Store, charts_enabled, missing_r2_settings, write_json

OUTPUT = Path(__file__).resolve().parent / 'public/data'
POINTER_PREFIX = 'site/data'
AI_FILTER_CHOICES = 'ai-filter-choices.json'
# Kept in step with POINTERS in workers/screener-ai/siteData.ts; anything else is not served.
POINTERS = ('current.json', 'sessions.json', 'price-band-history.json', AI_FILTER_CHOICES,
            'results/index.json', 'results/us_index.json', 'heatmap/index.json', 'company/current.json')
# Written after the scanner release, by the Earnings Pulse and Tijori steps.
INDEXES = ('results/index.json', 'results/us_index.json', 'heatmap/index.json', 'company/current.json')
REVISION = re.compile(r'[a-f0-9]{64}')
IMMUTABLE = 'cache-control=public,max-age=31536000,immutable'
# Filter id -> stock field. The AI endpoint offers these values, so they must come from the release it checks.
AI_CHOICE_FIELDS = {'SECTOR': 'sector', 'INDUSTRY': 'industry', 'SERIES': 'series', 'PRICE_BAND': 'circuitLimit',
                    'INDEX_MEMBERSHIP': 'indexMemberships'}


def enabled():
    """Whether this run publishes to R2: as for charts, r2 storage with its settings present."""
    return os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2' and charts_enabled()


def build_ai_filter_choices(output, manifest):
    """Write the AI screener's filter catalogue for the release `manifest` names; returns its path.

    The AI endpoint answers 409 when a browser's dataset revision differs from the catalogue's, so the catalogue is
    built here, from the release being published, rather than by the site build.
    """
    revision = manifest.get('revision')
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise RuntimeError('Invalid AI catalogue revision')
    release = output / 'revisions' / revision
    compressed, plain = release / 'stocks.json.gz', release / 'stocks.json'
    snapshot = json.loads(gzip.decompress(compressed.read_bytes()) if compressed.exists() else plain.read_bytes())
    if snapshot.get('revision') != revision or not isinstance(snapshot.get('stocks'), list):
        raise RuntimeError('AI catalogue dataset mismatch')
    stocks = snapshot['stocks']

    def values(stock, field):
        value = stock.get(field)
        return value if isinstance(value, list) else [value]

    choices = {filter_id: sorted({value.strip().upper() for stock in stocks for value in values(stock, field)
                                  if isinstance(value, str) and value.strip()})
               for filter_id, field in AI_CHOICE_FIELDS.items()}
    choices['TRADINGVIEW_METRIC'] = sorted({
        metric for stock in stocks
        if isinstance(stock.get('tradingview'), dict) and stock['tradingview'].get('asOfDate') == snapshot.get('asOfDate')
        for metric, value in (stock['tradingview'].get('values') or {}).items()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)})
    target = output / AI_FILTER_CHOICES
    write_json(target, {'revision': revision, 'sessionDate': manifest.get('sessionDate'), 'choices': choices})
    return target


def stored_pointers(store):
    listing = store.cache_command('lsf', store.remote(POINTER_PREFIX + '/'), '-R', '--files-only')
    return set(listing.decode().split())


def upload_pointer(store, output, name):
    """Replace one pointer and read it back; a mismatch stops before anything later goes live."""
    if name not in POINTERS:
        raise RuntimeError(f'Not a published pointer: {name}')
    local = output / name
    data = local.read_bytes()
    key = f'{POINTER_PREFIX}/{name}'
    store.cache_command('copyto', str(local), store.remote(key), '--ignore-times', '--metadata',
                        '--metadata-set', 'content-type=application/json', '--metadata-set', 'cache-control=no-cache')
    if store.cache_command('cat', store.remote(key)) != data:
        raise RuntimeError(f'Site pointer read-back mismatch: {key}')
    print(f'Verified: {key}', flush=True)


def upload_revision(store, source, key):
    """Copy a content-addressed folder to R2 without replacing anything there, then download-check it."""
    if not source.is_dir():
        raise RuntimeError(f'Release folder missing: {source}')
    remote = store.remote(key)
    # Local development keeps charts under revisions/<rev>/charts/; R2 releases store them as objects.
    skip = ('--filter', '- charts/**', '--filter', '- *.tmp')
    store.run('copy', str(source), remote, *skip, '--filter', '+ *.json.gz', '--filter', '- *',
              '--transfers', '32', '--checkers', '32', '--immutable', '--checksum', '--metadata',
              '--metadata-set', 'content-type=application/gzip', '--metadata-set', IMMUTABLE)
    store.run('copy', str(source), remote, *skip, '--filter', '+ *.json', '--filter', '- *',
              '--transfers', '16', '--checkers', '16', '--immutable', '--checksum', '--metadata',
              '--metadata-set', 'content-type=application/json', '--metadata-set', IMMUTABLE)
    store.run('check', str(source), remote, *skip, '--filter', '+ *.json', '--filter', '+ *.json.gz',
              '--filter', '- *', '--one-way', '--download', '--checkers', '32')


def publish_release(store, output, manifest):
    """Put a published scanner release live in R2. current.json goes last."""
    revision = manifest['revision']
    upload_revision(store, output / 'revisions' / revision, f'releases/{revision}')
    build_ai_filter_choices(output, manifest)
    for name in (AI_FILTER_CHOICES, 'price-band-history.json', 'sessions.json'):
        if (output / name).is_file():
            upload_pointer(store, output, name)
    upload_pointer(store, output, 'current.json')


def publish_site(output, manifest):
    """The last publication step: the AI catalogue locally, or the whole release in R2."""
    if enabled():
        publish_release(R2Store(), output, manifest)
    else:
        if os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2':
            print('::warning::R2 configuration missing (' + ', '.join(missing_r2_settings())
                  + '); the release was written locally only and is not live.', flush=True)
        build_ai_filter_choices(output, manifest)


def push_indexes(store, output=OUTPUT):
    """Publish the Earnings Pulse, heatmap and company pointers that changed in this run."""
    present = stored_pointers(store)
    for name in INDEXES:
        local = output / name
        if not local.is_file():
            continue
        if name in present and store.cache_command('cat', store.remote(f'{POINTER_PREFIX}/{name}')) == local.read_bytes():
            continue
        if name == 'company/current.json':
            revision = json.loads(local.read_text()).get('revision', '')
            if not REVISION.fullmatch(revision):
                raise RuntimeError('Invalid company snapshot revision')
            upload_revision(store, output / 'company' / 'revisions' / revision, f'releases/company/{revision}')
        upload_pointer(store, output, name)


def pull(store, output=OUTPUT):
    """Download the live pointers the pipeline reads and extends (sessions, price-band ledger, indexes).

    Until the cut-over removes them, the checkout still holds committed copies. If those are from a newer session
    than R2 (a Git refresh landed after seeding), they are kept and this run publishes them.
    """
    present = stored_pointers(store)
    if 'current.json' not in present:
        print('No site data in R2 yet; using the checkout copies', flush=True)
        return
    current = output / 'current.json'
    if current.is_file():
        live = json.loads(store.cache_command('cat', store.remote(f'{POINTER_PREFIX}/current.json')))
        if json.loads(current.read_text()).get('sessionDate', '') > live.get('sessionDate', ''):
            print('Checkout data is newer than R2; keeping the checkout copies', flush=True)
            return
    for name in POINTERS:
        if name != AI_FILTER_CHOICES and name in present:
            (output / name).parent.mkdir(parents=True, exist_ok=True)
            store.cache_command('copyto', store.remote(f'{POINTER_PREFIX}/{name}'), str(output / name))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('action', choices=('pull', 'push-indexes', 'push-sessions', 'ai-choices'))
    args = parser.parse_args(argv)
    if args.action == 'ai-choices':
        build_ai_filter_choices(OUTPUT, json.loads((OUTPUT / 'current.json').read_text()))
        return 0
    missing = missing_r2_settings()
    if missing:
        print('Site data in R2 skipped; missing ' + ', '.join(missing), flush=True)
        return 0
    store = R2Store()
    if args.action == 'push-sessions':
        upload_pointer(store, OUTPUT, 'sessions.json')
    else:
        (pull if args.action == 'pull' else push_indexes)(store, OUTPUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
