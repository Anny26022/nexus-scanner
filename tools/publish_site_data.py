"""Publish frontend data files to R2 under releases/ and daily/journal/ with pointer-last atomicity.

Nexus Journal's embedded scanner can read this layout (its "r2" data layout) instead of this site's /data static
files. This repository's daily and weekly refreshes run it after committing their results, until the journal's own
pipeline takes over; this site keeps serving the committed files as before. Ported from the journal's
scanner/tools/publish_site_data.py, plus the check that the release is in R2 before the pointer moves.

1. Release files (data_dir / 'revisions' / <rev> / ...) are uploaded to r2:releases/<rev>/...
   and verified via SHA-256. These receive 1-year immutable edge caching from Cloudflare.
2. Dynamic journal dataset files (sessions, price bands, heatmap, results indexes) are
   uploaded to r2:daily/journal/... and verified.
3. The AI screener's filter catalogue (ai-filter-choices.json) is built from the release current.json points at
   and uploaded to r2:daily/journal/, so the AI endpoint accepts screens built against this release.
4. Only when all supporting data and release files are confirmed in R2 is current.json
   atomically published to r2:daily/journal/current.json.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'frontend' / 'public' / 'data'
DAILY_PREFIX = 'daily/journal'
RELEASES_PREFIX = 'releases'

STATIC_SITE_FILES = (
    'sessions.json',
    'price-band-history.json',
    'results/index.json',
    'results/us_index.json',
    'heatmap/index.json',
    'company/current.json',
)
POINTER_FILE = 'current.json'
AI_FILTER_CHOICES = 'ai-filter-choices.json'
# Filter id -> stock field, as in nexus-scanner's frontend/build_ai_filter_choices.mjs.
AI_CHOICE_FIELDS = {'SECTOR': 'sector', 'INDUSTRY': 'industry', 'SERIES': 'series', 'PRICE_BAND': 'circuitLimit',
                    'INDEX_MEMBERSHIP': 'indexMemberships'}

sys.path.insert(0, str(ROOT / 'frontend'))
from chart_publication import R2Store, missing_r2_settings


def build_ai_filter_choices(data_dir, manifest):
    """Write the AI screener's filter catalogue for the release `manifest` points at; return its path.

    A port of nexus-scanner's frontend/build_ai_filter_choices.mjs, which there runs in the site build. The AI
    endpoint compares the catalogue's revision with the dataset the browser sends, so it is built from this release.
    """
    revision = manifest.get('revision')
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{64}', revision):
        raise RuntimeError('Invalid AI catalogue revision')
    release = data_dir / 'revisions' / revision
    compressed, plain = release / 'stocks.json.gz', release / 'stocks.json'
    raw = gzip.decompress(compressed.read_bytes()) if compressed.exists() else plain.read_bytes()
    snapshot = json.loads(raw)
    if snapshot.get('revision') != revision or not isinstance(snapshot.get('stocks'), list):
        raise RuntimeError('AI catalogue dataset mismatch')
    stocks = snapshot['stocks']

    def values(stock, field):
        value = stock.get(field)
        return value if isinstance(value, list) else [value]

    choices = {
        filter_id: sorted({v.strip().upper() for stock in stocks for v in values(stock, field)
                           if isinstance(v, str) and v.strip()})
        for filter_id, field in AI_CHOICE_FIELDS.items()
    }
    choices['TRADINGVIEW_METRIC'] = sorted({
        metric for stock in stocks
        for tv in (stock.get('extended'), stock.get('tradingview'))
        if isinstance(tv, dict) and tv.get('asOfDate') == snapshot.get('asOfDate')
        for metric, value in (tv.get('values') or {}).items()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    })
    target = data_dir / AI_FILTER_CHOICES
    target.write_text(json.dumps({'revision': revision, 'sessionDate': manifest.get('sessionDate'), 'choices': choices},
                                 ensure_ascii=False, separators=(',', ':')))
    return target


def manifest_release_files(manifest):
    """The release files current.json links to, relative to releases/<revision>/ (per-symbol templates excluded)."""
    revision = manifest.get('revision')
    prefix = f'/data/revisions/{revision}/'
    return sorted({value[len(prefix):] for key, value in manifest.items()
                   if key.endswith('Url') and isinstance(value, str) and value.startswith(prefix)})


def require_release_in_r2(store, manifest):
    """Stop before the pointer unless R2 holds every release file it links to.

    Without this, a run with no local release folder (step 2 uploads nothing) still moved the pointer to a
    release R2 doesn't have, and the journal's screener failed with "Snapshot request failed (HTTP 404)".
    """
    revision = manifest.get('revision')
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{64}', revision):
        raise RuntimeError('Invalid release revision in current.json')
    listed = store.cache_command('lsf', '-R', '--files-only', store.remote(f'{RELEASES_PREFIX}/{revision}'))
    present = set(listed.decode().splitlines())
    missing = [name for name in manifest_release_files(manifest) if name not in present]
    if missing:
        raise RuntimeError(f'Release {revision[:12]} is missing from R2 ({", ".join(missing)}); pointer not updated')


def get_store():
    missing = missing_r2_settings()
    if missing:
        print('Publish site data to R2 skipped; missing ' + ', '.join(missing), flush=True)
        return None
    return R2Store()


def verify_and_upload(store, local_path, r2_key):
    data = local_path.read_bytes()
    # These files sit under daily/, which the bucket's lifecycle rule expires 90 days after an object was written.
    # rclone skips a file whose size and time match, and pipeline_state.pull downloads them with R2's time, so an
    # unchanged file would never be rewritten and would expire. --ignore-times rewrites it on every run.
    store.run('copyto', str(local_path), store.remote(r2_key), '--ignore-times')
    read_back = store.cache_command('cat', store.remote(r2_key))
    if hashlib.sha256(read_back).digest() != hashlib.sha256(data).digest():
        raise RuntimeError(f"Verification checksum mismatch for {r2_key}")


def upload_release_bundle(store, data_dir, revision):
    """Upload immutable release files from revisions/<rev>/ to releases/<rev>/ via fast bulk copy."""
    rev_dir = data_dir / 'revisions' / revision
    if not rev_dir.is_dir():
        print(f"Notice: No local revision folder found at {rev_dir}", flush=True)
        return 0

    target = store.remote(f"{RELEASES_PREFIX}/{revision}")
    files = sorted([p for p in rev_dir.rglob('*') if p.is_file()])
    if not files:
        return 0
    print(f"Uploading {len(files)} release bundle files for revision {revision[:12]} via bulk copy...", flush=True)
    # 1. Bulk copy gzipped data files with gzip content-type
    store.run('copy', str(rev_dir), target,
              '--include', '*.json.gz',
              '--transfers', '32', '--checkers', '32', '--checksum', '--immutable',
              '--metadata', '--metadata-set', 'content-type=application/gzip',
              '--metadata-set', 'cache-control=public,max-age=31536000,immutable')
    # 2. Bulk copy json files with json content-type
    store.run('copy', str(rev_dir), target,
              '--include', '*.json',
              '--transfers', '16', '--checkers', '16', '--checksum', '--immutable',
              '--metadata', '--metadata-set', 'content-type=application/json',
              '--metadata-set', 'cache-control=public,max-age=31536000,immutable')
    # 3. Fast download verification
    store.run('check', str(rev_dir), target, '--one-way', '--download', '--checkers', '32')
    print(f"Verified and uploaded {len(files)} release files to {RELEASES_PREFIX}/{revision[:12]}/", flush=True)
    return len(files)


def upload_company_revisions(store, data_dir):
    """Upload company overview revisions to releases/company/<rev>/.

    Like scanner releases they are named by content hash, so they sit with them: cached as immutable at the edge and
    outside daily/, whose bucket lifecycle rule would expire a revision that stays current for 90 days.
    """
    company_rev_dir = data_dir / 'company' / 'revisions'
    if not company_rev_dir.is_dir():
        return 0
    target = store.remote(f"{RELEASES_PREFIX}/company")
    files = sorted([p for p in company_rev_dir.rglob('*.json.gz') if p.is_file()])
    if not files:
        return 0
    print(f"Uploading {len(files)} company revision file(s) to {RELEASES_PREFIX}/company/...", flush=True)
    store.run('copy', str(company_rev_dir), target,
              '--include', '*.json.gz',
              '--transfers', '16', '--checkers', '16', '--checksum', '--immutable',
              '--metadata', '--metadata-set', 'content-type=application/gzip',
              '--metadata-set', 'cache-control=public,max-age=31536000,immutable')
    store.run('check', str(company_rev_dir), target, '--include', '*.json.gz', '--one-way', '--download', '--checkers', '16')
    print(f"Verified and uploaded {len(files)} company revision files to {RELEASES_PREFIX}/company/", flush=True)
    return len(files)


def publish(store, data_dir=DATA_DIR, daily_prefix=DAILY_PREFIX):
    uploaded = 0

    # 1. Read pointer to discover active revision bundle
    pointer_path = data_dir / POINTER_FILE
    revision = None
    current_data = None
    if pointer_path.exists():
        try:
            current_data = json.loads(pointer_path.read_text())
            revision = current_data.get('revision')
        except Exception as error:
            print(f"Warning: could not parse {POINTER_FILE}: {error}", flush=True)

    # 2. Upload immutable release files first (stocks.packed.json.gz, etc.)
    if revision:
        uploaded += upload_release_bundle(store, data_dir, revision)

    # 3. Upload company revision overviews
    uploaded += upload_company_revisions(store, data_dir)

    # 4. Upload dynamic site datasets to daily/journal/
    print("Uploading static release datasets...", flush=True)
    for name in STATIC_SITE_FILES:
        local = data_dir / name
        if not local.exists():
            continue
        if name == 'company/current.json':
            try:
                comp_info = json.loads(local.read_text())
                c_rev = comp_info.get('revision')
                if c_rev:
                    c_key = f"{RELEASES_PREFIX}/company/{c_rev}/overviews.json.gz"
                    local_c_rev = data_dir / 'company' / 'revisions' / c_rev / 'overviews.json.gz'
                    if local_c_rev.is_file():
                        store.run('copyto', str(local_c_rev), store.remote(c_key),
                                  '--metadata', '--metadata-set', 'content-type=application/gzip',
                                  '--metadata-set', 'cache-control=public,max-age=31536000,immutable')
                        print(f"Verified and uploaded company revision: {c_key}", flush=True)
                    else:
                        try:
                            read_back = store.cache_command('cat', store.remote(c_key))
                            if not read_back:
                                raise ValueError('empty')
                        except Exception:
                            print(f"Warning: {c_key} missing in R2 and locally; skipping {name} to prevent 404s", flush=True)
                            continue
            except Exception as error:
                print(f"Warning checking company revision: {error}", flush=True)
        key = f"{daily_prefix}/{name}"
        verify_and_upload(store, local, key)
        print(f"Verified: {key}", flush=True)
        uploaded += 1

    # 5. The AI filter catalogue for this release. A failure stops here, so the pointer and catalogue never disagree.
    #    Without the release folder (as in step 2) the release, and its catalogue, were published by an earlier run.
    if revision and (data_dir / 'revisions' / revision).is_dir():
        key = f"{daily_prefix}/{AI_FILTER_CHOICES}"
        verify_and_upload(store, build_ai_filter_choices(data_dir, current_data), key)
        print(f"Verified: {key}", flush=True)
        uploaded += 1

    # 6. Strictly last: upload current.json pointer, once R2 holds the release it links to
    if pointer_path.exists():
        if revision:
            require_release_in_r2(store, current_data)
        key = f"{daily_prefix}/{POINTER_FILE}"
        verify_and_upload(store, pointer_path, key)
        print(f"Atomic pointer published: {key}", flush=True)
        uploaded += 1
    else:
        print(f"Warning: {POINTER_FILE} not found in {data_dir}; pointer not updated", flush=True)

    return uploaded


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.parse_args(argv)
    store = get_store()
    if store is None:
        return 0
    try:
        count = publish(store)
        print(f"Successfully published {count} dataset files to R2", flush=True)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"R2 publish failed: {error}") from error
    return 0


if __name__ == '__main__':
    sys.exit(main())
