from datetime import date, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import unittest.mock

import requests

from unittest.mock import Mock

import concall_history
from concall_history import (PRIVATE_FIELDS, call_state, delete_object, fetch_detail, iso_date, list_page, post, refresh,
                             refresh_upcoming)


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


def detail(slug, summary=None):
    # Each call has its own summary; one shared by two companies is dropped.
    return dict({field: 'private' for field in PRIVATE_FIELDS}, slug_id=slug, concall_date=None,
                concall_time='16:00', markdown_summary=f'## Key Takeaways ({slug})' if summary is None else summary,
                transcript_with_names=[{'speakername': 'CEO', 'text': 'hi'}], forensic_flags={'flags': []})


class Provider:
    def __init__(self, pages, details=None, fail_pages=()):
        self.pages, self.details, self.fail_pages = pages, details or {}, set(fail_pages)
        self.listed, self.fetched, self.seo_symbols = [], [], {}

    def list_page(self, page):
        self.listed.append(page)
        if page in self.fail_pages:
            raise requests.ConnectionError('down')
        return self.pages[page - 1], page < len(self.pages)

    def fetch_detail(self, slug, seo_symbol=None):
        self.fetched.append(slug)
        self.seo_symbols[slug] = seo_symbol
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
        self.assertEqual(stored['markdown_summary'], '## Key Takeaways (a-q2-fy27)')
        self.assertEqual(PRIVATE_FIELDS & set(stored), set())
        self.assertEqual(PRIVATE_FIELDS & set(entry), set())

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

    def test_a_long_pending_call_joins_the_weekly_rotation(self):
        slugs = [f'old{n}' for n in range(40)]
        pending = {s: {**detail(s, summary='')} for s in slugs}
        self.refresh_on(Provider([[row(s, date='01 July 2026') for s in slugs]], pending), '2026-11-21T16:30:00+05:30')
        weekly = Provider([[row(s, date='01 July 2026') for s in slugs]], pending)
        self.refresh_on(weekly, '2026-11-23T16:30:00+05:30', full=True)
        self.assertLess(len(weekly.fetched), 15)

    def test_a_list_failure_keeps_stored_calls_and_still_fetches_what_was_listed(self):
        self.run_refresh(Provider([[row('a')]]))
        provider = Provider([[row('new')], [row('a')]], fail_pages={2})
        report = self.run_refresh(provider)
        self.assertIn('list-page-2', report['errors'])
        self.assertEqual(set(self.index()['calls']), {'a', 'new'})
        self.assertTrue(self.index()['calls']['new']['object'])

    def test_a_detail_failure_is_pending_not_fatal(self):
        class Failing(Provider):
            def fetch_detail(self, slug, seo_symbol=None):
                if slug == 'bad':
                    raise requests.Timeout('slow')
                return super().fetch_detail(slug, seo_symbol)
        report = self.run_refresh(Failing([[row('ok'), row('bad')]]))
        self.assertEqual((report['added'], report['pending']), (1, 1))
        # The published index says only that the request failed; the detail is in the run report.
        self.assertEqual(self.index()['calls']['bad']['status'], 'provider request failed')
        self.assertEqual(report['failures'], {'bad': 'slow'})

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

    def test_a_page_of_only_malformed_rows_does_not_end_the_walk(self):
        provider = Provider([[row('a')], [], [row('b')]])
        self.run_refresh(provider)
        self.assertEqual(provider.listed, [1, 2, 3])
        self.assertEqual(sorted(provider.fetched), ['a', 'b'])

    def test_an_undated_pending_call_is_retried_daily_for_two_weeks_from_when_it_was_first_seen(self):
        pending = {'a': {**detail('a', summary=''), 'concall_date': None}}
        self.run_refresh(Provider([[row('a', date='Yesterday')]], pending))
        self.assertEqual(self.index()['calls']['a']['firstSeen'], '2026-11-21')
        for checked_at, expected in (('2026-12-04T16:30:00+05:30', ['a']), ('2026-12-06T16:30:00+05:30', [])):
            provider = Provider([[row('a', date='Yesterday')]], pending)
            refresh(self.output, self.store, provider.list_page, provider.fetch_detail, full=False,
                    checked_at=checked_at, workers=2)
            self.assertEqual(provider.fetched, expected, checked_at)

    def test_each_batch_is_uploaded_and_indexed_before_the_next(self):
        reports = []
        original = concall_history.BATCH
        concall_history.BATCH = 2
        try:
            refresh(self.output, self.store, Provider([[row(s) for s in 'abcde']]).list_page,
                    Provider([]).fetch_detail, full=False, checked_at='2026-11-21T16:30:00+05:30', workers=2,
                    progress=lambda report: reports.append((report['added'], self.index()['stored'],
                                                            len(self.store.objects))))
        finally:
            concall_history.BATCH = original
        self.assertEqual(reports, [(2, 2, 2), (4, 4, 4), (5, 5, 5)])

    def test_an_unexpected_response_shape_is_a_reported_failure(self):
        for payload in (['not', 'an', 'object'], {'status': 'success', 'data': ['x']}):
            response = Mock(status_code=200)
            response.json.return_value = payload
            session = Mock()
            session.post.return_value = response
            with unittest.mock.patch('concall_history.time.sleep'), self.assertRaises(ValueError):
                post(session, 'concluded', {})

    def refresh_on(self, provider, checked_at, full=False):
        return refresh(self.output, self.store, provider.list_page, provider.fetch_detail, full=full,
                       checked_at=checked_at, workers=2)

    def test_a_recent_call_is_rechecked_daily_and_an_unchanged_one_uploads_nothing(self):
        self.refresh_on(Provider([[row('a', date='20 November 2026')]]), '2026-11-21T16:30:00+05:30')
        uploads = len(self.store.objects)
        provider = Provider([[row('a', date='20 November 2026')]])
        report = self.refresh_on(provider, '2026-11-22T16:30:00+05:30')
        self.assertEqual(provider.fetched, ['a'])
        self.assertEqual((report['rechecked'], report['updated']), (1, 0))
        self.assertEqual(len(self.store.objects), uploads)
        self.assertEqual(self.index()['calls']['a']['checked'], '2026-11-22')

    def test_a_revised_summary_replaces_the_stored_object(self):
        self.refresh_on(Provider([[row('a', date='20 November 2026')]]), '2026-11-21T16:30:00+05:30')
        first = self.index()['calls']['a']['object']
        revised = {'a': detail('a', summary='## Key Takeaways (revised)')}
        report = self.refresh_on(Provider([[row('a', date='20 November 2026')]], revised), '2026-11-22T16:30:00+05:30')
        entry = self.index()['calls']['a']
        self.assertEqual(report['updated'], 1)
        self.assertNotEqual(entry['object'], first)
        self.assertEqual(entry['updated'], '2026-11-22')
        self.assertEqual(self.store.load(entry['object'])['call']['markdown_summary'], '## Key Takeaways (revised)')

    def test_a_revised_call_keeps_one_object_and_the_old_one_is_deleted_on_the_next_run(self):
        self.refresh_on(Provider([[row('a', date='20 November 2026')]]), '2026-11-21T16:30:00+05:30')
        first = self.index()['calls']['a']['object']['sha256']
        revised = {'a': detail('a', summary='## Key Takeaways (revised)')}
        deleted = []
        refresh(self.output, self.store, Provider([[row('a', date='20 November 2026')]], revised).list_page,
                Provider([], revised).fetch_detail, full=False, checked_at='2026-11-22T16:30:00+05:30', workers=2,
                delete=deleted.append)
        # The live index still names the old object until this run's index is published.
        self.assertEqual(deleted, [])
        self.assertEqual(self.index()['calls']['a']['superseded'], [first])
        report = refresh(self.output, self.store, Provider([[row('a', date='20 November 2026')]], revised).list_page,
                         Provider([], revised).fetch_detail, full=False, checked_at='2026-11-23T16:30:00+05:30',
                         workers=2, delete=deleted.append)
        self.assertEqual(deleted, [f'{first}.json.gz'])
        self.assertEqual(report['deleted'], 1)
        self.assertNotIn('superseded', self.index()['calls']['a'])

    def test_a_failed_delete_is_retried_on_the_next_run(self):
        self.refresh_on(Provider([[row('a', date='20 November 2026')]]), '2026-11-21T16:30:00+05:30')
        revised = {'a': detail('a', summary='## revised')}
        self.refresh_on(Provider([[row('a', date='20 November 2026')]], revised), '2026-11-22T16:30:00+05:30')

        def down(name):
            raise RuntimeError('r2 down')
        refresh(self.output, self.store, Provider([[row('a', date='20 November 2026')]], revised).list_page,
                Provider([], revised).fetch_detail, full=False, checked_at='2026-11-23T16:30:00+05:30', workers=2,
                delete=down)
        kept = list(self.index()['calls']['a']['superseded'])
        self.assertEqual(len(kept), 1)
        deleted = []
        refresh(self.output, self.store, Provider([[row('a', date='20 November 2026')]], revised).list_page,
                Provider([], revised).fetch_detail, full=False, checked_at='2026-11-24T16:30:00+05:30', workers=2,
                delete=deleted.append)
        self.assertEqual(deleted, [f'{digest}.json.gz' for digest in kept])
        self.assertNotIn('superseded', self.index()['calls']['a'])

    def test_deleting_an_object_that_is_already_gone_counts_as_deleted(self):
        class Store:
            def __init__(self, code):
                self.code = code

            def remote(self, key):
                return f'r2:bucket/{key}'

            def cache_command(self, *args):
                if self.code:
                    raise subprocess.CalledProcessError(self.code, ['rclone', *args])
        delete_object(Store(0), 'x.json.gz')
        delete_object(Store(4), 'x.json.gz')
        with self.assertRaises(subprocess.CalledProcessError):
            delete_object(Store(1), 'x.json.gz')

    def test_another_quarters_call_under_a_slug_is_not_stored(self):
        # The provider answers honasa-q1-fy27 with the Q2FY27 call, which honasa-q2-fy27 also lists.
        newest = dict(detail('honasa-q1-fy27', summary='## Q2'), concall_quarter='Q2FY27', concall_date='2026-11-06')
        provider = Provider([[dict(row('honasa-q1-fy27', 'HONASA', date='13 August 2026'), concall_quarter='Q1FY27')]],
                            {'honasa-q1-fy27': newest})
        report = self.run_refresh(provider)
        entry = self.index()['calls']['honasa-q1-fy27']
        self.assertEqual((entry['object'], entry['date'], entry['status']), (None, '2026-08-13', 'provider returned another call'))
        self.assertEqual(report['failures'], {'honasa-q1-fy27': 'provider returned the Q2FY27 call'})

    def test_a_stored_call_whose_date_is_not_the_listed_one_is_dropped(self):
        # Stored before the quarter check: the object is the newest call, dated 6 November, not the listed 13 August.
        stale = dict(detail('honasa-q1-fy27', summary='## Q2'), concall_date='2026-11-06')
        listed = dict(row('honasa-q1-fy27', 'HONASA', date='13 August 2026'), concall_quarter='Q1FY27')
        self.run_refresh(Provider([[listed]], {'honasa-q1-fy27': stale}))
        first = self.index()['calls']['honasa-q1-fy27']['object']['sha256']
        provider = Provider([[listed]], {'honasa-q1-fy27': dict(stale, concall_quarter='Q2FY27')})
        report = self.run_refresh(provider, full=True)
        entry = self.index()['calls']['honasa-q1-fy27']
        self.assertEqual((report['dropped'], entry['object'], entry['date']), (1, None, '2026-08-13'))
        self.assertNotIn('time', entry)
        self.assertEqual(entry['superseded'], [first])
        self.assertEqual(provider.fetched, ['honasa-q1-fy27'])

    def test_a_summary_filed_under_two_companies_is_dropped_from_both(self):
        hexacom = {'bhartiartl-q2-fy27': detail('bhartiartl-q2-fy27', summary='## Hexacom'),
                   'bhartihexa-q2-fy27': detail('bhartihexa-q2-fy27', summary='## Hexacom')}
        listed = [[row('bhartiartl-q2-fy27', 'BHARTIARTL', date='20 November 2026'),
                   row('bhartihexa-q2-fy27', 'BHARTIHEXA', date='20 November 2026'), row('tcs-q2-fy27', 'TCS')]]
        report = self.run_refresh(Provider(listed, hexacom))
        calls = self.index()['calls']
        self.assertEqual([(calls[s]['object'], calls[s]['status']) for s in ('bhartiartl-q2-fy27', 'bhartihexa-q2-fy27')],
                         [(None, 'summary of another company')] * 2)
        self.assertTrue(calls['tcs-q2-fy27']['object'])
        self.assertEqual(report['duplicates'], {})
        self.assertEqual(report['failures']['bhartihexa-q2-fy27'], 'summary also stored for bhartiartl-q2-fy27')
        # A retry that still gets the shared summary stores nothing; once the provider fixes one, both come back.
        uploads = len(self.store.objects)
        self.refresh_on(Provider(listed, hexacom), '2026-11-22T16:30:00+05:30')
        self.assertEqual(len(self.store.objects), uploads)
        fixed = dict(hexacom, **{'bhartiartl-q2-fy27': detail('bhartiartl-q2-fy27', summary='## Airtel')})
        self.refresh_on(Provider(listed, fixed), '2026-11-23T16:30:00+05:30')
        self.refresh_on(Provider(listed, fixed), '2026-11-24T16:30:00+05:30')
        calls = self.index()['calls']
        self.assertTrue(calls['bhartiartl-q2-fy27']['object'] and calls['bhartihexa-q2-fy27']['object'])

    def test_the_weekly_run_rechecks_old_calls_stored_without_a_digest_once(self):
        listed = [[row('bhartiartl-q2-fy27', 'BHARTIARTL', date='01 October 2026'),
                   row('bhartihexa-q2-fy27', 'BHARTIHEXA', date='01 October 2026')]]
        hexacom = {s: detail(s, summary='## Hexacom') for s in ('bhartiartl-q2-fy27', 'bhartihexa-q2-fy27')}
        self.run_refresh(Provider(listed))
        index = self.index()
        for entry in index['calls'].values():
            entry.pop('summary', None)
        self.output.write_text(json.dumps(index))
        weekly = Provider(listed, hexacom)
        self.refresh_on(weekly, '2026-11-23T16:30:00+05:30', full=True)
        self.assertEqual(sorted(weekly.fetched), ['bhartiartl-q2-fy27', 'bhartihexa-q2-fy27'])
        self.assertEqual([entry['object'] for entry in self.index()['calls'].values()], [None, None])

    def test_one_companys_summary_under_two_of_its_slugs_is_only_reported(self):
        same = {'a-q2-fy27': detail('a-q2-fy27', summary='## A'), 'a-q2-fy27-2': detail('a-q2-fy27-2', summary='## A')}
        report = self.run_refresh(Provider([[row('a-q2-fy27', 'A'), row('a-q2-fy27-2', 'A')]], same))
        self.assertEqual(list(report['duplicates'].values()), [['a-q2-fy27', 'a-q2-fy27-2']])

    def test_a_call_is_fetched_from_the_quarter_endpoint_with_its_seo_symbol(self):
        response = Mock(status_code=200)
        response.json.return_value = {'status': 'success', 'data': {
            'slug_id': 'honasa-q1-fy27', 'concall_quarter': 'Q1FY27', 'markdown_summary': '## Q1',
            'insights': {'windows': [{'flags': [{'type': 'red', 'title': 'A'}]}, {'flags': [{'type': 'green', 'title': 'B'}]}]}}}
        session = Mock()
        session.post.return_value = response
        detail = fetch_detail(session, 'honasa-q1-fy27', 'mama-earth-ltd')
        url, = session.post.call_args.args
        self.assertTrue(url.endswith('/live-call/fetch-company-quarter-summary'))
        self.assertEqual(session.post.call_args.kwargs['json'], {'slug': 'honasa-q1-fy27', 'seo_symbol': 'mama-earth-ltd'})
        # Stored in get-by-slug's shape, which the site reads.
        self.assertEqual([w['flags'][0]['title'] for w in detail['forensic_flags']['flags']], ['A', 'B'])
        self.assertNotIn('insights', detail)
        fetch_detail(session, 'honasa-q1-fy27')
        self.assertTrue(session.post.call_args.args[0].endswith('/live-call/get-by-slug'))

    def test_the_listed_seo_symbol_is_passed_to_the_fetch(self):
        provider = Provider([[dict(row('honasa-q1-fy27', 'HONASA'), seo_symbol='mama-earth-ltd')]])
        self.run_refresh(provider)
        self.assertEqual(provider.seo_symbols, {'honasa-q1-fy27': 'mama-earth-ltd'})
        self.assertEqual(self.index()['calls']['honasa-q1-fy27']['seoSymbol'], 'mama-earth-ltd')

    def test_a_call_answered_with_another_call_is_retried_daily_and_a_spaced_quarter_matches(self):
        listed = [[dict(row('honasa-q1-fy27', 'HONASA', date='13 August 2026'), concall_quarter='Q1FY27')]]
        newest = dict(detail('honasa-q1-fy27'), concall_quarter='Q2FY27')
        self.run_refresh(Provider(listed, {'honasa-q1-fy27': newest}))
        own = dict(detail('honasa-q1-fy27', summary='## Q1'), concall_quarter='Q1 FY27', concall_date='2026-08-13')
        daily = Provider(listed, {'honasa-q1-fy27': own})
        self.refresh_on(daily, '2026-11-23T16:30:00+05:30')
        entry = self.index()['calls']['honasa-q1-fy27']
        self.assertEqual(daily.fetched, ['honasa-q1-fy27'])
        self.assertEqual(self.store.load(entry['object'])['call']['markdown_summary'], '## Q1')
        self.assertNotIn('status', entry)

    def test_a_failed_or_emptied_recheck_keeps_the_stored_version(self):
        self.refresh_on(Provider([[row('a', date='20 November 2026')]]), '2026-11-21T16:30:00+05:30')
        first = self.index()['calls']['a']['object']
        emptied = {'a': detail('a', summary='')}
        report = self.refresh_on(Provider([[row('a', date='20 November 2026')]], emptied), '2026-11-22T16:30:00+05:30')
        self.assertEqual(self.index()['calls']['a']['object'], first)
        self.assertEqual(report['pending'], 0)
        self.assertIn('recheck', report['failures']['a'])

    def test_older_calls_are_rechecked_only_weekly(self):
        self.refresh_on(Provider([[row('a', date='01 November 2026')]]), '2026-11-21T16:30:00+05:30')
        daily = Provider([[row('a', date='01 November 2026')]])
        self.refresh_on(daily, '2026-11-23T16:30:00+05:30')
        self.assertEqual(daily.fetched, [])
        weekly = Provider([[row('a', date='01 November 2026')]])
        self.refresh_on(weekly, '2026-11-23T16:30:00+05:30', full=True)
        self.assertEqual(weekly.fetched, ['a'])

    def test_the_weekly_run_rechecks_a_rotating_eighth_of_old_calls(self):
        slugs = [f'old{n}' for n in range(80)]
        self.refresh_on(Provider([[row(s, date='01 July 2026') for s in slugs]]), '2026-11-21T16:30:00+05:30')
        seen = set()
        for offset in range(8):
            provider = Provider([[row(s, date='01 July 2026') for s in slugs]])
            day = date(2026, 11, 23) + timedelta(weeks=offset)
            self.refresh_on(provider, f'{day.isoformat()}T16:30:00+05:30', full=True)
            self.assertLess(len(provider.fetched), 30)
            seen.update(provider.fetched)
        self.assertEqual(seen, set(slugs))

    def test_the_schedule_lists_upcoming_and_live_calls_but_not_concluded_ones(self):
        upcoming = [dict(row('zf-q2-fy27', 'ZFCVINDIA', date='23 November 2026'), concall_time='10:30',
                         call_status='not_started', online_flag='true', diamond_link='https://services.example/reg')]
        today = [dict(slug='sahasra-q2-fy27', symbol='SAHASRA', company_name='Sahasra', concall_date='2026-11-21',
                      concall_time='14:00', call_status='in_progress'),
                 dict(slug='done-q2-fy27', symbol='DONE', call_status='generating_summary_end')]
        path = self.output.with_name('upcoming.json')
        report = refresh_upcoming(path, lambda: upcoming, lambda: today, checked_at='2026-11-21T16:30:00+05:30')
        self.assertEqual(report, {'scheduled': 1, 'live': 1})
        calls = json.loads(path.read_text())['calls']
        self.assertEqual([(c['slug'], c['state']) for c in calls], [('sahasra-q2-fy27', 'live'), ('zf-q2-fy27', 'scheduled')])
        self.assertEqual((calls[1]['date'], calls[1]['registration'], calls[1]['online']), ('2026-11-23', 'https://services.example/reg', True))
        self.assertEqual(PRIVATE_FIELDS & {key for call in calls for key in call}, set())

    def test_the_schedule_skips_rows_that_are_not_objects(self):
        upcoming = ['oops', None, dict(row('zf-q2-fy27', 'ZFCVINDIA', date='23 November 2026'))]
        today = [42, dict(slug='sahasra-q2-fy27', symbol='SAHASRA', call_status='in_progress')]
        path = self.output.with_name('upcoming.json')
        report = refresh_upcoming(path, lambda: upcoming, lambda: today, checked_at='2026-11-21T16:30:00+05:30')
        self.assertEqual(report, {'scheduled': 1, 'live': 1})

    def test_a_failed_schedule_fetch_keeps_the_last_schedule(self):
        path = self.output.with_name('upcoming.json')
        path.parent.mkdir(parents=True)
        path.write_text('{"version": 1, "calls": []}')

        def down():
            raise requests.ConnectionError('down')
        report = refresh_upcoming(path, down, lambda: [], checked_at='2026-11-21T16:30:00+05:30')
        self.assertEqual(report, {'error': 'down'})
        self.assertEqual(path.read_text(), '{"version": 1, "calls": []}')

    def test_call_states(self):
        self.assertEqual([call_state(s) for s in ('not_started', None, 'in_progress', 'generating_summary_end')],
                         ['scheduled', 'scheduled', 'live', 'concluded'])

    def test_dates(self):
        self.assertEqual(iso_date('05 November 2026'), '2026-11-05')
        self.assertEqual(iso_date('2026-11-05'), '2026-11-05')
        self.assertIsNone(iso_date('Yesterday'))


if __name__ == '__main__':
    unittest.main()
