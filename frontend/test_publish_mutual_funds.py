import gzip
import json
from datetime import date, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import publish_mutual_funds as publisher
from publish_mutual_funds import HISTORY, POINTER, publish_mutual_funds
from mutual_fund_history import update_history

LIVE_KEY = f'site/data/{POINTER}'
STATE_KEY = f'pipeline-state/{HISTORY}'


class FakeR2:
    """The rclone calls the mutual fund publishers make, on a dict of keys."""
    def __init__(self, objects=None, corrupt=None):
        self.objects = dict(objects or {})
        self.uploads = []
        self.corrupt = corrupt  # a key prefix whose stored bytes read back damaged

    def remote(self, key):
        return f'charts:bucket/{key}'

    @staticmethod
    def key(remote):
        return remote.split('/', 1)[1]

    def read(self, key):
        return self.objects[key] + (b'!' if self.corrupt and key.startswith(self.corrupt) else b'')

    def put(self, key, data):
        self.objects[key] = data
        self.uploads.append(key)

    def cache_command(self, action, *args, data=None):
        if action == 'lsf':
            prefix = self.key(args[0])
            names = [name[len(prefix):] for name in self.objects if name.startswith(prefix)]
            if '-R' in args:
                return '\n'.join(names).encode()
            files = sorted({name for name in names if '/' not in name})
            dirs = sorted({name.split('/', 1)[0] + '/' for name in names if '/' in name})
            return '\n'.join(dirs if '--dirs-only' in args else files).encode()
        if action == 'cat':
            return self.read(self.key(args[0]))
        if action == 'copyto':
            self.put(self.key(args[1]), Path(args[0]).read_bytes())
            return b''
        raise AssertionError(f'unexpected rclone {action}')

    def run(self, action, *args):
        if action == 'copyto':
            source = self.objects[self.key(args[0])] if args[0].startswith('charts:') else Path(args[0]).read_bytes()
            self.put(self.key(args[1]), source)
        elif action in ('copy', 'check'):
            source, prefix = Path(args[0]), self.key(args[1])
            suffixes = [value[2:] for value in args if isinstance(value, str) and value.startswith('+ ')]
            for path in sorted(source.rglob('*')):
                if path.is_file() and any(path.name.endswith(suffix.lstrip('*')) and not (suffix == '*.json' and path.name.endswith('.json.gz')) for suffix in suffixes):
                    key = f'{prefix}/{path.relative_to(source)}'
                    if action == 'copy':
                        self.put(key, path.read_bytes())
                    elif self.read(key) != path.read_bytes():
                        raise RuntimeError(f'read-back mismatch: {key}')
        elif action == 'purge':
            prefix = self.key(args[0]) + '/'
            for key in [key for key in self.objects if key.startswith(prefix)]:
                del self.objects[key]
        else:
            raise AssertionError(f'unexpected rclone {action}')


def snapshot(nav_date='2026-11-06', count=3):
    funds = [{'isin': f'INF00000000{index}', 'dhanSchemeCode': str(index), 'nav': 10.0 + index, 'navDate': nav_date,
              'returns': {}, 'returnsSource': 'Dhan', 'returnsAsOf': None} for index in range(count)]
    return {'schemaVersion': 1, 'fetchedAt': '2026-11-07T01:00:00+00:00', 'navDate': nav_date, 'fundCount': count,
            'navCheck': {'amfiMatched': count, 'sameDateCompared': count, 'sameDateAgreed': count, 'navFromAmfi': count},
            'sources': {}, 'funds': funds}


def chart(code, since=None, until=None):
    """Two years of rising daily NAVs ending 2026-11-05, as Dhan's chart would give."""
    end = date(2026, 11, 5).toordinal()
    days = list(range(end - 730, end + 1))
    return days, [float(code) + 10 * (1 + 0.0004 * index) for index in range(len(days))]


def offline(history, funds):
    return update_history(history, funds, fetch=chart, workers=1, interval=0)


class PublishMutualFundsTests(unittest.TestCase):
    def publish(self, store, fetch=snapshot):
        return publish_mutual_funds(store, fetch=fetch, update=offline)

    def test_first_run_backfills_history_publishes_release_then_pointer_then_saves_history(self):
        store = FakeR2()
        pointer = self.publish(store)
        release = f"releases/mf/{pointer['revision']}"
        self.assertEqual(sorted(key for key in store.uploads if key.startswith(release)),
                         [f'{release}/funds.json.gz'] + [f'{release}/nav/INF00000000{index}.json.gz' for index in range(3)])
        self.assertLess(store.uploads.index(f'{release}/funds.json.gz'), store.uploads.index(LIVE_KEY))
        self.assertLess(store.uploads.index(LIVE_KEY), store.uploads.index(STATE_KEY))
        self.assertEqual(pointer['navUrlTemplate'], f"/data/mf/revisions/{pointer['revision']}/nav/{{isin}}.json.gz")
        self.assertEqual((pointer['history']['refetched'], pointer['history']['withMetrics']), (3, 3))
        funds = json.loads(gzip.decompress(store.objects[f'{release}/funds.json.gz']))
        fund = funds['funds'][0]
        self.assertNotIn('fetchedAt', funds)
        self.assertEqual((fund['returnsSource'], fund['returnsAsOf'], fund['metrics']['historyEnd']), ('NAV history', '2026-11-06', '2026-11-06'))
        self.assertIsNotNone(fund['returns']['1y'])
        self.assertIsNotNone(fund['metrics']['volatility1y'])
        nav = json.loads(gzip.decompress(store.objects[f'{release}/nav/INF000000000.json.gz']))
        self.assertEqual((nav['start'], nav['nav'][-1], len(nav['gaps'])), ('2024-11-05', 10.0, 732))
        history = json.loads(gzip.decompress(store.objects[STATE_KEY]))
        self.assertEqual(sorted(history['funds']), [f'INF00000000{index}' for index in range(3)])

    def test_the_next_day_appends_and_keeps_only_the_newest_releases(self):
        store = FakeR2()
        first = self.publish(store)
        second = self.publish(store, fetch=lambda: snapshot('2026-11-09'))
        self.assertEqual((second['history']['appended'], second['history']['refetched']), (3, 0))
        third = self.publish(store, fetch=lambda: snapshot('2026-11-10'))
        releases = sorted({key.split('/')[2] for key in store.objects if key.startswith('releases/mf/')})
        self.assertEqual(releases, sorted({second['revision'], third['revision']}))
        self.assertNotIn(first['revision'], releases)
        self.assertIn(f'pipeline-state/previous/{HISTORY}', store.objects)

    def test_the_same_data_fetched_again_uploads_nothing(self):
        store = FakeR2()
        self.publish(store)
        store.uploads.clear()
        self.publish(store, fetch=lambda: dict(snapshot(), fetchedAt='2026-11-07T02:00:00+00:00'))
        self.assertEqual(store.uploads, [])

    def test_a_damaged_upload_never_reaches_the_pointer(self):
        for damaged in ('releases/mf/', 'site/data/mf/'):
            store = FakeR2(corrupt=damaged)
            with self.subTest(damaged), self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                self.publish(store)
            if damaged == 'releases/mf/':
                self.assertNotIn(LIVE_KEY, store.uploads)
            self.assertNotIn(STATE_KEY, store.uploads)

    def test_keeps_the_live_snapshot_for_older_or_much_smaller_data(self):
        store = FakeR2({LIVE_KEY: json.dumps({'revision': 'a' * 64, 'navDate': '2026-11-06', 'fundCount': 1844}).encode()})
        for stale, message in ((lambda: snapshot('2026-11-05', 1844), 'older'), (lambda: snapshot('2026-11-07', 1000), 'Only 1000')):
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                self.publish(store, fetch=stale)
        self.assertEqual(store.uploads, [])

    def test_a_failing_nav_chart_stops_the_run(self):
        def broken(history, funds):
            return update_history(history, funds, fetch=Mock(side_effect=OSError('down')), workers=1, interval=0)
        with self.assertRaisesRegex(ValueError, "NAV chart failed for 25 of 25"):
            publish_mutual_funds(FakeR2(), fetch=lambda: snapshot(count=25), update=broken)


class EntryPointTests(unittest.TestCase):
    def test_a_ci_run_without_r2_settings_fails_before_fetching(self):
        fetch = Mock()
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}, clear=True), patch.object(publisher, 'fetch_snapshot', fetch):
            self.assertEqual(publisher.main(), 1)
        fetch.assert_not_called()

    def test_local_runs_write_the_release_then_the_pointer_and_keep_newer_data(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            publisher.write_local(snapshot('2026-11-06'), output, update=offline)
            pointer = json.loads((output / POINTER).read_text())
            release = output / 'mf/revisions' / pointer['revision']
            self.assertTrue((release / 'funds.json.gz').is_file())
            self.assertTrue((release / 'nav/INF000000001.json.gz').is_file())
            self.assertTrue((output / 'mf/state' / HISTORY).is_file())
            with self.assertRaisesRegex(ValueError, 'older'):
                publisher.write_local(snapshot('2026-11-05'), output, update=offline)
            self.assertEqual(json.loads((output / POINTER).read_text()), pointer)
            self.assertEqual(sorted(path.name for path in output.rglob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
