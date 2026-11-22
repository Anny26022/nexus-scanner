"""US earnings dates from Earnings Pulse's archive and TradingView, and the calendar built from them."""
import gzip
import json
import sys
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT, ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import earnings, statements  # noqa: E402

INDEX = {'version': 1, 'quarters': {
    '2026-Q3': {'published': {'url': 'https://data/q3', 'count': 2}, 'upcoming': {'url': 'https://data/q3u', 'count': 0}},
    '2026-Q4': {'published': {'url': 'https://data/q4', 'count': 1}, 'upcoming': {'url': 'https://data/q4u', 'count': 1}}}}
OBJECTS = {
    'https://data/q3': {'records': [{'symbol': 'ACME', 'filing_day': '2026-07-28'}, {'symbol': 'OTHER', 'filing_day': '2026-08-01'}]},
    'https://data/q4': {'records': [{'symbol': 'ACME', 'filing_day': '2026-10-27'}]},
    'https://data/q4u': {'records': [{'symbol': 'OTHER', 'filing_day': '2026-11-25', 'timing': 'After', 'isUpcoming': True}]},
}


def get(url, **kwargs):
    body = INDEX if url == 'https://index' else OBJECTS[url]
    return mock.Mock(content=gzip.compress(json.dumps(body).encode()), raise_for_status=mock.Mock())


class EarningsTests(unittest.TestCase):
    def test_reports_come_from_the_archive_and_tradingviews_last_date(self):
        pulse = earnings.load_pulse(index_url='https://index', get=get)
        self.assertEqual((len(pulse['reported']), len(pulse['upcoming'])), (3, 1))
        records = [{'symbol': 'ACME', 'latest_earnings_date': '2026-10-27'}, {'symbol': 'NEW', 'latest_earnings_date': '2026-11-05'}]
        self.assertEqual(earnings.report_dates(records, pulse)['records_with_dates'], 2)
        self.assertEqual(records[0]['earnings_dates'], ['2026-07-28', '2026-10-27'])
        # Each quarter takes the first report after its end, within 95 days.
        self.assertEqual(earnings.reported_on(records[0], date(2026, 6, 30)), '2026-07-28')
        self.assertEqual(earnings.reported_on(records[0], date(2026, 9, 30)), '2026-10-27')
        self.assertIsNone(earnings.reported_on(records[0], date(2026, 3, 31)))
        # An unreachable archive leaves TradingView's dates only.
        failed = earnings.load_pulse(index_url='https://index', get=mock.Mock(side_effect=OSError('down')))
        self.assertIn('error', failed)

    def test_the_archive_is_read_from_the_root_where_the_workflow_copied_it(self):
        import tempfile, shutil
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        directory = root / 'earnings_pulse'
        directory.mkdir()
        import hashlib
        body = gzip.compress(json.dumps(OBJECTS['https://data/q4']).encode())
        digest = hashlib.sha256(body).hexdigest()
        (directory / 'us_index.json').write_text(json.dumps({'quarters': {'2026-Q4': {
            'published': {'sha256': digest, 'count': 1}, 'upcoming': {'sha256': 'b' * 64, 'count': 0}}}}))
        (directory / f'{digest}.json.gz').write_bytes(body)
        pulse = earnings.load_pulse(root, get=mock.Mock(side_effect=AssertionError('no network')))
        self.assertEqual(len(pulse['reported']), 1)
        # A corrupted or mis-copied object is refused, not read.
        (directory / f'{digest}.json.gz').write_bytes(gzip.compress(b'{"records": []}'))
        self.assertIn('sha256', earnings.load_pulse(root)['error'])
        # Not copied and no URL given: no host is assumed.
        with mock.patch.dict('os.environ', {'US_RESULTS_INDEX_URL': ''}):
            self.assertIn('error', earnings.load_pulse(root / 'missing'))

    def test_ledger_rows_carry_reported_dates_for_every_quarter_the_archive_knows(self):
        record = {'symbol': 'ACME', 'earnings_dates': ['2026-04-29', '2026-07-28', '2026-10-27']}
        quarters = [{'period': period, 'REVENUE': 100} for period in ('202609', '202606', '202603', '202512')]
        rows = statements._ledger_rows(record, quarters, '12', 'test')
        self.assertEqual([(row['quarter_end'], row['filing_date'], row['filing_date_basis']) for row in rows], [
            ('2025-12-31', '2026-03-31', 'estimated'),  # a 10-K quarter the archive does not reach: + 90 days
            ('2026-03-31', '2026-04-29', 'reported'), ('2026-06-30', '2026-07-28', 'reported'),
            ('2026-09-30', '2026-10-27', 'reported')])

    def test_the_calendar_prefers_earnings_pulse_and_fills_from_tradingview(self):
        pulse = earnings.load_pulse(index_url='https://index', get=get)
        records = [{'symbol': 'OTHER', 'name': 'Other', 'next_earnings_date': '2026-11-26', 'next_earnings_time': 1},
                   {'symbol': 'ACME', 'name': 'Acme', 'next_earnings_date': '2027-01-27', 'next_earnings_time': -1},
                   {'symbol': 'PAST', 'next_earnings_date': '2026-11-01'}]
        events = earnings.calendar(records, pulse, '2026-11-20', 'now')['events']
        self.assertEqual([(e['symbol'], e['scheduled_date'], e['timing'], e['source']) for e in events], [
            ('OTHER', '2026-11-25', 'After', 'EarningsPulse'), ('ACME', '2027-01-27', 'Pre', 'TradingView')])
        self.assertEqual(events[0]['event_type'], 'RESULTS_SCHEDULED')
        self.assertTrue(earnings.calendar(records, pulse, '2026-11-20', 'now')['available'])  # India's calendar field


if __name__ == '__main__':
    unittest.main()
