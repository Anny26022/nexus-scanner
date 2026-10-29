import gzip
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import site_data

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import seed_site_data  # noqa: E402

REVISION = 'a' * 64
COMPANY = 'c' * 64


class FakeStore:
    """An in-memory bucket that records every command in order."""
    def __init__(self, objects=None, fail=None, corrupt=None):
        self.objects, self.calls, self.fail, self.corrupt = dict(objects or {}), [], fail, corrupt

    def remote(self, key):
        return 'r2:' + key

    def run(self, command, source, target, *args):
        self.calls.append((command, target))
        if self.fail and self.fail in target:
            raise subprocess.CalledProcessError(1, ['rclone', command])
        if command == 'copy':
            for file in Path(source).rglob('*'):
                if file.is_file() and 'charts' not in file.parts:
                    self.objects[target[3:] + '/' + file.relative_to(source).as_posix()] = file.read_bytes()

    def cache_command(self, command, *args):
        if command == 'lsf':
            prefix = args[0][3:]
            return '\n'.join(key[len(prefix):] for key in self.objects if key.startswith(prefix)).encode()
        if command == 'cat':
            key = args[0][3:]
            data = self.objects[key]
            return b'corrupt' if self.corrupt and key.endswith(self.corrupt) else data
        source, target = args[:2]
        self.calls.append((command, target))
        if target.startswith('r2:'):
            self.objects[target[3:]] = Path(source).read_bytes()
        else:
            Path(target).write_bytes(self.objects[source[3:]])

    def pointer_order(self):
        return [target[len('r2:site/data/'):] for command, target in self.calls
                if command == 'copyto' and target.startswith('r2:site/data/')]


def release(output, session='2026-10-28', revision=REVISION):
    folder = output / 'revisions' / revision
    (folder / 'financial-history').mkdir(parents=True)
    (folder / 'charts').mkdir()
    stocks = {'revision': revision, 'asOfDate': session, 'stocks': [
        {'sector': ' Banks ', 'industry': 'Private Bank', 'series': 'EQ', 'circuitLimit': '20',
         'indexMemberships': ['NIFTY 50', 'nifty bank'], 'tradingview': {'asOfDate': session, 'values': {'rsi': 51.2, 'x': None}}},
        {'sector': 'IT', 'industry': None, 'series': 'BE', 'circuitLimit': '5', 'indexMemberships': [],
         'tradingview': {'asOfDate': '2026-10-01', 'values': {'stale': 1}}},
    ]}
    (folder / 'stocks.json.gz').write_bytes(gzip.compress(json.dumps(stocks).encode(), mtime=0))
    (folder / 'release.json').write_text('{}')
    (folder / 'financial-history' / 'M&M.json.gz').write_bytes(gzip.compress(b'null', mtime=0))
    (folder / 'charts' / 'TEST.json.gz').write_bytes(b'local only')
    manifest = {'revision': revision, 'sessionDate': session}
    (output / 'current.json').write_text(json.dumps(manifest))
    (output / 'sessions.json').write_text('{"version":1,"sessions":[]}')
    (output / 'price-band-history.json').write_text('{}')
    return manifest


class SiteDataTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.output = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_release_files_go_first_and_current_json_last(self):
        manifest = release(self.output)
        store = FakeStore()
        site_data.publish_release(store, self.output, manifest)
        commands = [command for command, _ in store.calls]
        self.assertEqual(commands[:3], ['copy', 'copy', 'check'])
        self.assertTrue(all(target == f'r2:releases/{REVISION}' for _, target in store.calls[:3]))
        self.assertEqual(store.pointer_order(), ['ai-filter-choices.json', 'price-band-history.json', 'sessions.json', 'current.json'])
        self.assertIn(f'releases/{REVISION}/financial-history/M&M.json.gz', store.objects)
        self.assertNotIn(f'releases/{REVISION}/charts/TEST.json.gz', store.objects)

    def test_a_failed_release_upload_leaves_every_pointer_unchanged(self):
        manifest = release(self.output)
        store = FakeStore(fail='releases/')
        with self.assertRaises(subprocess.CalledProcessError):
            site_data.publish_release(store, self.output, manifest)
        self.assertEqual(store.pointer_order(), [])

    def test_a_pointer_read_back_mismatch_stops_before_current_json(self):
        manifest = release(self.output)
        store = FakeStore(corrupt='sessions.json')
        with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
            site_data.publish_release(store, self.output, manifest)
        self.assertNotIn('current.json', store.pointer_order())

    def test_ai_catalogue_comes_from_the_published_release(self):
        manifest = release(self.output)
        site_data.publish_release(FakeStore(), self.output, manifest)
        catalogue = json.loads((self.output / 'ai-filter-choices.json').read_text())
        self.assertEqual(catalogue['revision'], REVISION)
        self.assertEqual(catalogue['choices'], {
            'SECTOR': ['BANKS', 'IT'], 'INDUSTRY': ['PRIVATE BANK'], 'SERIES': ['BE', 'EQ'], 'PRICE_BAND': ['20', '5'],
            'INDEX_MEMBERSHIP': ['NIFTY 50', 'NIFTY BANK'], 'TRADINGVIEW_METRIC': ['rsi']})

    def test_ai_catalogue_rejects_a_release_that_names_another_revision(self):
        release(self.output)
        (self.output / 'revisions' / REVISION).rename(self.output / 'revisions' / ('b' * 64))
        with self.assertRaisesRegex(RuntimeError, 'dataset mismatch'):
            site_data.build_ai_filter_choices(self.output, {'revision': 'b' * 64})
        with self.assertRaisesRegex(RuntimeError, 'Invalid AI catalogue revision'):
            site_data.build_ai_filter_choices(self.output, {'revision': '../x'})

    def test_local_publication_writes_the_catalogue_without_r2(self):
        manifest = release(self.output)
        with patch.dict(os.environ, {'EDL_CHART_STORAGE': 'local'}), patch('site_data.R2Store') as store:
            site_data.publish_site(self.output, manifest)
        store.assert_not_called()
        self.assertTrue((self.output / 'ai-filter-choices.json').is_file())

    def test_r2_publication_uses_the_store(self):
        manifest = release(self.output)
        store = FakeStore()
        with patch.dict(os.environ, {'EDL_CHART_STORAGE': 'r2'}), patch('site_data.charts_enabled', return_value=True), \
                patch('site_data.R2Store', return_value=store):
            site_data.publish_site(self.output, manifest)
        self.assertEqual(store.pointer_order()[-1], 'current.json')

    def test_pull_replaces_checkout_pointers_with_the_live_ones(self):
        release(self.output, session='2026-10-27')
        store = FakeStore({'site/data/current.json': b'{"sessionDate":"2026-10-28"}',
                           'site/data/sessions.json': b'live sessions', 'site/data/results/index.json': b'live index',
                           'site/data/ai-filter-choices.json': b'not pulled'})
        site_data.pull(store, self.output)
        self.assertEqual((self.output / 'sessions.json').read_bytes(), b'live sessions')
        self.assertEqual((self.output / 'results/index.json').read_bytes(), b'live index')
        self.assertFalse((self.output / 'ai-filter-choices.json').exists())

    def test_pull_keeps_a_newer_checkout_and_bootstraps_an_empty_bucket(self):
        release(self.output, session='2026-10-29')
        newer = FakeStore({'site/data/current.json': b'{"sessionDate":"2026-10-28"}', 'site/data/sessions.json': b'old'})
        site_data.pull(newer, self.output)
        site_data.pull(FakeStore(), self.output)
        self.assertEqual(json.loads((self.output / 'sessions.json').read_text()), {'version': 1, 'sessions': []})

    def test_push_indexes_publishes_changes_and_the_company_revision_first(self):
        (self.output / 'results').mkdir()
        (self.output / 'results/index.json').write_text('same')
        (self.output / 'heatmap').mkdir()
        (self.output / 'heatmap/index.json').write_text('new')
        company = self.output / 'company/revisions' / COMPANY
        company.mkdir(parents=True)
        (company / 'overviews.json.gz').write_bytes(b'gz')
        (self.output / 'company/current.json').write_text(json.dumps({'revision': COMPANY}))
        store = FakeStore({'site/data/results/index.json': b'same'})
        site_data.push_indexes(store, self.output)
        self.assertEqual(store.pointer_order(), ['heatmap/index.json', 'company/current.json'])
        targets = [target for _, target in store.calls]
        self.assertLess(targets.index(f'r2:releases/company/{COMPANY}'), targets.index('r2:site/data/company/current.json'))

    @unittest.skipUnless(shutil.which('rclone'), 'rclone is not installed')
    def test_real_rclone_filters_copy_release_files_but_not_local_charts(self):
        release(self.output)
        (self.output / 'revisions' / REVISION / 'partial.json.tmp').write_text('x')
        bucket = self.output / 'bucket'

        class LocalStore:
            def remote(self, key):
                return str(bucket / key)

            def run(self, command, *args):
                # The local backend has no object metadata; everything else is passed as the daily run does.
                args = [arg for index, arg in enumerate(args)
                        if arg != '--metadata' and arg != '--metadata-set' and (index == 0 or args[index - 1] != '--metadata-set')]
                subprocess.run([shutil.which('rclone'), command, *args], check=True, capture_output=True, timeout=60)

        site_data.upload_revision(LocalStore(), self.output / 'revisions' / REVISION, f'releases/{REVISION}')
        copied = sorted(path.relative_to(bucket).as_posix() for path in bucket.rglob('*') if path.is_file())
        self.assertEqual(copied, [f'releases/{REVISION}/{name}' for name in
                                  ('financial-history/M&M.json.gz', 'release.json', 'stocks.json.gz')])
        (bucket / f'releases/{REVISION}/release.json').write_text('[]')
        with self.assertRaises(subprocess.CalledProcessError):
            site_data.upload_revision(LocalStore(), self.output / 'revisions' / REVISION, f'releases/{REVISION}')

    def test_only_served_pointers_can_be_published(self):
        (self.output / 'stocks.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'Not a published pointer'):
            site_data.upload_pointer(FakeStore(), self.output, 'stocks.json')

    def test_pointer_list_matches_the_worker_allowlist(self):
        worker = (Path(__file__).resolve().parents[1] / 'workers/screener-ai/siteData.ts').read_text()
        listed = worker.split('export const POINTERS = new Set([', 1)[1].split(']);', 1)[0]
        self.assertEqual(sorted(name.strip(" '\n") for name in listed.split(',') if name.strip()), sorted(site_data.POINTERS))

    def test_seed_copies_every_revision_and_company_revision_then_pointers_with_current_last(self):
        manifest = release(self.output)
        (self.output / 'revisions' / ('b' * 64)).mkdir()
        (self.output / 'revisions' / ('b' * 64) / 'release.json').write_text('{}')
        company = self.output / 'company/revisions' / COMPANY
        company.mkdir(parents=True)
        (company / 'overviews.json.gz').write_bytes(b'gz')
        (self.output / 'company/current.json').write_text(json.dumps({'revision': COMPANY}))
        store = FakeStore()
        seed_site_data.seed(store, self.output)
        copied = [target for command, target in store.calls if command == 'check']
        self.assertEqual(copied, [f'r2:releases/{REVISION}', f'r2:releases/{"b" * 64}', f'r2:releases/company/{COMPANY}'])
        order = store.pointer_order()
        self.assertEqual(order[0], 'ai-filter-choices.json')
        self.assertEqual(order[-1], 'current.json')
        self.assertEqual(set(order), {'ai-filter-choices.json', 'sessions.json', 'price-band-history.json',
                                      'company/current.json', 'current.json'})
        self.assertEqual(manifest['revision'], json.loads(store.objects['site/data/ai-filter-choices.json'])['revision'])


if __name__ == '__main__':
    unittest.main()
