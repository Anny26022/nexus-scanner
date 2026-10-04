"""Bind a scanner release to validated chart objects before exposing current.json.

R2 has no second mutable pointer. Git's current.json is the release authority.
The daily/ prefix expires at 90 days; monthly/ has no expiration rule.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
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
    files = sorted(root.glob('*.json.gz'))
    if index.get('asOfDate') != session or index.get('symbols') != len(files) or not files:
        raise RuntimeError('Chart count/session does not match the scanner release')
    return files


def chart_revision(root, session):
    files = chart_preflight(root, session)
    index = json.loads((root / 'index.json').read_text())
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
        manifest = dict(manifest, schemaVersion=4)
        for key in ('chartRevision', 'chartUrlTemplate', 'chartObjectPrefix'):
            manifest.pop(key, None)
        write_json(output / 'revisions' / manifest['revision'] / 'release.json', manifest)
        write_json(output / 'current.json', manifest)
        return manifest
    revision = chart_revision(chart_root, manifest['sessionDate'])
    manifest = dict(manifest, schemaVersion=6, chartRevision=revision)
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
