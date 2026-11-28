"""US state in R2 (tools/us_state.py), against a fake store backed by a folder."""
import io
import json
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import us_state  # noqa: E402


class Store:
    """rclone's copyto/cat/lsf/lsjson over a local folder standing in for the bucket."""
    def __init__(self, bucket: Path):
        self.bucket = bucket

    def remote(self, key):
        return 'r2:' + key

    def _path(self, value):
        return self.bucket / value[3:] if value.startswith('r2:') else Path(value)

    def run(self, command, source, target=None, *args):
        if command == 'deletefile':
            self._path(source).unlink()
            return
        assert command == 'copyto'
        destination = self._path(target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self._path(source), destination)

    def cache_command(self, command, target, *args, data=None):
        path = self._path(target)
        if command == 'rcat':
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return b''
        if command == 'cat':
            return path.read_bytes()
        if command == 'lsf':
            return '\n'.join(p.name for p in path.iterdir() if p.is_file()).encode() if path.is_dir() else b''
        if command == 'lsjson':
            return json.dumps([{'Size': path.stat().st_size}]).encode()
        raise AssertionError(command)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.store = Store(self.tmp / 'bucket')

    def root(self, name):
        return self.tmp / name

    def seed(self, root):
        """One file in every configured folder and every carried file."""
        contents = {}
        for folder in us_state.FOLDERS:
            (root / folder).mkdir(parents=True, exist_ok=True)
            name = {'ohlcv_data': 'AAPL.csv', 'indices_ohlcv_data': 'SPY.csv', 'market_news': 'AAPL_news.json'}.get(folder, 'AAPL.json.gz')
            contents[f'{folder}/{name}'] = f'{folder} data'.encode()
            (root / folder / name).write_bytes(contents[f'{folder}/{name}'])
        for name in us_state.FILES:
            contents[name] = f'{name} data'.encode()
            (root / name).write_bytes(contents[name])
        return contents

    def test_a_round_trip_restores_every_folder_and_file_and_keeps_the_previous_copy(self):
        first = self.root('first')
        us_state.pull(self.store, first)  # cold start: nothing in R2
        contents = self.seed(first)
        us_state.push(self.store, first)
        stored = {p.name for p in (self.tmp / 'bucket' / us_state.PREFIX).iterdir() if p.is_file()}
        self.assertEqual(stored, {us_state.archive_name(folder) for folder in us_state.FOLDERS} | set(us_state.FILES))
        self.assertIn('stock_pages.tar', stored)  # the uncompressed archive for already-compressed pages
        second = self.root('second')
        us_state.pull(self.store, second)
        for name, data in contents.items():
            self.assertEqual((second / name).read_bytes(), data, name)
        (second / 'ohlcv_data' / 'MSFT.csv').write_text('x')
        us_state.push(self.store, second, ['ohlcv_data'])
        self.assertTrue((self.tmp / 'bucket' / us_state.PREFIX / 'previous' / 'ohlcv_data.tar.gz').exists())

    def write(self, root, text):
        (root / 'ohlcv_data' / 'AAPL.csv').write_text(text)

    def previous(self):
        path = self.tmp / 'bucket' / us_state.PREFIX / 'previous' / 'ohlcv_data.tar.gz'
        with tarfile.open(path) as archive:
            return archive.extractfile('AAPL.csv').read().decode()

    def test_previous_keeps_the_last_good_state_through_unverified_runs(self):
        root = self.root('first')
        us_state.pull(self.store, root)
        self.seed(root)
        self.write(root, 'good A')
        us_state.push(self.store, root)
        self.write(root, 'good B')
        us_state.push(self.store, root, ['ohlcv_data'])  # B is current, A is previous
        self.assertEqual(self.previous(), 'good A')
        for text in ('bad run', 'no-op run'):
            self.write(root, text)
            us_state.push(self.store, root, ['ohlcv_data'], unverified=True)
            # B, the last good copy, moved to previous/ before the first unverified push replaced it
            self.assertEqual(self.previous(), 'good B')
        mark = self.tmp / 'bucket' / us_state.PREFIX / ('ohlcv_data.tar.gz' + us_state.UNVERIFIED)
        self.assertTrue(mark.exists())
        second = self.root('second')
        us_state.pull(self.store, second)
        self.assertEqual((second / 'ohlcv_data' / 'AAPL.csv').read_text(), 'no-op run')  # the current copy moves on
        self.assertFalse((second / 'ohlcv_data.tar.gz.unverified').exists())
        # The next good run does not rotate the unverified copy into previous/, and clears the mark.
        self.write(second, 'good C')
        us_state.push(self.store, second, ['ohlcv_data'])
        self.assertEqual(self.previous(), 'good B')
        self.assertFalse(mark.exists())
        self.write(second, 'good D')
        us_state.push(self.store, second, ['ohlcv_data'])
        self.assertEqual(self.previous(), 'good C')

    def test_keep_previous_touches_neither_previous_nor_the_mark(self):
        root = self.root('first')
        us_state.pull(self.store, root)
        self.seed(root)
        us_state.push(self.store, root)
        self.write(root, 'good')
        us_state.push(self.store, root, ['ohlcv_data'])
        before = self.previous()
        mark = self.tmp / 'bucket' / us_state.PREFIX / ('ohlcv_data.tar.gz' + us_state.UNVERIFIED)
        self.write(root, 'ledger pass')
        us_state.push(self.store, root, ['ohlcv_data'], keep_previous=True)
        self.assertEqual(self.previous(), before)
        self.assertFalse(mark.exists())  # a good run's copy is not marked by it
        # After an unverified push, the mark survives a keep_previous push, and previous/ still holds the good copy.
        self.write(root, 'bad run')
        us_state.push(self.store, root, ['ohlcv_data'], unverified=True)
        self.assertTrue(mark.exists())
        before = self.previous()
        self.write(root, 'ledger pass after a bad run')
        us_state.push(self.store, root, ['ohlcv_data'], keep_previous=True)
        self.assertTrue(mark.exists())
        self.assertEqual(self.previous(), before)

    def test_a_half_written_temp_file_is_not_carried(self):
        first = self.root('first')
        us_state.pull(self.store, first)
        self.seed(first)
        (first / 'ohlcv_data' / 'AAPL.csv.tmp').write_text('cut short')
        us_state.push(self.store, first)
        second = self.root('second')
        us_state.pull(self.store, second)
        self.assertTrue((second / 'ohlcv_data' / 'AAPL.csv').exists())
        self.assertFalse((second / 'ohlcv_data' / 'AAPL.csv.tmp').exists())

    def test_a_root_that_was_not_pulled_never_overwrites_r2(self):
        root = self.root('fresh')
        (root / 'ohlcv_data').mkdir(parents=True)
        (root / 'ohlcv_data' / 'A.csv').write_text('x')
        with self.assertRaises(RuntimeError):
            us_state.push(self.store, root)

    def test_an_empty_folder_leaves_the_stored_archive_alone(self):
        first = self.root('first')
        us_state.pull(self.store, first)
        self.seed(first)
        us_state.push(self.store, first)
        archive = self.tmp / 'bucket' / us_state.PREFIX / 'ohlcv_data.tar.gz'
        before = archive.read_bytes()
        second = self.root('second')
        us_state.pull(self.store, second)
        shutil.rmtree(second / 'ohlcv_data')
        us_state.push(self.store, second)
        self.assertEqual(archive.read_bytes(), before)

    def test_an_archive_entry_outside_its_folder_is_refused(self):
        bad = self.tmp / 'bad.tar'
        with tarfile.open(bad, 'w') as archive:
            data = b'x'
            info = tarfile.TarInfo('../escape.txt')
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        with self.assertRaises(RuntimeError):
            us_state.unpack(bad, self.tmp / 'target')
        self.assertFalse((self.tmp / 'escape.txt').exists())  # nothing written outside the folder

    def test_the_earnings_pulse_archive_is_copied_by_hash(self):
        bucket = self.tmp / 'bucket'
        (bucket / 'site/data/results').mkdir(parents=True)
        (bucket / 'objects').mkdir(parents=True)
        index = {'quarters': {'2026-Q4': {'published': {'sha256': 'a' * 64, 'count': 2}, 'upcoming': {'sha256': 'b' * 64, 'count': 0}}}}
        (bucket / us_state.PULSE_INDEX).write_text(json.dumps(index))
        (bucket / 'objects' / f"{'a' * 64}.json.gz").write_bytes(b'rows')
        root = self.root('pulse')
        us_state.pulse(self.store, root)
        self.assertEqual(json.loads((root / 'earnings_pulse' / 'us_index.json').read_text()), index)
        self.assertTrue((root / 'earnings_pulse' / f"{'a' * 64}.json.gz").exists())
        self.assertFalse((root / 'earnings_pulse' / f"{'b' * 64}.json.gz").exists())  # an empty part is not copied


if __name__ == '__main__':
    unittest.main()
