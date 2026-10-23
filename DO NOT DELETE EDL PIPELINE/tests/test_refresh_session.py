import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from refresh_session import expected_session, resolve_session
import fetch_nse_delivery_data as delivery
from nse_delivery import fetch_latest_full_bhavcopy, HISTORICAL_FILE_URL

IST = ZoneInfo('Asia/Kolkata')
HOLIDAYS = [{'tradingDate': '20-Oct-2026'}, {'tradingDate': '26-Jan-2026'}]


def result(day, row_day=None):
    return {'as_of_date': day}, [{'date': row_day or day}], [{'date': row_day or day}]


class RefreshSessionTests(unittest.TestCase):
    def test_regular_close_weekend_holiday_and_before_open(self):
        for now, expected in [('2026-10-23T16:00', '2026-10-23'),
                              ('2026-10-26T09:00', '2026-10-23'),
                              ('2026-10-25T16:00', '2026-10-23'),
                              ('2026-10-20T16:00', '2026-10-19')]:
            self.assertEqual(expected_session(datetime.fromisoformat(now).replace(tzinfo=IST), HOLIDAYS), expected)

    def test_missing_calendar_year_is_not_silently_assumed(self):
        with self.assertRaises(ValueError):
            expected_session(datetime(2027, 1, 5, 16, tzinfo=IST), HOLIDAYS)

    def test_explicit_override_needs_no_calendar_and_rejects_future_date(self):
        now = datetime(2026, 10, 23, 16, tzinfo=IST)
        self.assertEqual(resolve_session('2026-10-23', now), '2026-10-23')
        with self.assertRaises(ValueError):
            resolve_session('2026-10-24', now)

    def test_expected_date_download_bypasses_the_lagging_report_index(self):
        session = Mock()
        session.get.return_value.content = b'SYMBOL,SERIES,DATE1,DELIV_PER,TTL_TRD_QNTY,DELIV_QTY,OPEN_PRICE,HIGH_PRICE,LOW_PRICE,CLOSE_PRICE\nTEST,EQ,23-Oct-2026,50,100,50,10,12,9,11\n'
        metadata, records, ohlcv = fetch_latest_full_bhavcopy(session, expected_date='2026-10-23')
        session.get.assert_called_once_with(HISTORICAL_FILE_URL.format(date='23102026'), timeout=60)
        self.assertEqual(metadata['as_of_date'], '2026-10-23')
        self.assertEqual(records[0]['date'], ohlcv[0]['date'])

    @patch.object(delivery.time, 'sleep')
    @patch.object(delivery, 'fetch_latest_full_bhavcopy')
    def test_delayed_report_retries_then_accepts_exact_rows(self, fetch, sleep):
        fetch.side_effect = [result('2026-10-22'), result('2026-10-23')]
        self.assertEqual(delivery.fetch_expected_bhavcopy('2026-10-23'), result('2026-10-23'))
        sleep.assert_called_once_with(60)
        fetch.assert_called_with(expected_date='2026-10-23')

    @patch.object(delivery.time, 'sleep')
    @patch.object(delivery, 'fetch_latest_full_bhavcopy')
    def test_stale_or_misdated_report_fails_with_summary_and_no_save(self, fetch, sleep):
        for payload in [result('2026-10-22'), result('2026-10-23', '2026-10-22')]:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                summary = Path(directory)/'summary.md'
                fetch.return_value = payload
                fetch.reset_mock(); sleep.reset_mock()
                with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'GITHUB_STEP_SUMMARY': str(summary), 'EDL_EXPECTED_SESSION': '2026-10-23'}), patch.object(delivery, 'save_json') as save:
                    with self.assertRaisesRegex(RuntimeError, 'Data not advanced'):
                        delivery.main()
                    save.assert_not_called()
                self.assertEqual(fetch.call_count, 5)
                self.assertEqual(sleep.call_count, 4)
                self.assertIn('Data not advanced', summary.read_text())

    @patch.object(delivery.time, 'sleep')
    @patch.object(delivery, 'fetch_latest_full_bhavcopy')
    def test_transient_download_error_retries(self, fetch, sleep):
        fetch.side_effect = [delivery.requests.HTTPError('404'), result('2026-10-23')]
        delivery.fetch_expected_bhavcopy('2026-10-23')
        sleep.assert_called_once_with(60)


if __name__ == '__main__':
    unittest.main()
