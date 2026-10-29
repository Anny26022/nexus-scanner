import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'frontend'))

from tools import publish_site_data


class FakeStore:
    def __init__(self, objects=None, corrupt=False):
        self.objects = dict(objects or {})
        self.corrupt = corrupt
        self.upload_order = []
        self.copies = []

    def remote(self, key):
        return f'r2:{key}'

    def run(self, command, *args):
        if command == 'copyto':
            source, target = args[0], args[1]
            key = target[3:]
            data = Path(source).read_bytes()
            # Like rclone, skip an unchanged object unless told to ignore size and time.
            if self.objects.get(key) == data and '--ignore-times' not in args:
                return
            self.objects[key] = data
            self.upload_order.append(key)
        elif command == 'copy':
            self.copies.append((command, args))
            source, target = args[0], args[1]
            key = target[3:]
            source_path = Path(source)
            include = None
            if '--include' in args:
                include = args[args.index('--include') + 1]
            if source_path.is_dir():
                for p in sorted(source_path.rglob('*')):
                    if p.is_file():
                        rel = p.relative_to(source_path).as_posix()
                        if include == '*.json.gz' and not rel.endswith('.json.gz'):
                            continue
                        if include == '*.json' and not (rel.endswith('.json') and not rel.endswith('.json.gz')):
                            continue
                        dest_key = f"{key}/{rel}"
                        self.objects[dest_key] = p.read_bytes()
                        self.upload_order.append(dest_key)
        elif command == 'check':
            if self.corrupt:
                raise RuntimeError("Check verification mismatch")

    def cache_command(self, command, *args):
        if command == 'lsf':
            prefix = next(arg for arg in args if arg.startswith('r2:'))[3:].rstrip('/') + '/'
            return '\n'.join(sorted(key[len(prefix):] for key in self.objects if key.startswith(prefix))).encode()
        if self.corrupt:
            return b'corrupt-data'
        return self.objects.get(args[0][3:], b'')


class PublishSiteDataTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def write_release(self, rev, stocks):
        rev_dir = self.data_dir / 'revisions' / rev
        rev_dir.mkdir(parents=True)
        snapshot = {'revision': rev, 'asOfDate': '2026-10-27', 'stocks': stocks}
        (rev_dir / 'stocks.json.gz').write_bytes(gzip.compress(json.dumps(snapshot).encode(), mtime=0))
        return rev_dir

    def test_publishes_release_files_and_static_files_before_current_pointer(self):
        rev = 'a' * 64
        rev_dir = self.write_release(rev, [])
        (rev_dir / 'stocks.packed.json.gz').write_bytes(b'gzipped-stocks')
        (rev_dir / 'ipos.json.gz').write_bytes(b'gzipped-ipos')
        (rev_dir / 'financial-history').mkdir()
        (rev_dir / 'financial-history' / 'RELIANCE.json.gz').write_bytes(b'gzipped-reliance')

        # Company revisions
        company_rev_dir = self.data_dir / 'company' / 'revisions' / rev
        company_rev_dir.mkdir(parents=True)
        (company_rev_dir / 'overviews.json.gz').write_bytes(b'gzipped-overviews')
        (self.data_dir / 'company' / 'current.json').write_text(json.dumps({'revision': rev}))

        (self.data_dir / 'sessions.json').write_text('{"sessions":[]}')
        (self.data_dir / 'price-band-history.json').write_text('{"bands":[]}')
        pointer = {'revision': rev, 'datasetPackedGzipUrl': f'/data/revisions/{rev}/stocks.packed.json.gz',
                   'iposUrl': f'/data/revisions/{rev}/ipos.json.gz',
                   'financialHistoryUrlTemplate': f'/data/revisions/{rev}/financial-history/{{symbol}}.json.gz'}
        (self.data_dir / 'current.json').write_text(json.dumps(pointer))

        store = FakeStore()
        count = publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')

        self.assertEqual(count, 10)
        # Release bundle files uploaded to releases/<rev>/
        self.assertEqual(store.objects[f'releases/{rev}/stocks.packed.json.gz'], b'gzipped-stocks')
        self.assertEqual(store.objects[f'releases/{rev}/ipos.json.gz'], b'gzipped-ipos')
        self.assertEqual(store.objects[f'releases/{rev}/financial-history/RELIANCE.json.gz'], b'gzipped-reliance')

        # Company revision overviews uploaded to releases/company/<rev>/, outside the daily/ lifecycle rule
        self.assertEqual(store.objects[f'releases/company/{rev}/overviews.json.gz'], b'gzipped-overviews')
        self.assertFalse(any(key.startswith('daily/journal/company/revisions/') for key in store.objects))
        # Bulk copies never overwrite an existing object
        self.assertTrue(all('--immutable' in args for command, args in store.copies))
        self.assertEqual(store.objects['daily/journal/company/current.json'], json.dumps({'revision': rev}).encode())

        # Static datasets uploaded to daily/journal/
        self.assertEqual(store.objects['daily/journal/sessions.json'], b'{"sessions":[]}')
        self.assertEqual(store.objects['daily/journal/price-band-history.json'], b'{"bands":[]}')
        self.assertEqual(store.objects['daily/journal/current.json'], json.dumps(pointer).encode())

        # Pointer is strictly uploaded last, right after the AI catalogue for the same release
        self.assertEqual(store.upload_order[-2:], ['daily/journal/ai-filter-choices.json', 'daily/journal/current.json'])
        self.assertEqual(json.loads(store.objects['daily/journal/ai-filter-choices.json'])['revision'], rev)

    def test_ai_catalogue_matches_nexus_scanner_build(self):
        rev = 'b' * 64
        self.write_release(rev, [
            {'sector': ' Financials ', 'industry': 'banks', 'series': 'EQ', 'circuitLimit': '20%',
             'indexMemberships': ['NIFTY 50', 'nifty bank', ''],
             'extended': {'asOfDate': '2026-10-27', 'values': {'RSI': 61.2, 'ADR': True, 'NaN': float('nan')}}},
            {'sector': 'FINANCIALS', 'industry': None, 'series': 'BE', 'circuitLimit': 5,
             'indexMemberships': 'NIFTY 50', 'tradingview': {'asOfDate': '2026-10-27', 'values': {'EMA200': 100.5}}},
            {'sector': 'FINANCIALS', 'industry': None, 'series': 'BE', 'circuitLimit': 5,
             'indexMemberships': 'NIFTY 50', 'extended': {'asOfDate': '2026-10-24', 'values': {'Stale': 1}}},
        ])
        path = publish_site_data.build_ai_filter_choices(self.data_dir, {'revision': rev, 'sessionDate': '2026-10-27'})
        self.assertEqual(json.loads(path.read_text()), {
            'revision': rev, 'sessionDate': '2026-10-27',
            'choices': {'SECTOR': ['FINANCIALS'], 'INDUSTRY': ['BANKS'], 'SERIES': ['BE', 'EQ'], 'PRICE_BAND': ['20%'],
                        'INDEX_MEMBERSHIP': ['NIFTY 50', 'NIFTY BANK'], 'TRADINGVIEW_METRIC': ['EMA200', 'RSI']},
        })

    def test_company_overview_uploaded_before_pointer_published(self):
        comp_dir = self.data_dir / 'company'
        comp_dir.mkdir(parents=True)
        c_rev = 'd' * 64
        (comp_dir / 'current.json').write_text(json.dumps({'revision': c_rev}))
        rev_dir = comp_dir / 'revisions' / c_rev
        rev_dir.mkdir(parents=True)
        (rev_dir / 'overviews.json.gz').write_bytes(b'gzipped-company-overviews')

        store = FakeStore()
        publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertIn(f'releases/company/{c_rev}/overviews.json.gz', store.objects)
        self.assertIn('daily/journal/company/current.json', store.objects)
        self.assertEqual(store.objects[f'releases/company/{c_rev}/overviews.json.gz'], b'gzipped-company-overviews')

    def test_company_pointer_skipped_if_overview_missing(self):
        comp_dir = self.data_dir / 'company'
        comp_dir.mkdir(parents=True)
        c_rev = 'd' * 64
        (comp_dir / 'current.json').write_text(json.dumps({'revision': c_rev}))
        # No local overview file and none in R2

        store = FakeStore()
        publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertNotIn(f'releases/company/{c_rev}/overviews.json.gz', store.objects)
        self.assertNotIn('daily/journal/company/current.json', store.objects)

    def test_catalogue_for_another_dataset_stops_before_the_pointer(self):
        rev = 'c' * 64
        rev_dir = self.data_dir / 'revisions' / rev
        rev_dir.mkdir(parents=True)
        (rev_dir / 'stocks.json.gz').write_bytes(gzip.compress(json.dumps({'revision': 'd' * 64, 'stocks': []}).encode()))
        (self.data_dir / 'current.json').write_text(json.dumps({'revision': rev}))
        store = FakeStore()
        with self.assertRaisesRegex(RuntimeError, 'AI catalogue dataset mismatch'):
            publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertNotIn('daily/journal/current.json', store.objects)

    def test_unchanged_daily_files_are_rewritten_every_run(self):
        # Rewriting restarts the daily/ lifecycle rule's 90 days for files that rarely change.
        (self.data_dir / 'results').mkdir()
        (self.data_dir / 'results' / 'us_index.json').write_text('{"results":[]}')
        (self.data_dir / 'current.json').write_text(json.dumps({'revision': 'e' * 64}))
        store = FakeStore({'daily/journal/results/us_index.json': b'{"results":[]}'})
        publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertEqual(store.upload_order, ['daily/journal/results/us_index.json', 'daily/journal/current.json'])

    def test_release_published_earlier_keeps_its_catalogue(self):
        (self.data_dir / 'current.json').write_text(json.dumps({'revision': 'e' * 64}))
        store = FakeStore()
        publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertEqual(store.upload_order, ['daily/journal/current.json'])

    def test_pointer_waits_for_a_release_missing_from_r2(self):
        # No local release folder and nothing in R2: moving the pointer would send the journal to a 404.
        rev = 'f' * 64
        (self.data_dir / 'current.json').write_text(json.dumps(
            {'revision': rev, 'datasetPackedGzipUrl': f'/data/revisions/{rev}/stocks.packed.json.gz'}))
        store = FakeStore()
        with self.assertRaisesRegex(RuntimeError, 'missing from R2 .*stocks.packed.json.gz.*pointer not updated'):
            publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertNotIn('daily/journal/current.json', store.objects)

    def test_pointer_moves_when_an_earlier_run_published_the_release(self):
        rev = 'f' * 64
        pointer = {'revision': rev, 'datasetPackedGzipUrl': f'/data/revisions/{rev}/stocks.packed.json.gz'}
        (self.data_dir / 'current.json').write_text(json.dumps(pointer))
        store = FakeStore({f'releases/{rev}/stocks.packed.json.gz': b'gzipped-stocks'})
        publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')
        self.assertEqual(store.objects['daily/journal/current.json'], json.dumps(pointer).encode())

    def test_checksum_mismatch_raises_error(self):
        (self.data_dir / 'current.json').write_text(json.dumps({'revision': 'f' * 64}))
        store = FakeStore(corrupt=True)
        with self.assertRaisesRegex(RuntimeError, 'Verification checksum mismatch'):
            publish_site_data.publish(store, data_dir=self.data_dir, daily_prefix='daily/journal')

    def test_graceful_exit_when_missing_settings(self):
        with patch('chart_publication.missing_r2_settings', return_value=['R2_ACCOUNT_ID']):
            self.assertEqual(publish_site_data.main([]), 0)


if __name__ == '__main__':
    unittest.main()
