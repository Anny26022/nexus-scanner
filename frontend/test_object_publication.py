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
from chart_publication import complete_release, R2Store, prepare_archives, validate_announcement_objects
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
    def test_company_financial_objects_reuse_numbers_and_publish_both_bases(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            store = ObjectStore()
            history = {'source': 'ScanX', 'report_type': 'CONSOLIDATED', 'observed_on': '2026-10-06',
                       'amount_unit': 'INR_CRORE', 'metric_units': {'eps': 'INR_PER_SHARE'},
                       'quarterly': [{'period_end': '2026-06-30', 'sales': 132.9}],
                       'standalone': {'report_type': 'STANDALONE', 'observed_on': '2026-10-06',
                                      'quarterly': [{'period_end': '2026-06-30', 'sales': 90}]}}
            hashes = []
            for revision, observed, sales in [('a'*64, '2026-10-06', 132.9),
                                               ('b'*64, '2026-10-07', 132.9),
                                               ('c'*64, '2026-10-08', 133.1)]:
                generation = output / 'revisions' / revision; generation.mkdir(parents=True)
                history['observed_on'] = history['standalone']['observed_on'] = observed
                history['quarterly'][0]['sales'] = sales
                (generation / 'financial-history.json.gz').write_bytes(gzip.compress(json.dumps({'TEST': history}).encode()))
                frozen = root / '.scanner_cache/revisions' / revision; frozen.mkdir(parents=True)
                (frozen / 'quarterly_financial_history.json.gz').write_bytes(gzip.compress(json.dumps({'records': [
                    {'symbol': 'TEST', 'quarter_end': '2026-06-30', 'report_type': 'CONSOLIDATED',
                     'filing_date': '2026-07-20', 'filing_url': 'https://example.com/results.pdf'}]}).encode()))
                release = complete_release(self.build(root, observed), output,
                                           {'revision': revision, 'sessionDate': observed}, store)
                reference = store.references[f'releases/{revision}/index.json']['financialLookup']['TEST']
                self.assertEqual(reference['observedOn'], observed)
                hashes.append(reference['history'])
                payload = json.loads(gzip.decompress(store.objects[reference['history'] + '.json.gz']))
                self.assertEqual(payload['history']['standalone']['quarterly'][0]['sales'], 90)
                self.assertNotIn('observed_on', payload['history'])
                self.assertNotIn('observed_on', payload['history']['standalone'])
                self.assertEqual(payload['resultFilings'][0]['filing_url'], 'https://example.com/results.pdf')
            self.assertEqual(hashes[0], hashes[1])
            self.assertNotEqual(hashes[1], hashes[2])
            self.assertEqual(store.uploaded.count(hashes[0] + '.json.gz'), 1)

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
            lookup = index['filingLookup']
            catalog = json.loads(gzip.decompress(store.objects[index['announcements'] + '.json.gz']))
            self.assertEqual(lookup['publishedAt'], catalog['publishedAt'])
            self.assertEqual(lookup['symbols']['TEST']['recent'], catalog['symbols']['TEST']['recent'])
            history = json.loads(gzip.decompress(store.objects[lookup['symbols']['TEST']['history'] + '.json.gz']))
            self.assertEqual(history, {'symbol': 'TEST', **catalog['symbols']['TEST']})
            for field, digest in [('recent', '0' * 64), ('history', index['announcements'])]:
                with self.subTest(invalid_reference=field):
                    invalid = json.loads(json.dumps(lookup))
                    invalid['symbols']['TEST'][field] = digest
                    with self.assertRaisesRegex(RuntimeError, 'Filing lookup history mismatch'):
                        validate_announcement_objects(root / 'chart_artifacts/objects', index['announcements'],
                                                      '2026-10-06', {'TEST'}, invalid)
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
            raw = (root / 'filing_history_data/filing_history.json').read_bytes()
            packed_raw = (charts / 'objects' / (expected['raw'] + '.json.gz')).read_bytes()
            self.assertEqual(gzip.decompress(packed_raw), raw)
            self.assertEqual(packed_raw[8], 0)  # Level 6, not the level-9 XFL marker.
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
                if args[0] == 'check':
                    self.assertIn('--download', args)
                    self.assertIn('--one-way', args)
                    self.assertEqual(args[args.index('--checkers') + 1], '16')
                else:
                    self.assertIn('--immutable', args)
                    self.assertIn('--checksum', args)
                calls.append((args[0], names))
            store.run = run
            listing = f'{old}.json.gz\t{(root / (old + ".json.gz")).stat().st_size}\n'
            with patch('chart_publication.subprocess.run', return_value=Mock(stdout=listing)):
                store.upload_objects(root)
            self.assertEqual(calls, [('copy', [new + '.json.gz']), ('check', [new + '.json.gz'])])
            with patch('chart_publication.subprocess.run', return_value=Mock(stdout=f'{old}.json.gz\t1\n')):
                with self.assertRaisesRegex(RuntimeError, 'different size'):
                    store.upload_objects(root)

    def test_r2_upload_avoids_post_put_head(self):
        store = R2Store.__new__(R2Store); store.env = {}
        with patch('chart_publication.subprocess.run') as run:
            store.run('copyto', 'source', 'charts:test/object')
        self.assertIn('--s3-no-head', run.call_args.args[0])
        self.assertIn('--s3-no-check-bucket', run.call_args.args[0])

    def test_r2_check_failure_still_propagates(self):
        store = R2Store.__new__(R2Store); store.env = {}
        with patch('chart_publication.subprocess.run', side_effect=RuntimeError('verification failed')):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                store.run('check', 'source', 'charts:test/object', '--download', '--checkers', '16')
