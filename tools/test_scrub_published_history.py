import gzip
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrub_published_history as scrub  # noqa: E402


def gz(value):
    return gzip.compress(json.dumps(value).encode(), mtime=0)


class FakeRemote:
    def __init__(self, files):
        self.files = dict(files)
        self.writes = []
        self.moved = []

    def list(self, prefix, *flags):
        keys = [key for key in self.files if key.startswith(prefix)]
        if '--dirs-only' in flags:
            return sorted({prefix + key[len(prefix):].split('/')[0] + '/' for key in keys if '/' in key[len(prefix):]})
        if '-R' in flags:
            return keys
        return [key for key in keys if '/' not in key[len(prefix):]]

    def exists(self, key):
        return key in self.files

    def read(self, key):
        return self.files[key]

    def write(self, key, data, kind):
        self.files[key] = data
        self.writes.append((key, kind))

    def move_backup(self, digest):
        self.files[f'backups/{digest}.json.gz'] = self.files.pop(f'objects/{digest}.json.gz')
        self.moved.append(digest)


ROW = {'symbol': 'A', 'debtToEquitySource': 'X', 'tradingview': {'source': 'upstream', 'values': {'m': 1}},
       'financialMetadata': {'source': 'upstream', 'basis': 'CONSOLIDATED'}}
CLEAN_ROW = {'symbol': 'A', 'extended': {'values': {'m': 1}}, 'financialMetadata': {'basis': 'CONSOLIDATED'}}
R = 'a' * 64
FILES = {
    'snapshots/2021-10-01.json.gz': gz({'revision': R, 'stocks': [ROW], 'tradingViewMetricsVersion': 1}),
    'snapshots/2026-10-23.json.gz': gz({'revision': R, 'stocks': [CLEAN_ROW]}),
    f'releases/{R}/stocks.json': json.dumps({'revision': R, 'stocks': [ROW]}).encode(),
    f'releases/{R}/index.json': json.dumps({'revision': 'c', 'archives': {'raw': 'b' * 64}, 'archivesAsOf': 't'}).encode(),
    f'releases/{R}/release.json': json.dumps({'revision': R}).encode(),
    f'monthly/2026-09/c/releases/{R}.json': json.dumps({'revision': R}).encode(),
    'monthly/2026-09/c/charts/A.json.gz': b'not json',
    f'objects/{"b" * 64}.json.gz': b'backup',
}


class ScrubTests(unittest.TestCase):
    def test_report_only_changes_nothing(self):
        remote = FakeRemote(FILES)
        report = scrub.run(remote, apply=False, workers=1)
        self.assertEqual(remote.files, FILES)
        self.assertEqual((report['wouldRewrite'], report['clean'], report['backupsReferenced']), (3, 3, 1))
        self.assertEqual(report['errors'], {})

    def test_apply_rewrites_history_and_moves_backups_privately(self):
        remote = FakeRemote(FILES)
        report = scrub.run(remote, apply=True, workers=1)
        self.assertEqual(report['errors'], {})
        snapshot = json.loads(gzip.decompress(remote.files['snapshots/2021-10-01.json.gz']))
        self.assertEqual(snapshot, {'revision': R, 'stocks': [CLEAN_ROW], 'extendedMetricsVersion': 1})
        self.assertEqual(json.loads(remote.files[f'releases/{R}/stocks.json'])['stocks'], [CLEAN_ROW])
        self.assertEqual(json.loads(remote.files[f'releases/{R}/index.json']), {'revision': 'c'})
        self.assertEqual(json.loads(remote.files[f'backups/releases/{R}.json']), {'raw': 'b' * 64, 'asOf': 't'})
        self.assertIn(f'backups/{"b" * 64}.json.gz', remote.files)
        self.assertNotIn(f'objects/{"b" * 64}.json.gz', remote.files)
        self.assertEqual(dict(remote.writes)[f'releases/{R}/stocks.json'], 'stocks')
        self.assertNotIn('monthly/2026-09/c/charts/A.json.gz', dict(remote.writes))
        # A second run finds nothing left to do.
        writes = len(remote.writes)
        again = scrub.run(remote, apply=True, workers=1)
        self.assertEqual((again['rewritten'], again['backupsMoved']), (0, 0))
        self.assertEqual(len(remote.writes), writes)

    def test_a_failed_file_is_reported_and_the_rest_continue(self):
        files = dict(FILES, **{'snapshots/2022-01-03.json.gz': b'corrupt'})
        report = scrub.run(FakeRemote(files), apply=True, workers=1)
        self.assertEqual(list(report['errors']), ['snapshots/2022-01-03.json.gz'])
        self.assertEqual(report['rewritten'], 3)


if __name__ == '__main__':
    unittest.main()
