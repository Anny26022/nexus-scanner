import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent.parent / 'DO NOT DELETE EDL PIPELINE'
sys.path.insert(0, str(ROOT))
from announcement_artifacts import put_object
import build_chart_artifacts as builder
from chart_publication import complete_release, inventory_bytes, inventory_names, R2Store, prepare_archives, validate_announcement_objects
from filing_archives import prepare_filing_archives


class ObjectStore:
    base_url = 'https://charts.example.com'
    def __init__(self):
        self.objects = {}
        self.references = {}
        self.inventory = set()
        self.uploaded = []
        self.backups = {}
        self.fail = False
    def load_inventory(self, previous):
        return set(self.inventory)
    def write_inventory(self, names):
        self.inventory = set(names)
    def upload_objects(self, source, known_verified=()):
        if self.fail:
            raise RuntimeError('object upload failed')
        paths = list(source.glob('*.json.gz'))
        for path in paths:
            if path.name in known_verified:
                continue
            data = path.read_bytes()
            if path.name not in self.objects:
                self.uploaded.append(path.name)
                self.objects[path.name] = data
            else:
                assert self.objects[path.name] == data
        return [path.name for path in paths]
    def upload_backups(self, source):
        self.backups.update({path.name: path.read_bytes() for path in source.glob('*.json.gz')})
    def write_release(self, value, key):
        if key in self.references:
            assert self.references[key] == value
        self.references[key] = value


class ObjectPublicationTests(unittest.TestCase):
    def test_optional_rotation_upload_failure_and_retry_preserve_release_binding(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            charts = self.build(root, '2026-10-07'); (charts / 'rotation').mkdir()
            store = ObjectStore()
            store.upload_rotation = Mock(side_effect=subprocess.CalledProcessError(1, ['rclone', 'check']))
            manifest = {'revision': 'a'*64, 'sessionDate': '2026-10-07', 'rotationHistoryObject': 'b'*64}
            first = complete_release(charts, output, manifest, store)
            self.assertNotIn('rotationHistoryObject', first)
            self.assertTrue((output / 'current.json').exists())
            store.upload_rotation.side_effect = None
            self.assertEqual(complete_release(charts, output, manifest, store), first)
            self.assertEqual(store.upload_rotation.call_count, 1)

    def test_local_rotation_copy_failure_does_not_block_scanner(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            charts = self.build(root, '2026-10-07'); rotation = charts / 'rotation'; rotation.mkdir()
            (rotation / ('b'*64 + '.json.gz')).write_bytes(b'rotation')
            copyfile = shutil.copyfile

            def copy(source, target):
                if Path(source).parent == rotation:
                    raise OSError('rotation disk error')
                return copyfile(source, target)

            with patch('chart_publication.shutil.copyfile', side_effect=copy), \
                    patch.dict(os.environ, {'EDL_CHART_STORAGE': 'local'}):
                manifest = complete_release(charts, output, {
                    'revision': 'a'*64, 'sessionDate': '2026-10-07', 'rotationHistoryObject': 'b'*64})
            self.assertNotIn('rotationHistoryObject', manifest)
            self.assertTrue((output / 'current.json').exists())

    def test_chart_chunks_reuse_history_and_refresh_corrections_and_year_rollover(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'ohlcv_data').mkdir()
            source = root / 'ohlcv_data/TEST.csv'; objects = root / 'objects'
            rows = ['2025-12-31,10,12,9,11,100', '2026-10-06,11,13,10,12,200']
            def chart(day):
                source.write_text('Date,Open,High,Low,Close,Volume\n' + '\n'.join(rows) + '\n')
                _, digest = builder._chart_object((root, objects, 'TEST', day, [], [], []))
                return json.loads(gzip.decompress((objects / (digest + '.json.gz')).read_bytes()))
            first = chart('2026-10-06')
            before = {p.name: p.read_bytes() for p in objects.iterdir()}
            rows.append('2026-10-07,12,14,11,13,300')
            second = chart('2026-10-07')
            self.assertEqual(first['candleChunks'][0], second['candleChunks'][0])
            self.assertNotEqual(first['candleChunks'][1], second['candleChunks'][1])
            rows[0] = '2025-12-31,10,13,9,12,100'  # Correct historical prices, not just append.
            corrected = chart('2026-10-07')
            self.assertNotEqual(second['candleChunks'][0], corrected['candleChunks'][0])
            self.assertEqual(second['candleChunks'][1], corrected['candleChunks'][1])
            rows.append('2027-01-04,13,15,12,14,400')
            rollover = chart('2027-01-04')
            candles = [row for digest in rollover['candleChunks']
                       for row in json.loads(gzip.decompress((objects / (digest + '.json.gz')).read_bytes()))['candles']]
            self.assertEqual([row['date'] for row in candles], ['2025-12-31', '2026-10-06', '2026-10-07', '2027-01-04'])
            self.assertEqual(candles[0]['close'], 12)
            self.assertTrue(all((objects / name).read_bytes() == data for name, data in before.items()))

    def test_daily_release_omits_backups_and_weekly_release_dates_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            (root / 'filing_history.json.gz').write_bytes(gzip.compress(b'{"records":[]}'))
            store = ObjectStore()
            with patch.dict('os.environ', {'EDL_FILING_BACKUPS': ' false '}), \
                    patch('chart_publication.prepare_archives', side_effect=AssertionError('daily backup work')):
                complete_release(self.build(root, '2026-10-06'), output,
                                 {'revision': 'a'*64, 'sessionDate': '2026-10-06'}, store)
            daily = store.references['releases/' + 'a'*64 + '/index.json']
            self.assertNotIn('archives', daily)
            self.assertNotIn('backups/releases/' + 'a'*64 + '.json', store.references)
            with patch.dict('os.environ', {'EDL_FILING_BACKUPS': ' YES '}):
                complete_release(self.build(root, '2026-10-07'), output,
                                 {'revision': 'b'*64, 'sessionDate': '2026-10-07'}, store)
            weekly = store.references['releases/' + 'b'*64 + '/index.json']
            lookup = json.loads(gzip.decompress(store.objects[weekly['filingLookupObject'] + '.json.gz']))
            backups = store.references['backups/releases/' + 'b'*64 + '.json']
            self.assertEqual(backups['asOf'], lookup['publishedAt'])
            self.assertIn('classified', backups)
            # Backups never reach the public index or the served objects prefix.
            self.assertNotIn('archives', weekly)
            self.assertIn(backups['classified'] + '.json.gz', store.backups)
            self.assertNotIn(backups['classified'] + '.json.gz', store.objects)

    def test_missing_chunk_prevents_publication_and_preserves_pointer(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            (root / 'ohlcv_data').mkdir()
            (root / 'ohlcv_data/TEST.csv').write_text('Date,Open,High,Low,Close,Volume\n2026-10-06,10,12,9,11,100\n')
            charts = self.build(root, '2026-10-06'); store = ObjectStore()
            manifest = {'revision': 'a'*64, 'sessionDate': '2026-10-06'}
            complete_release(charts, output, manifest, store)
            before = (output / 'current.json').read_bytes()
            index = json.loads((charts / 'index.json').read_text())
            chart = json.loads(gzip.decompress((charts / 'objects' / (index['chartObjects']['TEST'] + '.json.gz')).read_bytes()))
            (charts / 'objects' / (chart['candleChunks'][0] + '.json.gz')).unlink()
            with self.assertRaises(FileNotFoundError):
                complete_release(charts, output, {'revision': 'b'*64, 'sessionDate': '2026-10-06'}, store)
            self.assertEqual((output / 'current.json').read_bytes(), before)

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
            self.assertEqual(set(store.references['backups/releases/' + 'a'*64 + '.json']) - {'asOf'}, {'raw', 'classified'})
            chart_hash = index['chartObjects']['TEST']
            # The lookup lives in its own object so the index the chart path waits on stays small.
            self.assertNotIn('filingLookup', index)
            lookup = json.loads(gzip.decompress(store.objects[index['filingLookupObject'] + '.json.gz']))
            chart = json.loads(gzip.decompress(store.objects[chart_hash + '.json.gz']))
            self.assertEqual(index['chartChunks']['TEST'], chart['candleChunks'])
            catalog = json.loads(gzip.decompress(store.objects[index['announcements'] + '.json.gz']))
            self.assertEqual(lookup['publishedAt'], catalog['publishedAt'])
            self.assertEqual(lookup['symbols']['TEST']['recent'], catalog['symbols']['TEST']['recent'])
            history = json.loads(gzip.decompress(store.objects[lookup['symbols']['TEST']['history'] + '.json.gz']))
            self.assertEqual(history, {'symbol': 'TEST', 'recent': catalog['symbols']['TEST']['recent'],
                                       'years': catalog['symbols']['TEST']['years']})
            self.assertEqual(lookup['symbols']['TEST']['fetchStatus'],
                             catalog['symbols']['TEST']['fetchStatus'])
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

    def test_optional_inventory_skips_unchanged_objects_without_changing_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'public'; output.mkdir()
            charts = self.build(root, '2026-10-06'); store = ObjectStore()
            first = complete_release(charts, output, {'revision': 'a'*64, 'sessionDate': '2026-10-06'}, store)
            original_files = set(path.name for path in (charts / 'objects').glob('*.json.gz'))
            self.assertEqual(store.inventory, original_files)
            self.assertNotIn('verifiedObjectsSha256', first)
            with patch.object(store, 'upload_objects', wraps=store.upload_objects) as upload:
                complete_release(charts, output, {'revision': 'b'*64, 'sessionDate': '2026-10-06'}, store)
                self.assertEqual(upload.call_args.args[1], original_files)
            self.assertEqual(set(store.uploaded), original_files)
            with patch.object(store, 'write_inventory', side_effect=RuntimeError('receipt upload failed')):
                third = complete_release(charts, output, {'revision': 'c'*64, 'sessionDate': '2026-10-06'}, store)
            self.assertEqual(json.loads((output / 'current.json').read_text())['revision'], third['revision'])
            self.assertNotIn('verifiedObjectsSha256', third)
            legacy = dict(third, verifiedObjectsSha256='f'*64)
            (output / 'revisions' / third['revision'] / 'release.json').write_text(json.dumps(legacy))
            (output / 'current.json').write_text(json.dumps(legacy))
            store.references[f"releases/{third['revision']}/release.json"] = legacy
            retried = complete_release(charts, output, {'revision': 'c'*64, 'sessionDate': '2026-10-06'}, store)
            self.assertEqual(retried, legacy)

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

    def test_r2_targets_source_objects_without_listing_the_bucket(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = put_object(root, {'old': 1}); new = put_object(root, {'new': 1})
            store = R2Store.__new__(R2Store); store.env = {}; store.bucket = 'test'
            calls = []
            expected = sorted([old + '.json.gz', new + '.json.gz'])
            def run(*args):
                self.assertIn('--no-traverse', args)
                names = Path(args[args.index('--files-from') + 1]).read_text().splitlines()
                self.assertEqual(names, expected)
                if args[0] == 'check':
                    self.assertIn('--download', args)
                    self.assertIn('--one-way', args)
                else:
                    self.assertIn('--immutable', args)
                    self.assertIn('--checksum', args)
                    self.assertIn('content-type=application/gzip', args)
                    self.assertIn('cache-control=public,max-age=31536000,immutable', args)
                    self.assertEqual(args[args.index('--transfers') + 1], '32')
                self.assertEqual(args[args.index('--checkers') + 1], '32')
                calls.append(args[0])
            store.run = run
            with patch('chart_publication.subprocess.run', side_effect=AssertionError('full listing')):
                self.assertEqual(store.upload_objects(root), expected)
            self.assertEqual(calls, ['copy', 'check'])
            expected = [new + '.json.gz']
            with patch('chart_publication.subprocess.run', side_effect=AssertionError('full listing')):
                self.assertEqual(store.upload_objects(root, {old + '.json.gz'}), sorted([old + '.json.gz', new + '.json.gz']))
            self.assertEqual(calls, ['copy', 'check', 'copy', 'check'])
            with tempfile.TemporaryDirectory() as empty:
                self.assertEqual(store.upload_objects(Path(empty)), [])
            self.assertEqual(calls, ['copy', 'check', 'copy', 'check'])

    def test_r2_inventory_cache_is_checksummed_and_missing_or_corrupt_cache_rechecks(self):
        store = R2Store.__new__(R2Store); store.env = {}; store.bucket = 'test'
        names = ['b'*64 + '.json.gz', 'a'*64 + '.json.gz']
        data = inventory_bytes(names)
        record = hashlib.sha256(data).hexdigest().encode() + b'\n' + data
        writes = []
        def cache(*args, **kwargs):
            if args[0] == 'copyto':
                self.assertEqual(args[2:], (store.remote('verified-objects/current.txt'), '--ignore-times'))
                writes.append(Path(args[1]).read_bytes())
            return record
        with patch.object(store, 'cache_command', side_effect=cache):
            store.write_inventory(names)
        self.assertEqual(writes, [record])
        self.assertEqual(inventory_names(record), set(names))
        with patch.object(store, 'cache_command', side_effect=[b'', b'corrupt']):
            with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                store.write_inventory(names)
        digest = hashlib.sha256(data).hexdigest()
        with patch.object(store, 'cache_command', return_value=record) as download:
            self.assertEqual(store.load_inventory(None), set(names))
            self.assertEqual(download.call_args.args, ('cat', store.remote('verified-objects/current.txt')))
        with patch.object(store, 'cache_command', return_value=record + b'corrupt'):
            self.assertEqual(store.load_inventory(None), set())
        missing = subprocess.CalledProcessError(1, ['rclone', 'cat'])
        with patch.object(store, 'cache_command', side_effect=missing):
            self.assertEqual(store.load_inventory(None), set())
        with patch.object(store, 'cache_command', side_effect=[missing, data]) as download:
            self.assertEqual(store.load_inventory({'verifiedObjectsSha256': digest}), set(names))
            self.assertEqual(download.call_args.args, ('cat', store.remote(f'verified-objects/{digest}.txt')))

    def test_r2_cold_start_checkpoints_verified_batches_for_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index in range(5):
                put_object(root, {'index': index})
            store = R2Store.__new__(R2Store); store.env = {}; store.bucket = 'test'
            checkpoints = []
            checked = []
            def run(*args):
                batch = Path(args[args.index('--files-from') + 1]).read_text().splitlines()
                self.assertLessEqual(len(batch), 2)
                if args[0] == 'copy' and len(checked) == 1:
                    raise subprocess.CalledProcessError(1, args)
                if args[0] == 'check':
                    checked.append(batch)
            store.run = run
            with patch('chart_publication.R2_VERIFY_BATCH_SIZE', 2), \
                    patch.object(store, 'write_inventory', side_effect=lambda names: checkpoints.append(set(names))):
                with self.assertRaises(subprocess.CalledProcessError):
                    store.upload_objects(root)
                self.assertEqual(checkpoints, [set(checked[0])])
                def resume(*args):
                    if args[0] == 'check':
                        checked.append(Path(args[args.index('--files-from') + 1]).read_text().splitlines())
                store.run = resume
                store.upload_objects(root, checkpoints[0])
            self.assertEqual(len(checked), 3)
            self.assertTrue(set(checked[0]).isdisjoint(set(checked[1] + checked[2])))
            self.assertEqual(set().union(*map(set, checked)), {path.name for path in root.glob('*.json.gz')})

    def test_r2_object_command_failures_preserve_pointer_until_successful_retry(self):
        for failure in ('copy', 'check', 'copyto'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); output = root / 'public'; output.mkdir()
                charts = self.build(root, '2026-10-06')
                complete_release(charts, output, {'revision': 'a'*64, 'sessionDate': '2026-10-06'}, ObjectStore())
                before = (output / 'current.json').read_bytes()
                manifest = {'revision': 'b'*64, 'sessionDate': '2026-10-06'}
                store = R2Store.__new__(R2Store)
                store.env = {}; store.bucket = 'test'; store.base_url = 'https://charts.example.com'
                calls = []
                def run(*args):
                    calls.append(args[0])
                    if args[0] == failure:
                        raise subprocess.CalledProcessError(1, args)
                with patch.object(store, 'load_inventory', return_value=set()), patch.object(store, 'run', side_effect=run):
                    with self.assertRaises(subprocess.CalledProcessError):
                        complete_release(charts, output, manifest, store)
                self.assertEqual((output / 'current.json').read_bytes(), before)
                self.assertEqual(calls, ['copy', 'check', 'copyto'][:('copy', 'check', 'copyto').index(failure) + 1])
                with patch.object(store, 'load_inventory', return_value=set()), patch.object(store, 'run') as retry, \
                        patch.object(store, 'cache_command'):
                    complete_release(charts, output, manifest, store)
                self.assertEqual([call.args[0] for call in retry.call_args_list], ['copy', 'check', 'copyto', 'copyto'])
                self.assertEqual(json.loads((output / 'current.json').read_text())['revision'], manifest['revision'])

    @unittest.skipUnless(shutil.which('rclone'), 'rclone is not installed')
    def test_real_rclone_inventory_cache_roundtrip_and_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            store = R2Store.__new__(R2Store)
            store.env = dict(os.environ)
            store.remote = lambda key: str(Path(folder) / key)
            first = ['a'*64 + '.json.gz']
            second = ['b'*64 + '.json.gz']
            store.write_inventory(first)
            self.assertEqual(store.load_inventory(None), set(first))
            store.write_inventory(second)
            self.assertEqual(store.load_inventory(None), set(second))
            (Path(folder) / 'verified-objects/current.txt').write_bytes(b'corrupt')
            self.assertEqual(store.load_inventory(None), set())

    @unittest.skipUnless(os.environ.get('RCLONE_TEST_BINARY') or shutil.which('rclone'), 'rclone is not installed')
    def test_real_rclone_targeted_copy_and_download_check_preserve_integrity(self):
        binary = os.environ.get('RCLONE_TEST_BINARY') or shutil.which('rclone')
        for targeted in (False, True):
            with self.subTest(targeted=targeted), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); source = root / 'source'; source.mkdir()
                target = root / 'target'; target.mkdir()
                digest = put_object(source, {'price': 123.456789})
                file = source / (digest + '.json.gz')
                names = root / 'names.txt'; names.write_text(file.name + '\n')
                (target / 'unrelated').write_bytes(b'keep')
                flags = ['--files-from', str(names), '--checkers', '32', '--retries', '1']
                if targeted: flags.append('--no-traverse')
                def run(command, *extra):
                    return subprocess.run([binary, command, str(source), str(target), *flags, *extra],
                                          capture_output=True, timeout=30)
                # Initial copy and an interrupted publication's retry keep identical bytes.
                for _ in range(2):
                    self.assertEqual(run('copy', '--immutable', '--checksum', '--transfers', '32').returncode, 0)
                    self.assertEqual(run('check', '--one-way', '--download').returncode, 0)
                    self.assertEqual((target / file.name).read_bytes(), file.read_bytes())
                (target / file.name).write_bytes(b'x' * file.stat().st_size)
                self.assertNotEqual(run('check', '--one-way', '--download').returncode, 0)
                self.assertNotEqual(run('copy', '--immutable', '--checksum').returncode, 0)
                self.assertEqual((target / file.name).read_bytes(), b'x' * file.stat().st_size)
                (target / file.name).unlink()
                self.assertNotEqual(run('check', '--one-way', '--download').returncode, 0)
                self.assertEqual((target / 'unrelated').read_bytes(), b'keep')

    def test_r2_upload_avoids_post_put_head(self):
        store = R2Store.__new__(R2Store); store.env = {}
        with patch('chart_publication.subprocess.run') as run:
            store.run('copyto', 'source', 'charts:test/object')
        self.assertIn('--s3-no-head', run.call_args.args[0])
        self.assertIn('--s3-no-check-bucket', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['timeout'], 2700)
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('--max-duration') + 1], '40m')
        self.assertEqual(args[args.index('--timeout') + 1], '1m')
        self.assertEqual(run.call_args.args[0][-5:], ['--stats', '30s', '--stats-one-line', '--stats-log-level', 'NOTICE'])

    def test_r2_check_failure_still_propagates(self):
        store = R2Store.__new__(R2Store); store.env = {}
        with patch('chart_publication.subprocess.run', side_effect=RuntimeError('verification failed')):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                store.run('check', 'source', 'charts:test/object', '--download', '--checkers', '16')

    def test_r2_hung_command_fails_closed_with_a_bounded_subprocess(self):
        import subprocess
        store = R2Store.__new__(R2Store); store.env = {}
        with patch('chart_publication.subprocess.run', side_effect=subprocess.TimeoutExpired('rclone', 2700)):
            with self.assertRaisesRegex(RuntimeError, '45-minute subprocess limit'):
                store.run('check', 'source', 'charts:test/object', '--download')
