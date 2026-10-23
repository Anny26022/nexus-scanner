from datetime import date
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests

from earningspulse_history import SOURCE, fetch_quarter, parse_quarter, quarter_bounds, quarters_until, refresh


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


class EarningsHistoryTests(unittest.TestCase):
    today = date(2026, 10, 24)

    def row(self, label='2026-Q4', **changes):
        return dict(symbol='TEST', market='IN', filing_day=quarter_bounds(label)[0].isoformat(),
                    quarter_label='Q22027', quality='Excellent', isUpcoming=False,
                    revenue=None, net_income=None, eps=None, attachment_url=None, **changes)

    def flight(self, rows, label='2026-Q4', **changes):
        start, end = quarter_bounds(label)
        payload = dict(results=rows, allDates=[start.isoformat(), end.isoformat()], fetchError=False)
        return 'a:["$",null,' + json.dumps({**payload, **changes}, separators=(',', ':')) + ']\n'

    def run_refresh(self, output, store, fetch=None, **kwargs):
        return refresh(output, store, fetch or (lambda label: [self.row(label)]), today=self.today,
                       checked_at=kwargs.pop('checked_at', '2026-10-24T16:00:00+05:30'), **kwargs)

    def test_parse_preserves_nulls_nested_values_and_new_fields(self):
        row = self.row(expense=None, dropTime={'minutes':100}, new_field=[1, 2])
        self.assertEqual(parse_quarter(self.flight([row, row]), '2026-Q4'), [row])

    def test_parse_rejects_truncation_wrong_window_and_provider_errors(self):
        for text in (self.flight([self.row()])[:-8], '<html>Vercel Security Checkpoint</html>',
                     self.flight([], fetchError=True), self.flight([], '2026-Q3'),
                     self.flight([{'symbol':'X'}])):
            with self.subTest(text=text[:40]), self.assertRaises((ValueError, KeyError, TypeError)):
                parse_quarter(text, '2026-Q4')
        for changes in ({'market':'US'}, {'filing_day':'2026-09-30'}, {'isUpcoming':'false'}, {'symbol':''}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse_quarter(self.flight([{**self.row(), **changes}]), '2026-Q4')
        with self.assertRaises(ValueError):
            parse_quarter(self.flight([self.row(value=float('nan'))]), '2026-Q4')

    def test_conflicting_duplicates_are_not_silently_overwritten(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            parse_quarter(self.flight([self.row(), {**self.row(), 'quality':'Weak'}]), '2026-Q4')

    def test_upcoming_events_need_no_financial_results_but_published_events_do(self):
        upcoming = {key: value for key, value in self.row().items() if key not in {'revenue','net_income','eps'}}
        upcoming.update(isUpcoming=True, quarter_label=None, quality=None)
        self.assertEqual(parse_quarter(self.flight([upcoming]), '2026-Q4'), [upcoming])
        upcoming.update(isUpcoming=False, quarter_label='Q22027')
        with self.assertRaisesRegex(ValueError, 'financial fields'):
            parse_quarter(self.flight([upcoming]), '2026-Q4')

    def test_fetch_retries_an_incomplete_response_and_uses_relative_weeks(self):
        session = Mock()
        session.get.side_effect = [requests.Timeout('slow'), Mock(text=self.flight([self.row('2026-Q3')], '2026-Q3'))]
        with patch('earningspulse_history.time.sleep'):
            self.assertEqual(len(fetch_quarter(session, '2026-Q3', self.today)), 1)
        call = session.get.call_args
        self.assertEqual(call.args[0], SOURCE)
        self.assertEqual(call.kwargs['headers'], {'RSC':'1'})
        self.assertEqual(call.kwargs['params']['week'], -10)

    def test_backfill_then_incremental_and_weekly_rotation(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder)/'index.json', Store()
            fetch = Mock(side_effect=lambda label: [self.row(label)])
            self.run_refresh(output, store, fetch)
            self.assertEqual([call.args[0] for call in fetch.call_args_list], quarters_until(self.today))
            index = json.loads(output.read_text())
            self.assertEqual(len(index['quarters']), 10)
            for label, entry in index['quarters'].items():
                compressed = store.objects[entry['published']['sha256']+'.json.gz']
                raw = gzip.decompress(compressed)
                self.assertEqual(hashlib.sha256(compressed).hexdigest(), entry['published']['sha256'])
                self.assertEqual(json.loads(raw)['records'], [self.row(label)])
            uploads = len(store.uploaded)
            fetch.reset_mock()
            report = self.run_refresh(output, store, fetch, checked_at='2026-10-25T16:00:00+05:30')
            self.assertEqual(set(report['quarters']), {'2026-Q3','2026-Q4'})
            self.assertEqual(set(report['quarters'].values()), {'unchanged'})
            self.assertEqual(len(store.uploaded), uploads)
            report = self.run_refresh(output, store, recheck_oldest=True, checked_at='2026-10-26T16:00:00+05:30')
            self.assertEqual(set(report['quarters']), {'2024-Q3','2026-Q3','2026-Q4'})
            report = self.run_refresh(output, store, recheck_oldest=True, checked_at='2026-11-02T16:00:00+05:30')
            self.assertEqual(set(report['quarters']), {'2024-Q4','2026-Q3','2026-Q4'})

    def test_failures_and_empty_replacements_preserve_prior_quarter(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder)/'index.json', Store()
            self.run_refresh(output, store)
            before = output.read_bytes()
            report = self.run_refresh(output, store, lambda label: [])
            self.assertEqual(set(report['errors']), {'2026-Q3','2026-Q4'})
            self.assertEqual(output.read_bytes(), before)
            with self.assertRaisesRegex(RuntimeError, 'upload failed'), patch.object(store, 'upload_objects', side_effect=RuntimeError('upload failed')):
                self.run_refresh(output, store, lambda label: [self.row(label, value=42)])
            self.assertEqual(output.read_bytes(), before)

    def test_partial_backfill_resumes_missing_quarters(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder)/'index.json', Store()
            def fetch(label):
                if label == '2025-Q1':
                    raise ValueError('upstream failure')
                return [self.row(label)]
            report = self.run_refresh(output, store, fetch)
            self.assertEqual(list(report['errors']), ['2025-Q1'])
            self.assertNotIn('2025-Q1', json.loads(output.read_text())['quarters'])
            report = self.run_refresh(output, store)
            self.assertEqual(set(report['quarters']), {'2025-Q1','2026-Q3','2026-Q4'})

    def test_updates_replace_events_and_upcoming_is_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            output, store = Path(folder)/'index.json', Store()
            self.run_refresh(output, store)
            def fetch(label):
                return [{**self.row(label), 'quality':'Great'}, {**self.row(label), 'symbol':'FUTURE', 'isUpcoming':True}]
            self.run_refresh(output, store, fetch)
            entry = json.loads(output.read_text())['quarters']['2026-Q4']
            self.assertEqual(entry['published']['count'], 1)
            self.assertEqual(entry['upcoming']['count'], 1)
            raw = store.objects[entry['published']['sha256']+'.json.gz']
            self.assertEqual(json.loads(gzip.decompress(raw))['records'][0]['quality'], 'Great')

    def test_new_quarter_and_year_boundaries(self):
        self.assertEqual(quarter_bounds('2024-Q4'), (date(2024,10,1), date(2024,12,31)))
        self.assertEqual(quarters_until(date(2027,1,1))[-2:], ['2026-Q4','2027-Q1'])
        with self.assertRaises(ValueError):
            quarter_bounds('2024-Q5')

    def test_invalid_existing_index_is_not_discarded(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/'index.json'
            output.write_text('{"version":9}')
            with self.assertRaises(ValueError):
                self.run_refresh(output, Store())
            self.assertEqual(output.read_text(), '{"version":9}')


if __name__ == '__main__':
    unittest.main()
