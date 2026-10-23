import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import pipeline_state


class FakeStore:
    """An in-memory bucket speaking the R2Store calls pipeline_state uses."""

    def __init__(self, objects=None, corrupt=False):
        self.objects, self.corrupt, self.calls = dict(objects or {}), corrupt, []

    def remote(self, key):
        return f'r2:{key}'

    def run(self, command, source, target):
        self.calls.append((command, source, target))
        data = self.objects[source[3:]] if source.startswith('r2:') else Path(source).read_bytes()
        if target.startswith('r2:'):
            self.objects[target[3:]] = data
        else:
            Path(target).write_bytes(data)

    def cache_command(self, command, target, *args):
        if command == 'lsf':
            prefix = target[3:]
            return '\n'.join(key[len(prefix):] for key in self.objects
                             if key.startswith(prefix) and '/' not in key[len(prefix):]).encode()
        return b'corrupt' if self.corrupt else self.objects[target[3:]]


class PipelineStateTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.directory = Path(self.folder.name)
        self.first, self.second = pipeline_state.FILES[:2]

    def tearDown(self):
        self.folder.cleanup()

    def test_pull_prefers_r2_and_keeps_the_committed_copy_until_r2_has_one(self):
        (self.directory / self.first).write_bytes(b'committed')
        (self.directory / self.second).write_bytes(b'committed')
        store = FakeStore({f'pipeline-state/{self.first}': b'from r2', f'pipeline-state/previous/{self.second}': b'old'})
        pipeline_state.pull(store, self.directory)
        self.assertEqual((self.directory / self.first).read_bytes(), b'from r2')
        self.assertEqual((self.directory / self.second).read_bytes(), b'committed')  # only previous/ exists

    def test_push_keeps_one_previous_version_and_verifies_the_upload(self):
        (self.directory / self.first).write_bytes(b'new')
        store = FakeStore({f'pipeline-state/{self.first}': b'old'})
        pipeline_state.push(store, self.directory)
        self.assertEqual(store.objects[f'pipeline-state/{self.first}'], b'new')
        self.assertEqual(store.objects[f'pipeline-state/previous/{self.first}'], b'old')
        self.assertNotIn(f'pipeline-state/{self.second}', store.objects)  # not produced: R2 copy kept

    def test_a_failed_read_back_stops_the_run(self):
        (self.directory / self.first).write_bytes(b'new')
        with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
            pipeline_state.push(FakeStore(corrupt=True), self.directory)

    def test_without_r2_settings_nothing_happens(self):
        with patch('chart_publication.missing_r2_settings', return_value=['R2_BUCKET']):
            self.assertEqual(pipeline_state.main(['push']), 0)

    def test_covers_exactly_the_files_refreshes_used_to_commit(self):
        old = subprocess.run(['git', 'show', 'origin/main:.github/actions/commit-refresh-outputs/action.yml'],
                             capture_output=True, text=True, cwd=pipeline_state.ROOT)
        if old.returncode:
            self.skipTest('origin/main is not available')
        committed = re.findall(r'git add "DO NOT DELETE EDL PIPELINE/([^"]+)"', old.stdout)
        if not committed:
            self.skipTest('origin/main already stores pipeline state in R2')
        self.assertEqual(sorted(committed), sorted(pipeline_state.FILES))
        self.assertEqual(len(set(pipeline_state.FILES)), len(pipeline_state.FILES))


if __name__ == '__main__':
    unittest.main()
