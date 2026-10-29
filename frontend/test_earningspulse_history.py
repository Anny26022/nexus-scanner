from datetime import date, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests

from earningspulse_history import SOURCE, fetch_week, parse_week, quarter_bounds, quarter_label, refresh


class Store:
    base_url = 'https://data.example'

    def __init__(self):
        self.objects = {}
        self.uploaded = []

    def upload_objects(self, folder, known):
        for path in folder.glob('*.json.gz'):
            if path.name not in known:
                self.objects[path.name] = path.read_bytes()
                self.uploaded.append(path.name)

    def load(self, item):
        compressed = self.objects[item['sha256'] + '.json.gz']
        assert hashlib.sha256(compressed).hexdigest() == item['sha256']
        return json.loads(gzip.decompress(compressed))['records']


class EarningsHistoryTests(unittest.TestCase):
    today = date(2026, 10, 29)  # Thursday; the provider's week is 26 Oct to 1 Nov
    monday = date(2026, 10, 26)

    def row(self, day=None, **changes):
        return {**dict(symbol='TEST', market='IN', filing_day=(day or self.monday).isoformat(),
                       quarter_label='Q22027', quality='Excellent', isUpcoming=False,
                       revenue=None, net_income=None, eps=None, attachment_url=None), **changes}

    def upcoming(self, day=None, **changes):
        return {**self.row(day, **changes), 'isUpcoming': True, 'quarter_label': None, 'quality': None}

    def flight(self, rows, monday=None, **changes):
        monday = monday or self.monday
        days = [(monday + timedelta(days=offset)).isoformat() for offset in range(7)]
        payload = dict(results=rows, allDates=days, fetchError=False)
        return 'a:["$",null,' + json.dumps({**payload, **changes}, separators=(',', ':')) + ']\n'

    def week(self, rows, monday=None):
        monday = monday or self.monday
        return lambda: (monday, monday + timedelta(days=6), rows)

    def run_refresh(self, output, store, rows=None, *, fetch=None, checked_at='2026-10-29T21:00:00+05:30'):
        return refresh(output, store, fetch or self.week([self.row()] if rows is None else rows), store.load,
                       checked_at=checked_at)

    def stored(self, output, store, label='2026-Q4', status='published'):
        return store.load(json.loads(output.read_text())['quarters'][label][status])

    def test_parse_reads_the_current_week_and_keeps_every_field(self):
        row = self.row(expense=None, dropTime={'minutes': 100}, new_field=[1, 2])
        self.assertEqual(parse_week(self.flight([row, row]), self.today), (self.monday, date(2026, 11, 1), [row]))

    def test_parse_rejects_truncation_other_weeks_and_provider_errors(self):
        for text in (self.flight([self.row()])[:-8], '<html>Vercel Security Checkpoint</html>',
                     self.flight([], fetchError=True), self.flight([], monday=date(2026, 10, 19)),
                     self.flight([], allDates=['2026-10-01', '2026-12-31']), self.flight([{'symbol': 'X'}])):
            with self.subTest(text=text[:60]), self.assertRaises((ValueError, KeyError, TypeError)):
                parse_week(text, self.today)
        for changes in ({'market': 'US'}, {'filing_day': '2026-11-02'}, {'isUpcoming': 'false'}, {'symbol': ''}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse_week(self.flight([{**self.row(), **changes}]), self.today)
        with self.assertRaises(ValueError):
            parse_week(self.flight([self.row(value=float('nan'))]), self.today)

    def test_conflicting_duplicates_are_not_silently_overwritten(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            parse_week(self.flight([self.row(), {**self.row(), 'quality': 'Weak'}]), self.today)

    def test_upcoming_events_need_no_financial_results_but_published_events_do(self):
        upcoming = {key: value for key, value in self.upcoming().items() if key not in {'revenue', 'net_income', 'eps'}}
        self.assertEqual(parse_week(self.flight([upcoming]), self.today)[2], [upcoming])
        upcoming.update(isUpcoming=False, quarter_label='Q22027')
        with self.assertRaisesRegex(ValueError, 'financial fields'):
            parse_week(self.flight([upcoming]), self.today)

    def test_fetch_asks_for_the_public_week_and_retries_once(self):
        session = Mock()
        session.get.side_effect = [requests.Timeout('slow'), Mock(text=self.flight([self.row()]))]
        with patch('earningspulse_history.time.sleep'):
            self.assertEqual(len(fetch_week(session, self.today)[2]), 1)
        call = session.get.call_args
        self.assertEqual(call.args[0], SOURCE)
        self.assertEqual(call.kwargs['headers'], {'RSC': '1'})
        # Older weeks and quarter ranges now need a sign-in; anonymous requests for them are redirected.
        self.assertEqual(call.kwargs['params'], {'liquidity': 'all', 'market': 'IN'})

    def test_week_replaces_its_days_and_keeps_the_rest_of_the_quarter(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            earlier, later = date(2026, 10, 5), date(2026, 11, 16)
            self.run_refresh(output, store, fetch=self.week(
                [self.row(earlier, symbol='EARLY'), self.upcoming(later, symbol='LATE')], earlier))
            report = self.run_refresh(output, store, [
                {**self.row(), 'symbol': 'TODAY', 'quality': 'Great'}, self.upcoming(date(2026, 10, 30), symbol='FRI')])
            self.assertEqual(report, {'checkedAt': '2026-10-29T21:00:00+05:30', 'quarters': {'2026-Q4': 'updated'},
                                      'errors': {}})
            published = self.stored(output, store)
            self.assertEqual([(row['symbol'], row['filing_day']) for row in published],
                             [('EARLY', '2026-10-05'), ('TODAY', '2026-10-26')])
            self.assertEqual([row['symbol'] for row in self.stored(output, store, status='upcoming')], ['FRI', 'LATE'])
            entry = json.loads(output.read_text())['quarters']['2026-Q4']
            self.assertEqual((entry['published']['count'], entry['upcoming']['count'], entry['checkedAt']),
                             (2, 2, '2026-10-29T21:00:00+05:30'))

    def test_a_company_that_reports_this_week_drops_its_older_announcement(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            self.run_refresh(output, store, fetch=self.week([self.upcoming(date(2026, 11, 20), symbol='MOVED')],
                                                            date(2026, 10, 5)))
            self.run_refresh(output, store, [self.row(symbol='MOVED')])
            self.assertEqual(self.stored(output, store, status='upcoming'), [])
            self.assertEqual([row['symbol'] for row in self.stored(output, store)], ['MOVED'])

    def test_a_week_across_two_quarters_updates_both(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            monday = date(2026, 9, 28)
            report = self.run_refresh(output, store, fetch=self.week(
                [self.row(monday, symbol='SEP'), self.upcoming(date(2026, 10, 2), symbol='OCT')], monday))
            self.assertEqual(report['quarters'], {'2026-Q3': 'updated', '2026-Q4': 'updated'})
            self.assertEqual([row['symbol'] for row in self.stored(output, store, '2026-Q3')], ['SEP'])
            self.assertEqual([row['symbol'] for row in self.stored(output, store, '2026-Q4', 'upcoming')], ['OCT'])

    def test_unchanged_week_uploads_nothing_new(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            self.run_refresh(output, store)
            uploads = len(store.uploaded)
            report = self.run_refresh(output, store, checked_at='2026-10-30T21:00:00+05:30')
            self.assertEqual(report['quarters'], {'2026-Q4': 'unchanged'})
            self.assertEqual(len(store.uploaded), uploads)

    def test_failures_short_weeks_and_empty_weeks_preserve_prior_data(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            self.run_refresh(output, store, [self.row(symbol=f'S{n}') for n in range(10)])
            before = output.read_bytes()

            def unavailable():
                raise requests.ConnectionError('down')
            self.assertEqual(self.run_refresh(output, store, fetch=unavailable)['errors'], {'current-week': 'down'})
            self.assertEqual(self.run_refresh(output, store, [])['quarters'], {})
            report = self.run_refresh(output, store, [self.row(symbol='S0')])
            self.assertIn('Fewer than half', report['errors']['2026-Q4'])
            self.assertEqual(output.read_bytes(), before)
            with self.assertRaisesRegex(RuntimeError, 'upload failed'), \
                    patch.object(store, 'upload_objects', side_effect=RuntimeError('upload failed')):
                self.run_refresh(output, store, [self.row(symbol=f'S{n}', value=42) for n in range(10)])
            self.assertEqual(output.read_bytes(), before)

    def test_a_stored_object_that_does_not_match_its_digest_is_not_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            self.run_refresh(output, store)
            before = output.read_bytes()

            def corrupt(item):
                raise ValueError('Stored earnings object does not match its digest')
            report = refresh(output, store, self.week([self.row(symbol='NEW')]), corrupt, checked_at='x')
            self.assertIn('digest', report['errors']['2026-Q4'])
            self.assertEqual(output.read_bytes(), before)

    def test_published_files_never_name_their_source(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder) / 'index.json', Store()
            self.run_refresh(output, store, [{**self.row(), 'summary_uri': 'https://provider/x.json'}])
            index = json.loads(output.read_text())
            self.assertNotIn('source', index)
            payload = json.loads(gzip.decompress(store.objects[index['quarters']['2026-Q4']['published']['sha256'] + '.json.gz']))
            self.assertNotIn('source', payload)
            self.assertNotIn('summary_uri', payload['records'][0])

    def test_quarter_labels_and_boundaries(self):
        self.assertEqual(quarter_bounds('2024-Q4'), (date(2024, 10, 1), date(2024, 12, 31)))
        self.assertEqual((quarter_label(date(2026, 12, 31)), quarter_label(date(2027, 1, 1))), ('2026-Q4', '2027-Q1'))
        with self.assertRaises(ValueError):
            quarter_bounds('2024-Q5')

    def test_invalid_existing_index_is_not_discarded(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'index.json'
            output.write_text('{"version":9}')
            with self.assertRaises(ValueError):
                self.run_refresh(output, Store())
            self.assertEqual(output.read_text(), '{"version":9}')


if __name__ == '__main__':
    unittest.main()
