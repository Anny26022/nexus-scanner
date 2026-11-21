import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import publish_mutual_funds as publisher
from publish_mutual_funds import POINTER, publish_mutual_funds

LIVE_KEY = f'site/data/{POINTER}'


class FakeR2:
    """The rclone calls the publisher makes, on a dict of keys."""
    def __init__(self, objects=None, corrupt=None):
        self.objects = dict(objects or {})
        self.uploads = []
        self.corrupt = corrupt  # a key prefix whose stored bytes read back damaged

    def remote(self, key):
        return f'charts:bucket/{key}'

    def cache_command(self, action, *args, data=None):
        key = args[0].split('/', 1)[1] if args and args[0].startswith('charts:') else None
        if action == 'lsf':
            prefix = key
            return '\n'.join(name[len(prefix):] for name in self.objects if name.startswith(prefix)).encode()
        if action == 'cat':
            return self.objects[key] + (b'!' if self.corrupt and key.startswith(self.corrupt) else b'')
        if action == 'copyto':
            target = args[1].split('/', 1)[1]
            with open(args[0], 'rb') as handle:
                self.objects[target] = handle.read()
            self.uploads.append(target)
            return b''
        raise AssertionError(f'unexpected rclone {action}')


def snapshot(nav_date='2026-11-06', count=3):
    return {'schemaVersion': 1, 'fetchedAt': '2026-11-07T01:00:00+00:00', 'navDate': nav_date, 'fundCount': count,
            'navCheck': {'amfiMatched': count, 'sameDateCompared': count, 'sameDateAgreed': count, 'navFromAmfi': count},
            'sources': {}, 'funds': [{'isin': f'INF00000000{index}', 'nav': 10.0 + index} for index in range(count)]}


class PublishMutualFundsTests(unittest.TestCase):
    def test_first_publication_uploads_the_release_then_the_pointer(self):
        store = FakeR2()
        pointer = publish_mutual_funds(store, fetch=snapshot)
        self.assertEqual(store.uploads, [f"releases/mf/{pointer['revision']}/funds.json.gz", LIVE_KEY])
        self.assertEqual(pointer['fundsUrl'], f"/data/mf/revisions/{pointer['revision']}/funds.json.gz")
        self.assertEqual(json.loads(store.objects[LIVE_KEY]), pointer)
        expected = {key: value for key, value in snapshot().items() if key != 'fetchedAt'}
        self.assertEqual(json.loads(gzip.decompress(store.objects[store.uploads[0]])), expected)
        self.assertEqual(pointer['fetchedAt'], snapshot()['fetchedAt'])
        self.assertEqual((pointer['navDate'], pointer['fundCount']), ('2026-11-06', 3))

    def test_the_same_data_fetched_again_uploads_nothing(self):
        store = FakeR2()
        publish_mutual_funds(store, fetch=snapshot)
        store.uploads.clear()
        publish_mutual_funds(store, fetch=lambda: dict(snapshot(), fetchedAt='2026-11-07T02:00:00+00:00'))
        self.assertEqual(store.uploads, [])

    def test_a_damaged_upload_never_reaches_the_pointer(self):
        for damaged in ('releases/mf/', 'site/data/mf/'):
            store = FakeR2(corrupt=damaged)
            with self.subTest(damaged), self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                publish_mutual_funds(store, fetch=snapshot)
            if damaged == 'releases/mf/':
                self.assertNotIn(LIVE_KEY, store.uploads)

    def test_keeps_the_live_snapshot_for_older_or_much_smaller_data(self):
        store = FakeR2({LIVE_KEY: json.dumps({'revision': 'a' * 64, 'navDate': '2026-11-06', 'fundCount': 1844}).encode()})
        for stale, message in ((lambda: snapshot('2026-11-05', 1844), 'older'), (lambda: snapshot('2026-11-07', 1000), 'Only 1000')):
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                publish_mutual_funds(store, fetch=stale)
        self.assertEqual(store.uploads, [])
        self.assertEqual(json.loads(store.objects[LIVE_KEY])['revision'], 'a' * 64)


class EntryPointTests(unittest.TestCase):
    def test_a_ci_run_without_r2_settings_fails_before_fetching(self):
        fetch = Mock()
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}, clear=True), patch.object(publisher, 'fetch_snapshot', fetch):
            self.assertEqual(publisher.main(), 1)
        fetch.assert_not_called()

    def test_local_runs_write_the_release_then_the_pointer_and_keep_newer_data(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            publisher.write_local(snapshot('2026-11-06'), output)
            pointer = json.loads((output / POINTER).read_text())
            self.assertTrue((output / 'mf/revisions' / pointer['revision'] / 'funds.json.gz').is_file())
            with self.assertRaisesRegex(ValueError, 'older'):
                publisher.write_local(snapshot('2026-11-05'), output)
            self.assertEqual(json.loads((output / POINTER).read_text()), pointer)
            self.assertEqual(sorted(path.name for path in output.rglob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
