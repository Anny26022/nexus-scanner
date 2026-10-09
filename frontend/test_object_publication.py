import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parent.parent / 'DO NOT DELETE EDL PIPELINE'
sys.path.insert(0, str(ROOT))
from announcement_artifacts import put_object
import build_chart_artifacts as builder
from chart_publication import complete_release, R2Store, prepare_archives
from filing_archives import prepare_filing_archives


class ObjectStore:
    base_url = 'https://charts.example.com'
    def __init__(self):
        self.objects = {}
        self.references = {}
        self.uploaded = []
        self.fail = False
    def upload_objects(self, source):
        if self.fail:
            raise RuntimeError('object upload failed')
        for path in source.glob('*.json.gz'):
            data = path.read_bytes()
            if path.name not in self.objects:
                self.uploaded.append(path.name)
                self.objects[path.name] = data
            else:
                assert self.objects[path.name] == data
    def write_release(self, value, key):
        if key in self.references:
            assert self.references[key] == value
        self.references[key] = value


class ObjectPublicationTests(unittest.TestCase):
    def build(self, root, day):
        (root / 'all_stocks_fundamental_analysis.json').write_text(json.dumps([{'symbol': 'TEST', 'as_of_date': day}]))
        with patch.object(builder, 'BASE_DIR', str(root)):
            builder.main()
        return root / 'chart_artifacts'

    def test_releases_reuse_unchanged_objects_and_publish_archive_references(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            raw = {'symbols': {'TEST': {'filings': []}}}
            (root / 'filing_history_data').mkdir()
            (root / 'filing_history_data/filing_history.json').write_text(json.dumps(raw))
            (root / 'filing_history.json.gz').write_bytes(gzip.compress(json.dumps({'records': []}).encode()))
            store = ObjectStore()
            first = complete_release(self.build(root, '2026-10-06'), output, {'revision': 'a'*64, 'sessionDate': '2026-10-06'}, store)
            index = store.references['releases/' + 'a'*64 + '/index.json']
            self.assertEqual(set(index['archives']), {'raw', 'classified'})
            chart_hash = index['chartObjects']['TEST']
            before = store.uploaded.count(chart_hash + '.json.gz')
            second = complete_release(self.build(root, '2026-10-07'), output, {'revision': 'b'*64, 'sessionDate': '2026-10-07'}, store)
            self.assertEqual(store.uploaded.count(chart_hash + '.json.gz'), before)
            self.assertEqual(second['schemaVersion'], 7)
            self.assertNotIn('chartUrlTemplate', second)
            self.assertIn('/objects/{hash}', second['objectUrlTemplate'])
            self.assertEqual(first['objectUrlTemplate'], second['objectUrlTemplate'])
            store.fail = True
            previous = (output / 'current.json').read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'object upload'):
                complete_release(self.build(root, '2026-10-07'), output, {'revision': 'c'*64, 'sessionDate': '2026-10-07'}, store)
            self.assertEqual((output / 'current.json').read_bytes(), previous)

    def test_local_consumer_can_resolve_every_reference_after_staging_is_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            chart_root = self.build(root, '2026-10-07')
            release = complete_release(chart_root, output, {'revision': 'a'*64, 'sessionDate': '2026-10-07'})
            index = json.loads((output / 'revisions' / ('a'*64) / 'data-index.json').read_text())
            import shutil
            shutil.rmtree(chart_root)
            for digest in [*index['chartObjects'].values(), index['announcements']]:
                json.loads(gzip.decompress((output / 'objects' / (digest + '.json.gz')).read_bytes()))
            self.assertTrue(release['dataIndexUrl'].endswith('/data-index.json'))

    def test_backup_hashes_ignore_gzip_header_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); charts = root / 'chart_artifacts'; charts.mkdir()
            (root / 'filing_history.json.gz').write_bytes(gzip.compress(b'{"records":[]}', mtime=10))
            first = prepare_archives(charts)
            (root / 'filing_history.json.gz').write_bytes(gzip.compress(b'{"records":[]}', mtime=20))
            self.assertEqual(first, prepare_archives(charts))

    def test_prepared_raw_input_archives_keep_original_gzip_bytes_and_reject_corruption(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); charts = root / 'chart_artifacts'; charts.mkdir()
            classified = json.dumps({'records': [{'text': '₹😃' * 10000}]}).encode()
            (root / 'filing_history.json').write_bytes(classified)
            (root / 'filing_history.json.gz').write_bytes(gzip.compress(classified, mtime=20))
            (root / 'filing_history_data').mkdir()
            (root / 'filing_history_data/filing_history.json').write_bytes(b'{"symbols":{}}')
            expected = prepare_archives(charts)
            before = {digest: (charts / 'objects' / (digest + '.json.gz')).read_bytes() for digest in expected.values()}
            prepared = charts / '.prepared_archives'
            self.assertEqual(prepare_filing_archives(root, prepared), expected)
            with patch('chart_publication.gzip.GzipFile', side_effect=AssertionError('recompressed')):
                self.assertEqual(prepare_archives(charts), expected)
            for digest, data in before.items():
                self.assertEqual((charts / 'objects' / (digest + '.json.gz')).read_bytes(), data)
            (prepared / (expected['classified'] + '.json.gz')).write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'content does not match'):
                prepare_archives(charts)

    def test_r2_transfers_and_verifies_only_missing_objects(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = put_object(root, {'old': 1}); new = put_object(root, {'new': 1})
            store = R2Store.__new__(R2Store); store.env = {}; store.bucket = 'test'
            calls = []
            def run(*args):
                names = Path(args[args.index('--files-from') + 1]).read_text().splitlines()
                calls.append((args[0], names))
            store.run = run
            listing = f'{old}.json.gz\t{(root / (old + ".json.gz")).stat().st_size}\n'
            with patch('chart_publication.subprocess.run', return_value=Mock(stdout=listing)):
                store.upload_objects(root)
            self.assertEqual(calls, [('copy', [new + '.json.gz']), ('check', [new + '.json.gz'])])
            with patch('chart_publication.subprocess.run', return_value=Mock(stdout=f'{old}.json.gz\t1\n')):
                with self.assertRaisesRegex(RuntimeError, 'different size'):
                    store.upload_objects(root)
