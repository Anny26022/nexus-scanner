from datetime import datetime, timedelta, timezone
import gzip
import json
import tempfile
import unittest

from test_publish_mutual_funds import FakeR2
from mf_release import write_release
from publish_mf_holdings import AUM_REFRESH_DAYS, POINTER, previous_aums, publish_holdings

LIVE_KEY = f'site/data/{POINTER}'


def week(newest='2026-06-15', with_holdings=3, **_):
    files = {'summary.json.gz': {'funds': [], 'newest': newest}, 'holdings/INF000000001.json.gz': {'holdings': [1]},
             'holders/INE040A01034.json.gz': {'holders': [1]}, 'fund-houses.json.gz': {'fundHouses': []}, 'nfos.json.gz': {'open': []}}
    report = {'fetchedAt': 'now', 'fundCount': 3, 'withHoldings': with_holdings, 'stockCount': 1,
              'portfolioDates': {'oldest': '2026-05-31', 'newest': newest}}
    return files, report


class PublishHoldingsTests(unittest.TestCase):
    def test_publishes_the_release_then_the_pointer(self):
        store = FakeR2()
        pointer = publish_holdings(store, fetch=week)
        release = f"releases/mf-holdings/{pointer['revision']}"
        self.assertLess(store.uploads.index(f'{release}/summary.json.gz'), store.uploads.index(LIVE_KEY))
        self.assertIn(f'{release}/holders/INE040A01034.json.gz', store.objects)
        self.assertEqual(pointer['holdersUrlTemplate'], f"/data/mf/holdings/revisions/{pointer['revision']}/holders/{{isin}}.json.gz")
        self.assertEqual(json.loads(store.objects[LIVE_KEY]), pointer)
        self.assertEqual(json.loads(gzip.decompress(store.objects[f'{release}/holdings/INF000000001.json.gz'])), {'holdings': [1]})

    def test_unchanged_weeks_publish_nothing_and_old_weeks_are_pruned(self):
        store = FakeR2()
        first = publish_holdings(store, fetch=week)
        store.uploads.clear()
        publish_holdings(store, fetch=week)
        self.assertEqual(store.uploads, [])
        second = publish_holdings(store, fetch=lambda **_: week('2026-06-30'))
        third = publish_holdings(store, fetch=lambda **_: week('2026-07-31'))
        releases = {key.split('/')[2] for key in store.objects if key.startswith('releases/mf-holdings/')}
        self.assertEqual(releases, {second['revision'], third['revision']})
        self.assertNotIn(first['revision'], releases)

    def test_keeps_the_live_week_for_fewer_funds_or_older_portfolios(self):
        store = FakeR2()
        live = publish_holdings(store, fetch=week)
        for stale, message in ((lambda **_: week(with_holdings=1), 'only 1 funds'), (lambda **_: week('2026-05-31'), 'older')):
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                publish_holdings(store, fetch=stale)
        self.assertEqual(json.loads(store.objects[LIVE_KEY])['revision'], live['revision'])


class AumReuseTests(unittest.TestCase):
    def test_last_weeks_aum_is_passed_on_until_it_is_a_month_old(self):
        store, seen = FakeR2(), []
        summary = {'funds': [{'isin': 'INF000000001', 'aumHistory': [['2026-09', 5.0]]}, {'isin': 'INF000000002', 'aumHistory': None}]}

        def fetch(**kwargs):
            seen.append(kwargs)
            files, report = week(newest=f'2026-06-{10 + len(seen)}')
            files['summary.json.gz'] = summary
            return files, dict(report, aumFetchedAt=kwargs['aum_fetched_at'] or '2026-11-01T05:00:00+00:00')
        first = publish_holdings(store, fetch=fetch)
        self.assertEqual(seen[0], {'previous_aums': None, 'aum_fetched_at': None})
        live = json.loads(store.objects['site/data/mf/holdings.json'])
        fresh = datetime(2026, 11, 8, tzinfo=timezone.utc)
        self.assertEqual(previous_aums(store, live, now=fresh), {'INF000000001': [['2026-09', 5.0]]})
        self.assertIsNone(previous_aums(store, live, now=datetime(2026, 11, 1, 5, tzinfo=timezone.utc) + timedelta(days=AUM_REFRESH_DAYS)))
        self.assertIsNone(previous_aums(store, None))
        self.assertEqual(first['aumFetchedAt'], '2026-11-01T05:00:00+00:00')


class ReleaseFileTests(unittest.TestCase):
    def test_file_names_cannot_leave_the_release_folder(self):
        for name in ('../escape.json.gz', '/etc/x.json.gz', 'holders/../../x.json.gz', ''):
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(ValueError, 'Unsafe'):
                write_release(folder, {name: {}})


if __name__ == '__main__':
    unittest.main()
