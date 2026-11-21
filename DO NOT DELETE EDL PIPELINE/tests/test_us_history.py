"""US history and snapshot checks added with the daily re-read of recent bars."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import build, dhan, fields, history  # noqa: E402
from test_us_market import FieldTests, HistoryTests, bar, utc  # noqa: E402


class SnapshotTests(unittest.TestCase):
    def test_one_row_stamped_later_does_not_hold_the_release(self):
        closed = [{**FieldTests.ROW, 'Sym': f'S{n}', 'LastTradeTime': '10/11/2026 02:29:59'} for n in range(5)]
        outlier = {**FieldTests.ROW, 'Sym': 'ODD', 'LastTradeTime': '11/11/2026 01:00:00'}
        self.assertEqual(build.snapshot_session([*closed, outlier], utc(2026, 11, 10, 0, 30)), '2026-11-09')

    def test_previous_close_is_the_one_the_days_change_is_measured_from(self):
        record = fields.canonical_row({**FieldTests.ROW, 'Ltp': 110.0, 'PPerchange': 10.0, 'BcClose': 221.3})
        self.assertAlmostEqual(record['previous_close'], 100.0)
        # Without a change the screener's own previous close is used.
        self.assertEqual(fields.canonical_row({**FieldTests.ROW, 'BcClose': 340.0})['previous_close'], 340.0)


class RecentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_recent_bars_come_from_yahoo_only(self):
        from datetime import date
        with mock.patch.object(dhan, 'fetch_history', mock.Mock(side_effect=AssertionError('Dhan is not asked'))):
            self.assertEqual(history.fetch_recent('ACME', date(2026, 10, 23), yahoo_fetch=mock.Mock(return_value=[bar('2026-11-06', 10.0)]))[0]['close'], 10.0)
            self.assertEqual(history.fetch_recent('ACME', date(2026, 10, 23), yahoo_fetch=mock.Mock(side_effect=RuntimeError('down'))), [])

    def test_a_normal_day_makes_no_history_requests(self):
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-05', 9.9), bar('2026-11-06', 10.0)])
        with mock.patch.object(build.requests, 'get', mock.Mock(side_effect=AssertionError('Yahoo is not asked'))), \
             mock.patch.object(dhan, 'post', mock.Mock(side_effect=AssertionError('Dhan is not asked'))):
            counts = build.update_histories([HistoryTests.RECORD], self.root, '2026-11-09', interval=0, workers=1)
        self.assertEqual(counts['appended'], 1)


class TradingViewBarTests(unittest.TestCase):
    def found(self, **bar):
        stamp = utc(2026, 11, 9, 14, 30).timestamp()  # 09:30 in New York
        return {'bar': {'time': stamp, 'close': 402.425, 'open': 400.0, 'high': 404.0, 'low': 399.0, 'volume': 5e6,
                        'change_abs': 0.175, 'name': 'V', **bar}}

    def test_the_sessions_bar_and_the_official_previous_close(self):
        from edl_pipeline.markets.us import tradingview
        result = tradingview.daily_bar(self.found(), '2026-11-09')
        self.assertEqual(result['tradingview_bar'], {'date': '2026-11-09', 'open': 400.0, 'high': 404.0, 'low': 399.0, 'close': 402.425, 'volume': 5e6})
        self.assertAlmostEqual(result['tradingview_previous_close'], 402.25)
        # A bar from another day (a halted stock) is not this session's.
        self.assertIsNone(tradingview.daily_bar(self.found(time=utc(2026, 11, 6, 14, 30).timestamp()), '2026-11-09')['tradingview_bar'])
        self.assertIsNone(tradingview.daily_bar(self.found(open=None), '2026-11-09')['tradingview_bar'])

    def test_a_listing_with_another_isin_is_matched_by_ticker_and_carries_its_bar(self):
        from edl_pipeline.markets.us import tradingview
        from test_us_market import TradingViewTests
        rows = TradingViewTests()
        response = rows.response(rows.row('NYSE:ROKU', 'US0000000009', name='ROKU', open=99.0, high=101.0, low=98.0,
                                          volume=1e6, change_abs=1.0))
        records = [{'symbol': 'ROKU', 'isin': 'US77543R1023', 'close': 100.0}]
        report = tradingview.enrich(records, '2026-11-09', fetch_response=lambda: response)
        self.assertEqual(report['matched'], 1)
        self.assertEqual(records[0]['tradingview_bar']['close'], 100.0)
        self.assertEqual(records[0]['tradingview_previous_close'], 99.0)

    def test_too_many_yahoo_fills_or_thin_coverage_stop_the_release(self):
        from edl_pipeline.markets.us import __main__ as entry
        report = {'session': '2026-11-09', 'history': {'appended': 5800, 'filled': 900}, 'benchmarks': {}, 'rs_ratings': 6000,
                  'stocks': 6000, 'aligned': 5900, 'tradingview': {'matched': 6000}}
        with mock.patch.object(entry, 'build', return_value=report):
            self.assertEqual(entry.main(['root']), 1)
            report['history'] = {'appended': 100, 'gap_filled': 5900}  # a missed run fills every stock: no alarm
            self.assertEqual(entry.main(['root']), 0)


if __name__ == '__main__':
    unittest.main()
