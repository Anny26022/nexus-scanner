from datetime import datetime, timezone
import gzip
import json
import unittest

from publish_etfs import publish_etfs  # puts the pipeline checkout on sys.path
from fetch_etf_snapshot import COLUMNS, normalize
from test_packed_snapshot import decode_packed_snapshot

REVISION = 'a' * 64


class FakeR2:
    """The rclone calls publish_etfs makes, on a dict of keys."""
    def __init__(self, current, on_upload=None):
        self.objects = {'site/data/current.json': json.dumps(current).encode()}
        self.on_upload = on_upload

    def remote(self, key):
        return f'charts:bucket/{key}'

    def cache_command(self, action, *args, data=None):
        if action == 'cat':
            return self.objects[args[0].split('/', 1)[1]]
        if action == 'copyto':
            source, target = args[0], args[1].split('/', 1)[1]
            with open(source, 'rb') as handle:
                self.objects[target] = handle.read()
            if self.on_upload:
                self.on_upload(self, target)
            return b''
        raise AssertionError(f'unexpected rclone {action}')


def etf_source(stamp, fetched_at):
    values = dict(symbol='NIFTYBEES', time=datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc).timestamp(),
                  close=284.21, exchange='NSE', type='fund', subtype='etf', currency='INR', description='Nifty ETF')
    return normalize({'totalCount': 1, 'data': [{'s': 'NSE:NIFTYBEES', 'd': [values.get(field) for field in COLUMNS]}]},
                     fetched_at)


class PublishEtfsTests(unittest.TestCase):
    def setUp(self):
        self.live = {'revision': REVISION, 'sessionDate': '2026-11-08', 'datasetPackedGzipUrl': f'/data/revisions/{REVISION}/stocks.packed.json.gz'}

    def test_adds_the_etf_file_to_the_live_release_and_points_current_json_at_it(self):
        store = FakeR2(self.live)
        # The Muhurat case: quotes stamped with the next open before it happened.
        published = publish_etfs(store, fetch=lambda: etf_source('2026-11-09T03:45:00', '2026-11-08T20:00:00Z'))
        url = published['etfDatasetUrl']
        self.assertRegex(url, rf'^/data/revisions/{REVISION}/etfs-[a-f0-9]{{16}}\.json\.gz$')
        key = 'releases/' + url.removeprefix('/data/revisions/')
        snapshot = decode_packed_snapshot(json.loads(gzip.decompress(store.objects[key])))
        self.assertEqual((snapshot['revision'], snapshot['asOfDate'], snapshot['totalStocks']), (REVISION, '2026-11-08', 1))
        current = json.loads(store.objects['site/data/current.json'])
        self.assertEqual(current, {**self.live, 'etfDatasetUrl': url})

    def test_leaves_current_json_alone_when_a_newer_release_went_live_meanwhile(self):
        def newer_release(store, key):
            if key.startswith('releases/'):
                store.objects['site/data/current.json'] = json.dumps({**self.live, 'revision': 'b' * 64}).encode()
        store = FakeR2(self.live, on_upload=newer_release)
        with self.assertRaisesRegex(RuntimeError, 'newer release'):
            publish_etfs(store, fetch=lambda: etf_source('2026-11-08T08:50:00', '2026-11-08T20:00:00Z'))
        self.assertEqual(json.loads(store.objects['site/data/current.json'])['revision'], 'b' * 64)

    def test_refuses_etfs_that_do_not_match_the_live_session(self):
        store = FakeR2(self.live)
        with self.assertRaises(ValueError):
            publish_etfs(store, fetch=lambda: etf_source('2026-11-06T08:50:00', '2026-11-08T20:00:00Z'))
        self.assertEqual(list(store.objects), ['site/data/current.json'])


if __name__ == '__main__':
    unittest.main()
