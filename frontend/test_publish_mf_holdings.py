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
    def setUp(self):
        self.store, self.seen, self.fetched = FakeR2(), [], datetime.now(timezone.utc).isoformat()
        self.summary = {'funds': [{'isin': 'INF000000001', 'aumHistory': [['2026-09', 5.0]]},
                                  {'isin': 'INF000000002', 'aumHistory': []}, {'isin': 'INF000000003', 'aumHistory': None}]}

    def fetch(self, newest='2026-06-11', refreshed=None):
        def fetch(**kwargs):
            self.seen.append(kwargs)
            files, report = week(newest=newest)
            files['summary.json.gz'] = self.summary
            return files, dict(report, aumFetchedAt=kwargs['aum_fetched_at'] or refreshed or self.fetched)
        return fetch

    def test_the_next_week_gets_last_weeks_aum_until_it_is_a_month_old(self):
        publish_holdings(self.store, fetch=self.fetch())
        second = publish_holdings(self.store, fetch=self.fetch('2026-06-12'))
        # Empty histories are answers too; a missing one (None) is asked again.
        self.assertEqual(self.seen, [{'previous_aums': None, 'aum_fetched_at': None},
                                     {'previous_aums': {'INF000000001': [['2026-09', 5.0]], 'INF000000002': []}, 'aum_fetched_at': self.fetched}])
        self.assertEqual(second['aumFetchedAt'], self.fetched)
        fetched = datetime.fromisoformat(self.fetched)
        self.assertIsNone(previous_aums(self.store, second, now=fetched + timedelta(days=AUM_REFRESH_DAYS)))
        self.assertIsNone(previous_aums(self.store, None))

    def test_an_aum_refresh_with_the_same_files_still_records_its_time(self):
        first = publish_holdings(self.store, fetch=self.fetch())
        stale = dict(first, aumFetchedAt='2026-01-01T00:00:00+00:00')  # a month-old refresh time, files unchanged
        self.store.objects['site/data/mf/holdings.json'] = json.dumps(stale).encode()
        self.store.uploads.clear()
        when = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        refreshed = publish_holdings(self.store, fetch=self.fetch(refreshed=when))
        self.assertEqual(self.store.uploads, ['site/data/mf/holdings.json'])  # the pointer only; the release is unchanged
        self.assertEqual((refreshed['revision'], refreshed['aumFetchedAt']), (first['revision'], when))
        self.store.uploads.clear()
        publish_holdings(self.store, fetch=self.fetch())
        self.assertEqual(self.store.uploads, [])


class ReleaseFileTests(unittest.TestCase):
    def test_file_names_cannot_leave_the_release_folder(self):
        for name in ('../escape.json.gz', '/etc/x.json.gz', 'holders/../../x.json.gz', ''):
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(ValueError, 'Unsafe'):
                write_release(folder, {name: {}})


if __name__ == '__main__':
    unittest.main()
