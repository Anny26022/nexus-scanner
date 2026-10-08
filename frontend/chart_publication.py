"""Bind a scanner release to validated chart objects before exposing current.json.

R2 has no second mutable pointer. Git's current.json is the release authority.
Modern objects/ and releases/ prefixes persist; legacy daily/ expires at 90 days.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import re
from urllib.parse import urlparse


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(payload, separators=(',', ':'), allow_nan=False))
    temporary.replace(path)


R2_SETTINGS = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BASE_URL')


def missing_r2_settings():
    return [key for key in R2_SETTINGS if not os.environ.get(key, '').strip()]


def charts_enabled():
    mode = os.environ.get('EDL_CHART_STORAGE', 'local')
    if mode not in ('local', 'r2'):
        raise RuntimeError('EDL_CHART_STORAGE must be "local" or "r2", got: ' + mode)
    return mode == 'local' or not missing_r2_settings()


def chart_preflight(root, session):
    if not (root / 'index.json').is_file():
        raise RuntimeError('Chart artifacts are missing; run build_chart_artifacts.py before publishing the snapshot')
    index = json.loads((root / 'index.json').read_text())
    if index.get('schemaVersion') == 2:
        hashes = index.get('chartObjects', {})
        files = [root / 'objects' / f'{digest}.json.gz' for digest in hashes.values()]
        if not re.fullmatch(r'[a-f0-9]{64}', str(index.get('announcements', ''))):
            raise RuntimeError('Announcement catalog missing')
        if any(not re.fullmatch(r'[a-f0-9]{64}', str(h)) for h in hashes.values()):
            raise RuntimeError('Invalid chart object hash')
        if any(not file.is_file() for file in files):
            raise RuntimeError('Chart object missing')
    else:
        files = sorted(root.glob('*.json.gz'))
    if index.get('asOfDate') != session or index.get('symbols') != len(files) or not files:
        raise RuntimeError('Chart count/session does not match the scanner release')
    return files


def chart_revision(root, session):
    files = chart_preflight(root, session)
    index = json.loads((root / 'index.json').read_text())
    if index.get('schemaVersion') == 2:
        revision = index.pop('revision')
        computed = hashlib.sha256(json.dumps(index, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if computed != revision:
            raise RuntimeError('Chart index content does not match its revision')
        for file in (root / 'objects').glob('*.json.gz'):
            if file.stem.removesuffix('.json') != file_digest(file):
                raise RuntimeError('Object content does not match its hash: ' + file.name)
        for symbol, digest in index['chartObjects'].items():
            chart = json.loads(gzip.decompress((root / 'objects' / f'{digest}.json.gz').read_bytes()))
            if chart.get('symbol') != symbol or chart.get('schemaVersion') != 2:
                raise RuntimeError('Chart object symbol/schema mismatch')
        validate_announcement_objects(root / 'objects', index['announcements'], session, set(index['chartObjects']))
        return revision
    digest = hashlib.sha256()
    for file in files:
        data = file.read_bytes()
        chart = json.loads(gzip.decompress(data))
        if chart.get('symbol') != file.name.removesuffix('.json.gz') or chart.get('asOfDate') != session:
            raise RuntimeError('Chart payload symbol/session mismatch: ' + file.name)
        digest.update(file.name.encode())
        digest.update(data)
    revision = digest.hexdigest()
    if index.get('revision') and index['revision'] != revision:
        raise RuntimeError('Chart content does not match its revision')
    return revision


def validate_announcement_objects(objects, catalog_hash, session, symbols):
    def read(digest):
        if not re.fullmatch(r'[a-f0-9]{64}', str(digest)):
            raise RuntimeError('Invalid announcement object reference')
        path = objects / f'{digest}.json.gz'
        if not path.is_file():
            raise RuntimeError('Announcement object missing: ' + digest)
        with gzip.open(path, 'rt') as handle:
            return json.load(handle)
    catalog = read(catalog_hash)
    if catalog.get('referenceSession') != session or set(catalog.get('symbols', {})) != symbols:
        raise RuntimeError('Announcement catalog universe/session mismatch')
    read(catalog['taxonomy'])
    index = read(catalog['index'])
    if index.get('referenceSession') != session or index.get('publishedAt') != catalog.get('publishedAt'):
        raise RuntimeError('Announcement index session/time mismatch')
    for symbol, entry in catalog['symbols'].items():
        recent = read(entry['recent'])
        if recent.get('symbol') != symbol:
            raise RuntimeError('Recent announcements symbol mismatch')
        for year, pages in entry['years'].items():
            for page in pages:
                summaries, details = read(page['summary']), read(page['details'])
                if summaries.get('symbol') != symbol or str(summaries.get('year')) != year or details.get('symbol') != symbol:
                    raise RuntimeError('Announcement history symbol/year mismatch')
                rows = summaries.get('records', [])
                if len(rows) != page['count'] or any(row['id'] not in details.get('records', {}) or row['detailPage'] != page['details'] for row in rows):
                    raise RuntimeError('Announcement summary/evidence mismatch')
        detail_hashes = {page['details'] for pages in entry['years'].values() for page in pages}
        if any(row['detailPage'] not in detail_hashes for row in recent.get('records', [])):
            raise RuntimeError('Recent announcement evidence unavailable')
    if any(row.get('symbol') not in symbols for row in index.get('records', [])):
        raise RuntimeError('Announcement index contains a different universe')


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_archives(chart_root):
    """Back up complete histories without loading another full archive in memory."""
    root = chart_root.parent
    archives = {}
    inputs = {'classified': root / 'filing_history.json.gz',
              'raw': root / 'filing_history_data' / 'filing_history.json'}
    for name, source in inputs.items():
        if not source.is_file():
            continue  # Small diagnostic/fixture builds may have no retained archive.
        with tempfile.TemporaryDirectory(dir=chart_root) as folder:
            temporary = Path(folder) / 'archive.json.gz'
            opener = gzip.open if source.suffix == '.gz' else open
            with opener(source, 'rb') as incoming, temporary.open('wb') as outgoing:
                with gzip.GzipFile(fileobj=outgoing, mode='wb', mtime=0, filename='') as packed:
                    shutil.copyfileobj(incoming, packed)
            digest = file_digest(temporary)
            destination = chart_root / 'objects' / f'{digest}.json.gz'
            if not destination.exists():
                destination.parent.mkdir(exist_ok=True)
                temporary.replace(destination)
            archives[name] = digest
    return archives


class R2Store:
    def __init__(self):
        missing = missing_r2_settings()
        if missing:
            raise RuntimeError('R2 publication requires: ' + ', '.join(missing))
        self.base_url = os.environ['R2_PUBLIC_BASE_URL'].rstrip('/')
        if urlparse(self.base_url).scheme != 'https':
            raise RuntimeError('R2_PUBLIC_BASE_URL must be an HTTPS delivery URL')
        self.bucket = os.environ.get('R2_BUCKET', 'nexus-screener-chart-data')
        # rclone reads credentials from environment; no credential file or CLI arguments.
        self.env = dict(os.environ, RCLONE_CONFIG_CHARTS_TYPE='s3',
                        RCLONE_CONFIG_CHARTS_PROVIDER='Cloudflare',
                        RCLONE_CONFIG_CHARTS_ACCESS_KEY_ID=os.environ['R2_ACCESS_KEY_ID'],
                        RCLONE_CONFIG_CHARTS_SECRET_ACCESS_KEY=os.environ['R2_SECRET_ACCESS_KEY'],
                        RCLONE_CONFIG_CHARTS_ENDPOINT='https://' + os.environ['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com',
                        RCLONE_CONFIG_CHARTS_REGION='auto')

    def run(self, *args):
        subprocess.run(['rclone', *args, '--s3-no-check-bucket'], env=self.env, check=True)

    def remote(self, key):
        return f'charts:{self.bucket}/{key}'

    def upload_charts(self, source, key):
        # Application/gzip bytes are explicitly decompressed by the browser.
        self.run('copy', str(source), self.remote(key), '--include', '*.json.gz',
                 '--transfers', '16', '--metadata', '--metadata-set', 'content-type=application/gzip',
                 '--metadata-set', 'cache-control=public,max-age=31536000,immutable', '--immutable', '--checksum')
        self.run('check', str(source), self.remote(key), '--include', '*.json.gz', '--one-way', '--download')
        self.run('copyto', str(source / 'index.json'), self.remote(key + '/index.json'), '--immutable', '--checksum')

    def upload_objects(self, source):
        """List once; transfer and read back only new content-addressed files."""
        remote = self.remote('objects')
        listing = subprocess.run(['rclone', 'lsf', remote, '--files-only', '--format', 'ps',
                                  '--separator', '\t', '--s3-no-check-bucket'],
                                 env=self.env, check=True, capture_output=True, text=True)
        existing = {}
        for line in listing.stdout.splitlines():
            name, size = line.rsplit('\t', 1)
            existing[name] = int(size)
        new = []
        for file in source.glob('*.json.gz'):
            if file.name in existing:
                if existing[file.name] != file.stat().st_size:
                    raise RuntimeError('Immutable remote object has a different size: ' + file.name)
            else:
                new.append(file.name)
        if not new:
            return
        with tempfile.TemporaryDirectory() as folder:
            names = Path(folder) / 'new.txt'
            names.write_text('\n'.join(sorted(new)) + '\n')
            self.run('copy', str(source), remote, '--files-from', str(names), '--transfers', '16',
                     '--immutable', '--checksum', '--metadata', '--metadata-set', 'content-type=application/gzip',
                     '--metadata-set', 'cache-control=public,max-age=31536000,immutable')
            self.run('check', str(source), remote, '--files-from', str(names), '--one-way', '--download')

    def archive(self, previous, month):
        source = previous['chartObjectPrefix']
        target = f'monthly/{month}/{previous["chartRevision"]}/charts'
        self.run('copy', self.remote(source), self.remote(target), '--immutable', '--checksum')
        self.run('check', self.remote(source), self.remote(target), '--one-way', '--download')
        archived = dict(previous, chartObjectPrefix=target,
                        chartUrlTemplate=f'{self.base_url}/{target}/{{symbol}}.json.gz')
        self.write_release(archived, f'monthly/{month}/{previous["chartRevision"]}/releases/{previous["revision"]}.json')
        return archived

    def write_release(self, manifest, key):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'release.json'
            write_json(file, manifest)
            self.run('copyto', str(file), self.remote(key), '--immutable', '--checksum')


def complete_release(chart_root, output, manifest, store=None):
    """Failed uploads/archival leave the previous browser pointer intact."""
    if store is None and not charts_enabled():
        print('WARNING: R2 configuration missing (' + ', '.join(missing_r2_settings()) + '); publishing scanner data without charts.', flush=True)
        manifest = dict(manifest, schemaVersion=max(4, int(manifest.get('schemaVersion', 4))) if manifest.get('packs') else 4)
        for key in ('chartRevision', 'chartUrlTemplate', 'chartObjectPrefix', 'dataIndexUrl', 'objectUrlTemplate'):
            manifest.pop(key, None)
        write_json(output / 'revisions' / manifest['revision'] / 'release.json', manifest)
        write_json(output / 'current.json', manifest)
        return manifest
    index = json.loads((chart_root / 'index.json').read_text()) if (chart_root / 'index.json').exists() else {}
    if index.get('schemaVersion') == 2:
        return complete_object_release(chart_root, output, manifest, store)
    revision = chart_revision(chart_root, manifest['sessionDate'])
    manifest = dict(manifest, schemaVersion=max(6, int(manifest.get('schemaVersion', 6))), chartRevision=revision)
    existing_release = output / 'revisions' / manifest['revision'] / 'release.json'
    if existing_release.exists():
        existing = json.loads(existing_release.read_text())
        if existing.get('sessionDate') != manifest['sessionDate'] or existing.get('chartRevision') != revision:
            raise RuntimeError('Scanner revision already binds different chart data')
        if existing.get('publishedAt'):
            manifest['publishedAt'] = existing['publishedAt']
    if store is None and os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2':
        store = R2Store()
    if store:
        previous_path = output / 'current.json'
        previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
        if previous and previous['sessionDate'] > manifest['sessionDate']:
            raise RuntimeError('Refusing to publish an older session over the current release')
        if previous and previous['sessionDate'][:7] < manifest['sessionDate'][:7]:
            if previous.get('chartObjectPrefix'):
                archived = store.archive(previous, previous['sessionDate'][:7])
                write_json(output / 'revisions' / previous['revision'] / 'release.json', archived)
        # Stable across fresh runners retrying after upload but before the Git commit.
        manifest['publishedAt'] = manifest['sessionDate'] + 'T00:00:00Z'
        key = f'daily/{manifest["sessionDate"]}/{revision}/charts'
        manifest.update(chartObjectPrefix=key, chartUrlTemplate=f'{store.base_url}/{key}/{{symbol}}.json.gz')
        store.upload_charts(chart_root, key)
        # Release metadata is independent of chart revision: scanner corrections
        # can reuse identical chart bytes while receiving a new scanner revision.
        store.write_release(manifest, f'daily/{manifest["sessionDate"]}/{revision}/releases/{manifest["revision"]}.json')
    else:
        # Local development uses an ignored chart cache, outside Git revisions.
        destination = output / 'charts' / revision
        if not destination.exists():
            with tempfile.TemporaryDirectory(dir=output) as folder:
                incoming = Path(folder) / 'charts'
                shutil.copytree(chart_root, incoming)
                destination.parent.mkdir(parents=True, exist_ok=True)
                incoming.replace(destination)
        manifest['chartUrlTemplate'] = f'/data/charts/{revision}/{{symbol}}.json.gz'
    write_json(output / 'revisions' / manifest['revision'] / 'release.json', manifest)
    write_json(output / 'current.json', manifest)
    return manifest


def complete_object_release(chart_root, output, manifest, store=None):
    revision = chart_revision(chart_root, manifest['sessionDate'])
    index = json.loads((chart_root / 'index.json').read_text())
    previous_path = output / 'current.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
    if previous and previous['sessionDate'] > manifest['sessionDate']:
        raise RuntimeError('Refusing to publish an older session over the current release')
    manifest = dict(manifest, schemaVersion=7, chartRevision=revision)
    existing_path = output / 'revisions' / manifest['revision'] / 'release.json'
    if existing_path.exists():
        existing = json.loads(existing_path.read_text())
        if existing.get('chartRevision') != revision:
            raise RuntimeError('Scanner revision already binds different chart data')
        if existing.get('publishedAt'):
            manifest['publishedAt'] = existing['publishedAt']
    if store is None and os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2':
        store = R2Store()
    archives = prepare_archives(chart_root)
    index = dict(index, archives=archives)
    if store:
        base = store.base_url
        store.upload_objects(chart_root / 'objects')
        manifest['publishedAt'] = manifest['sessionDate'] + 'T00:00:00Z'
        manifest['dataIndexUrl'] = f"{base}/releases/{manifest['revision']}/index.json"
        manifest['objectUrlTemplate'] = f'{base}/objects/{{hash}}.json.gz'
        # Write references only after every object was uploaded and verified.
        store.write_release(index, f"releases/{manifest['revision']}/index.json")
        store.write_release(manifest, f"releases/{manifest['revision']}/release.json")
    else:
        destination = output / 'objects'
        destination.mkdir(exist_ok=True, parents=True)
        for file in (chart_root / 'objects').glob('*.json.gz'):
            target = destination / file.name
            if target.exists():
                if file_digest(target) != file.stem.removesuffix('.json'):
                    raise RuntimeError('Local immutable object content mismatch')
            else:
                shutil.copyfile(file, target)
        manifest['dataIndexUrl'] = f"/data/revisions/{manifest['revision']}/data-index.json"
        manifest['objectUrlTemplate'] = '/data/objects/{hash}.json.gz'
    write_json(output / 'revisions' / manifest['revision'] / 'data-index.json', index)
    write_json(existing_path, manifest)
    write_json(output / 'current.json', manifest)
    return manifest
