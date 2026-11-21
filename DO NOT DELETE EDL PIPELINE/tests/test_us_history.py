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

    def test_a_dhan_limit_on_the_daily_reread_does_not_stop_the_release(self):
        # Yahoo is down (404) and Dhan refuses the re-read: the stock is extended from the snapshot instead.
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-05', 9.9), bar('2026-11-06', 10.0)])
        with mock.patch.object(build.requests, 'get', mock.Mock(return_value=mock.Mock(status_code=404))), \
             mock.patch.object(dhan, 'post', mock.Mock(side_effect=dhan.Throttled('429'))):
            counts = build.update_histories([HistoryTests.RECORD], self.root, '2026-11-09', interval=0, workers=1)
        self.assertEqual(counts['appended'], 1)
        self.assertFalse(counts['throttled'])
        self.assertTrue(counts['dhan_throttled'])
        self.assertEqual(history.read_bars(self.root / 'ACME.csv')[-1]['date'], '2026-11-09')

    def test_recent_bars_come_from_yahoo_first_then_dhan(self):
        yahoo_fetch = mock.Mock(return_value=[bar('2026-11-06', 10.0)])
        dhan_fetch = mock.Mock(return_value=[bar('2026-11-06', 9.0)])
        from datetime import date
        with mock.patch.object(dhan, 'fetch_history', dhan_fetch):
            self.assertEqual(history.fetch_recent('ACME', 1, 'NYSE', date(2026, 10, 23), yahoo_fetch=yahoo_fetch)[0]['close'], 10.0)
            dhan_fetch.assert_not_called()
            yahoo_fetch.return_value = []
            self.assertEqual(history.fetch_recent('ACME', 1, 'NYSE', date(2026, 10, 23), yahoo_fetch=yahoo_fetch)[0]['close'], 9.0)


if __name__ == '__main__':
    unittest.main()
