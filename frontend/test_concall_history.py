import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import requests

from unittest.mock import Mock

from concall_history import iso_date, list_page, refresh


class Store:
    base_url = 'https://data.example'

    def __init__(self):
        self.objects = {}

    def upload_objects(self, folder, known=()):
        for path in folder.glob('*.json.gz'):
            self.objects[path.name] = path.read_bytes()

    def load(self, item):
        compressed = self.objects[item['sha256'] + '.json.gz']
        assert hashlib.sha256(compressed).hexdigest() == item['sha256']
        return json.loads(gzip.decompress(compressed))


def row(slug, symbol='TEST', date='05 November 2026'):
    return dict(slug_id=slug, company_symbol=symbol, company_name=symbol.title(), concall_quarter='Q2FY27',
                concall_date=date, sector='Industrials', pdf_link='https://www.bseindia.com/x.pdf', news_id='n',
                live_data={'ltp': 1})


def detail(slug, summary='## Key Takeaways'):
    return dict(slug_id=slug, concall_date='2026-11-05', concall_time='16:00', markdown_summary=summary,
                transcript_with_names=[{'speakername': 'CEO', 'text': 'hi'}], call_recording_url='https://s3/x?sig',
                stream_sid='s', forensic_flags={'flags': []})


class Provider:
    def __init__(self, pages, details=None, fail_pages=()):
        self.pages, self.details, self.fail_pages = pages, details or {}, set(fail_pages)
        self.listed, self.fetched = [], []

    def list_page(self, page):
        self.listed.append(page)
        if page in self.fail_pages:
            raise requests.ConnectionError('down')
        return self.pages[page - 1], page < len(self.pages)

    def fetch_detail(self, slug):
        self.fetched.append(slug)
        return self.details.get(slug) or detail(slug)


class ConcallHistoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.output = Path(self.folder.name) / 'concalls/index.json'
        self.store = Store()

    def tearDown(self):
        self.folder.cleanup()

    def run_refresh(self, provider, full=False):
        return refresh(self.output, self.store, provider.list_page, provider.fetch_detail, full=full,
                       checked_at='2026-11-21T16:30:00+05:30', workers=2)

    def index(self):
        return json.loads(self.output.read_text())

    def test_first_run_stores_every_call_without_private_fields(self):
        provider = Provider([[row('a-q2-fy27', 'A'), row('b-q2-fy27', 'B')], [row('c-q1-fy27', 'C')]])
        report = self.run_refresh(provider)
        self.assertEqual((report['added'], report['pending'], report['errors']), (3, 0, {}))
        entry = self.index()['calls']['a-q2-fy27']
        self.assertEqual((entry['symbol'], entry['date'], entry['time']), ('A', '2026-11-05', '16:00'))
        stored = self.store.load(entry['object'])['call']
        self.assertEqual(stored['markdown_summary'], '## Key Takeaways')
        self.assertNotIn('call_recording_url', stored)
        self.assertNotIn('stream_sid', stored)
        self.assertNotIn('news_id', entry)

    def test_daily_run_stops_at_the_first_fully_stored_page_and_fetches_only_new_calls(self):
        self.run_refresh(Provider([[row('a'), row('b')], [row('c')]]))
        provider = Provider([[row('new'), row('a')], [row('b')], [row('c')]])
        report = self.run_refresh(provider)
        self.assertEqual(provider.fetched, ['new'])
        self.assertEqual(provider.listed, [1, 2])
        self.assertEqual(report['added'], 1)

    def test_nothing_new_fetches_nothing_and_leaves_the_index_untouched(self):
        self.run_refresh(Provider([[row('a')]]))
        before = self.output.read_bytes()
        provider = Provider([[row('a')]])
        self.run_refresh(provider)
        self.assertEqual(provider.fetched, [])
        self.assertEqual(self.output.read_bytes(), before)

    def test_full_run_walks_every_page_but_still_skips_stored_calls(self):
        self.run_refresh(Provider([[row('a')], [row('b')]]))
        provider = Provider([[row('a')], [row('b')], [row('late')]])
        self.run_refresh(provider, full=True)
        self.assertEqual(provider.listed, [1, 2, 3])
        self.assertEqual(provider.fetched, ['late'])

    def test_a_recent_call_without_a_summary_is_kept_pending_and_retried(self):
        provider = Provider([[row('a', date='18 November 2026')]], {'a': detail('a', summary='')})
        report = self.run_refresh(provider)
        self.assertEqual(report['pending'], 1)
        entry = self.index()['calls']['a']
        self.assertEqual((entry['object'], entry['attempts']), (None, 1))
        provider = Provider([[row('a', date='18 November 2026')]])
        self.run_refresh(provider)
        entry = self.index()['calls']['a']
        self.assertTrue(entry['object'])
        self.assertNotIn('attempts', entry)

    def test_daily_runs_retry_only_recent_pending_calls_but_the_weekly_one_retries_all(self):
        # Pending summaries come back without a date, so the list date (16 days before the run) is what counts.
        self.run_refresh(Provider([[row('a')]], {'a': {**detail('a', summary=''), 'concall_date': None}}))
        self.assertEqual(self.index()['calls']['a']['date'], '2026-11-05')
        daily = Provider([[row('a')]])
        self.run_refresh(daily)
        self.assertEqual(daily.fetched, [])
        weekly = Provider([[row('a')]])
        self.run_refresh(weekly, full=True)
        self.assertEqual(weekly.fetched, ['a'])

    def test_a_list_failure_keeps_stored_calls_and_still_fetches_what_was_listed(self):
        self.run_refresh(Provider([[row('a')]]))
        provider = Provider([[row('new')], [row('a')]], fail_pages={2})
        report = self.run_refresh(provider)
        self.assertIn('list-page-2', report['errors'])
        self.assertEqual(set(self.index()['calls']), {'a', 'new'})
        self.assertTrue(self.index()['calls']['new']['object'])

    def test_a_detail_failure_is_pending_not_fatal(self):
        class Failing(Provider):
            def fetch_detail(self, slug):
                if slug == 'bad':
                    raise requests.Timeout('slow')
                return super().fetch_detail(slug)
        report = self.run_refresh(Failing([[row('ok'), row('bad')]]))
        self.assertEqual((report['added'], report['pending']), (1, 1))
        self.assertEqual(self.index()['calls']['bad']['lastError'], 'slow')

    def test_an_invalid_index_is_not_discarded(self):
        self.output.parent.mkdir(parents=True)
        self.output.write_text('{"version": 2}')
        with self.assertRaises(ValueError):
            self.run_refresh(Provider([[row('a')]]))

    def test_list_keeps_ampersand_slugs_and_skips_malformed_rows(self):
        response = Mock(status_code=200)
        response.json.return_value = {'status': 'success', 'data': {
            'concalls': [row('m&m-q2-fy27', 'M&M'), row('-q1-fy27', 'SIMPLEXCAS'), row('ok-q2-fy27', ''),
                         row('tcs-q2-fy27', 'TCS')], 'pagination': {'has_next': True}}}
        session = Mock()
        session.post.return_value = response
        rows, has_next = list_page(session, 6)
        self.assertEqual([r['slug_id'] for r in rows], ['m&m-q2-fy27', 'tcs-q2-fy27'])
        self.assertTrue(has_next)

    def test_an_old_call_is_still_fetched_once(self):
        provider = Provider([[row('old', date='09 July 2026')]])
        self.run_refresh(provider)
        self.assertEqual(provider.fetched, ['old'])

    def test_dates(self):
        self.assertEqual(iso_date('05 November 2026'), '2026-11-05')
        self.assertEqual(iso_date('2026-11-05'), '2026-11-05')
        self.assertIsNone(iso_date('Yesterday'))


if __name__ == '__main__':
    unittest.main()
