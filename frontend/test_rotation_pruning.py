import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from chart_publication import R2Store
import rotation_history


class MemoryStore(R2Store):
    """R2Store's pruning logic against an in-memory bucket (no rclone)."""
    def __init__(self, files=None):
        self.bucket, self.files, self.deleted = 'test', dict(files or {}), []

    def cache_command(self, *args, data=None):
        command, target = args[0], args[-1] if args[0] == 'cat' else args[2]
        key = target.split('test/', 1)[1]
        if command == 'cat':
            if key not in self.files:
                raise subprocess.CalledProcessError(3, 'rclone cat')
            return self.files[key]
        self.files[key] = Path(args[1]).read_bytes()  # copyto local -> remote

    def run(self, *args):
        assert args[0] == 'delete'
        names = Path(args[args.index('--files-from') + 1]).read_text().split()
        for name in names:
            self.files.pop(f'objects/{name}', None)
        self.deleted += names


def release(folder, label):
    """Write one release's rotation objects locally and return (index hash, object names)."""
    index = {'schemaVersion': 1, 'asOfDate': label, 'frames': {}, 'benchmarks': {}, 'stocks': [], 'groups': []}
    shards = {name: {'D': {label: [0, 1]}} for name in ('core', 'rest', 'groups')}
    digest = rotation_history.write_objects(folder, index, shards)
    return digest, {path.name for path in folder.iterdir()}


class RotationPruningTests(unittest.TestCase):
    def test_keeps_this_and_the_live_release_and_deletes_older_ones(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b, tempfile.TemporaryDirectory() as c:
            first, first_names = release(Path(a), 'd1')
            second, second_names = release(Path(b), 'd2')
            third, third_names = release(Path(c), 'd3')
            uploaded = {f'objects/{name}': (Path(folder) / name).read_bytes()
                        for folder, names in ((a, first_names), (b, second_names), (c, third_names)) for name in names}
            store = MemoryStore(dict(uploaded, **{'objects/chart.json.gz': b'chart'}))
            # First publish records its files and deletes nothing.
            self.assertEqual(store.prune_rotation(Path(a), first, None), [])
            self.assertEqual(store.prune_rotation(Path(b), second, first), [])
            # The third release keeps itself and the live second one; the first goes, charts are untouched.
            removed = store.prune_rotation(Path(c), third, second)
            self.assertEqual(set(removed), first_names)
            self.assertIn('objects/chart.json.gz', store.files)
            for name in second_names | third_names:
                self.assertIn(f'objects/{name}', store.files)
            self.assertEqual(set(json.loads(store.files[R2Store.ROTATION_STATE])), second_names | third_names)

    def test_an_uncommitted_run_never_costs_the_live_release_its_files(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b, tempfile.TemporaryDirectory() as c:
            live, live_names = release(Path(a), 'd1')
            failed, failed_names = release(Path(b), 'd2')
            retry, retry_names = release(Path(c), 'd2b')
            store = MemoryStore({f'objects/{name}': (Path(folder) / name).read_bytes()
                                 for folder, names in ((a, live_names), (b, failed_names), (c, retry_names)) for name in names})
            store.prune_rotation(Path(a), live, None)
            store.prune_rotation(Path(b), failed, live)  # Uploaded, but the Git commit never landed.
            removed = store.prune_rotation(Path(c), retry, live)  # Git still points at `live`.
            self.assertEqual(set(removed), failed_names)
            for name in live_names:
                self.assertIn(f'objects/{name}', store.files)

    def test_an_unreadable_live_release_stops_pruning(self):
        with tempfile.TemporaryDirectory() as a:
            current, _ = release(Path(a), 'd1')
            store = MemoryStore({R2Store.ROTATION_STATE: json.dumps(['old.json.gz']).encode(), 'objects/old.json.gz': b'x'})
            with self.assertRaises(subprocess.CalledProcessError):
                store.prune_rotation(Path(a), current, 'f' * 64)
            self.assertIn('objects/old.json.gz', store.files)


if __name__ == '__main__':
    unittest.main()
