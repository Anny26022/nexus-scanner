import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import session_history


class FakeStore:
    base_url = 'https://data.example.com'

    def __init__(self, corrupt=False):
        self.objects, self.corrupt = {}, corrupt

    def remote(self, key):
        return f'charts:bucket/{key}'

    def run(self, command, source, target, *args):
        self.objects[target] = Path(source).read_bytes()

    def cache_command(self, command, target):
        return b'corrupt' if self.corrupt else self.objects[target]


class PlainSnapshotOffloadTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.output = Path(self.folder.name)
        self.revision = 'a' * 64
        self.plain = self.output / 'revisions' / self.revision / 'stocks.json'
        self.plain.parent.mkdir(parents=True)
        self.plain.write_text('{"stocks":[]}')
        self.manifest = {'revision': self.revision, 'datasetUrl': f'/data/revisions/{self.revision}/stocks.json'}

    def tearDown(self):
        self.folder.cleanup()

    def offload(self, store):
        with patch.dict(os.environ, {'EDL_CHART_STORAGE': 'r2'}), \
                patch('session_history.charts_enabled', return_value=True), \
                patch('session_history.R2Store', return_value=store):
            return session_history.offload_plain_snapshot(self.output, self.manifest)

    def test_moves_the_plain_list_to_r2_and_points_the_release_at_it(self):
        store = FakeStore()
        manifest = self.offload(store)
        self.assertEqual(manifest['datasetUrl'], f'https://data.example.com/releases/{self.revision}/stocks.json')
        self.assertEqual(store.objects[f'charts:bucket/releases/{self.revision}/stocks.json'], b'{"stocks":[]}')
        self.assertFalse(self.plain.exists())

    def test_a_failed_read_back_keeps_the_file_and_stops_publication(self):
        with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
            self.offload(FakeStore(corrupt=True))
        self.assertTrue(self.plain.exists())

    def test_without_r2_the_release_is_unchanged(self):
        with patch.dict(os.environ, {'EDL_CHART_STORAGE': 'local'}):
            self.assertIs(session_history.offload_plain_snapshot(self.output, self.manifest), self.manifest)
        self.assertTrue(self.plain.exists())


if __name__ == '__main__':
    unittest.main()
