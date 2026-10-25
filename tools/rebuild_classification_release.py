"""Rebuild classification projections from a frozen stock snapshot, without fetching market data.

Creates a new immutable scanner revision; market prices and their dates are preserved. Rotation must
be rebuilt by the normal publisher, or tools/build_rotation_local.py for an explicitly dated local preview.
No remote uploads or deployments are performed.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'frontend'))
from classification_contract import validate_classification_release, review_primary_classifications, project_company_classifications
from packed_snapshot import pack_snapshot
from public_payload import public
from market_overview import stock_sectors
from theme_classification import classify, consolidated_classification


def encoded(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(gzip.compress(encoded(value), mtime=0) if path.name.endswith('.gz') else encoded(value))
    temporary.replace(path)


def restore_projection(output, manifest):
    """Recover corruption from identical-version Git history, never reclassify an old release."""
    generation = output / 'revisions' / manifest['revision']
    path = generation / 'theme-classification.json.gz'
    actual = json.loads(gzip.decompress(path.read_bytes()))
    combined = json.loads((generation / 'universe-classification.json').read_text())
    if (actual['version'] == manifest['themeClassificationVersion'] and
            all(r == combined['records'][s]['thematic'] for s, r in actual['records'].items())):
        return False
    relative = path.resolve().relative_to(ROOT)
    commits = subprocess.check_output(['git', 'log', '--format=%H', '--', str(relative)], cwd=ROOT, text=True).splitlines()
    for commit in commits:
        data = subprocess.check_output(['git', 'show', f'{commit}:{relative}'], cwd=ROOT)
        candidate = json.loads(gzip.decompress(data))
        if (candidate['version'] == manifest['themeClassificationVersion'] and
                candidate['asOfDate'] == manifest['sessionDate'] and
                set(candidate['records']) == set(combined['records']) and
                all(r == combined['records'][s]['thematic'] for s, r in candidate['records'].items())):
            temporary = path.with_name(path.name + '.tmp'); temporary.write_bytes(data); temporary.replace(path)
            print(f'Restored exact original classification asset for {manifest["revision"][:12]} from {commit[:12]}')
            return True
    raise ValueError('No identical-version classification asset found; refusing to rewrite an old taxonomy')


def rebuild(output):
    previous = json.loads((output / 'current.json').read_text())
    for release_path in sorted((output / 'revisions').glob('*/release.json')):
        release = json.loads(release_path.read_text())
        if release.get('themeClassificationVersion'):
            restore_projection(output, release)
            validate_classification_release(output, release)
    base = output / 'revisions' / previous['revision']
    payload = json.loads(gzip.decompress((base / 'stocks.json.gz').read_bytes()))
    original_companies = encoded(payload['stocks'])
    business = json.loads((ROOT / 'DO NOT DELETE EDL PIPELINE/taxonomy_overrides.json').read_text())
    payload['stocks'] = review_primary_classifications(payload['stocks'], business)
    taxonomy = public(classify(payload['stocks'], previous['sessionDate']))
    if (previous.get('classificationSchemaVersion') == 2 and previous.get('themeClassificationVersion') == taxonomy['version']
            and encoded(payload['stocks']) == original_companies
            and (not previous.get('marketOverviewUrl') or previous.get('marketClassificationVersion') == taxonomy['version'])):
        validate_classification_release(output, previous)
        return previous
    payload['classificationVersion'] = taxonomy['version']
    revision = hashlib.sha256(b'classification-release-v2\n' + previous['revision'].encode() + encoded(payload)).hexdigest()
    payload['revision'] = revision
    generation_url = f'/data/revisions/{revision}'
    manifest = dict(previous, revision=revision, datasetUrl=f'{generation_url}/stocks.json',
                    datasetGzipUrl=f'{generation_url}/stocks.json.gz', datasetPackedGzipUrl=f'{generation_url}/stocks.packed.json.gz',
                    chartDirectoryUrl=f'{generation_url}/chart-directory.json.gz',
                    iposUrl=f'{generation_url}/ipos.json.gz',
                    themeClassificationUrl=f'{generation_url}/theme-classification.json.gz',
                    themeClassificationVersion=taxonomy['version'], classificationSchemaVersion=2,
                    universeClassificationUrl=f'{generation_url}/universe-classification.json')
    # Old composites must never be presented as using the new memberships.
    manifest.pop('rotationHistoryObject', None)
    manifest.pop('rotationUrlTemplate', None)
    directory = json.loads(gzip.decompress((base / 'chart-directory.json.gz').read_bytes()))
    directory['revision'] = revision
    by_symbol = {r['symbol']:r for r in payload['stocks']}
    for row in directory['stocks']:
        row.update(sector=by_symbol[row['symbol']]['sector'], industry=by_symbol[row['symbol']]['industry'])
    combined = consolidated_classification(payload['stocks'], taxonomy)
    ipo_path = output.parent / previous['iposUrl'].lstrip('/')
    ipos = json.loads(gzip.decompress(ipo_path.read_bytes()))
    ipos['records'] = project_company_classifications(ipos['records'], payload['stocks'])
    market = None
    if previous.get('marketOverviewUrl'):
        market = json.loads(gzip.decompress((output.parent / previous['marketOverviewUrl'].lstrip('/')).read_bytes()))
        market['sectors'] = stock_sectors(payload['stocks'])
        manifest['marketOverviewUrl'] = f'{generation_url}/market-overview.json.gz'
        manifest['marketClassificationVersion'] = taxonomy['version']
    with tempfile.TemporaryDirectory(prefix='.classification-', dir=output) as folder:
        staged_output = Path(folder)
        staged = staged_output / 'revisions' / revision
        for name, value in {'stocks.json':payload, 'stocks.json.gz':payload,
                            'stocks.packed.json.gz':pack_snapshot(payload), 'chart-directory.json.gz':directory,
                            'theme-classification.json.gz':taxonomy, 'universe-classification.json':combined,
                            'ipos.json.gz':ipos,
                            'release.json':manifest}.items():
            write(staged / name, value)
        if market is not None:
            write(staged / 'market-overview.json.gz', market)
        validate_classification_release(staged_output, manifest)
        destination = output / 'revisions' / revision
        if destination.exists():
            validate_classification_release(output, manifest)
        else:
            staged.replace(destination)
    write(output / 'universe-classification.json', combined)
    write(output / 'current.json', manifest)
    print(f'Classification release {revision}: {len(payload["stocks"])} stocks; {taxonomy["coverage"]}')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'frontend/public/data')
    args = parser.parse_args()
    rebuild(args.output)
