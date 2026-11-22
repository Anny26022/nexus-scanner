"""US history and snapshot checks added with the daily re-read of recent bars."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
# The tests folder too: the workflow runs this as tests.test_us_history from the pipeline folder.
for path in (ROOT / "src", ROOT, ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import build, dhan, fields, history  # noqa: E402
import test_us_market as market  # noqa: E402 (the module, so its tests are not collected twice)
from test_us_market import bar, utc  # noqa: E402


class SnapshotTests(unittest.TestCase):
    def test_one_row_stamped_later_does_not_hold_the_release(self):
        closed = [{**market.FieldTests.ROW, 'Sym': f'S{n}', 'LastTradeTime': '10/11/2026 02:29:59'} for n in range(5)]
        outlier = {**market.FieldTests.ROW, 'Sym': 'ODD', 'LastTradeTime': '11/11/2026 01:00:00'}
        self.assertEqual(build.snapshot_session([*closed, outlier], utc(2026, 11, 10, 0, 30)), '2026-11-09')

    def test_previous_close_is_the_one_the_days_change_is_measured_from(self):
        record = fields.canonical_row({**market.FieldTests.ROW, 'Ltp': 110.0, 'PPerchange': 10.0, 'BcClose': 221.3})
        self.assertAlmostEqual(record['previous_close'], 100.0)
        # Without a change the screener's own previous close is used.
        self.assertEqual(fields.canonical_row({**market.FieldTests.ROW, 'BcClose': 340.0})['previous_close'], 340.0)


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
            counts = build.update_histories([market.HistoryTests.RECORD], self.root, '2026-11-09', interval=0, workers=1)
        self.assertEqual(counts['appended'], 1)

    def test_history_progress_is_printed_every_so_many_stocks_and_at_the_end(self):
        import io
        from contextlib import redirect_stdout
        records = [{**market.HistoryTests.RECORD, 'symbol': symbol} for symbol in ('ACME', 'BETA', 'GAMA')]
        for record in records:
            history.write_bars(self.root / f"{record['symbol']}.csv", [bar('2026-11-05', 9.9), bar('2026-11-06', 10.0)])
        out = io.StringIO()
        with mock.patch.object(build, 'PROGRESS_EVERY', 2), redirect_stdout(out):
            build.update_histories(records, self.root, '2026-11-09', interval=0, workers=1, started=0.0)
        lines = out.getvalue().splitlines()
        self.assertEqual([line.split('] ', 1)[1] for line in lines], ['history 2/3: appended 2', 'history 3/3: appended 3'])
        # Without a start time (the benchmarks, and callers outside the build) nothing is printed.
        out = io.StringIO()
        with redirect_stdout(out):
            build.update_histories(records, self.root, '2026-11-09', interval=0, workers=1)
        self.assertEqual(out.getvalue(), '')


class TailTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_the_tail_path_stores_the_same_bars_the_full_path_would(self):
        stored = [bar('2026-11-04', 9.8), bar('2026-11-05', 9.9), {**bar('2026-11-06', 10.03), 'high': 10.1}]
        history.write_bars(self.root / 'ACME.csv', stored)
        record = market.HistoryTests.RECORD
        original = (self.root / 'ACME.csv').read_bytes()
        before = history.session_bars(history.read_bars(self.root / 'ACME.csv'))  # what the full path would read
        self.assertEqual(history.append_tail(record, self.root, '2026-11-09'), 'appended')
        expected = self.root / 'expected.csv'
        full, _ = history.extend(before, record, '2026-11-09')
        history.write_bars(expected, full)
        # Same bars (older rows keep their bytes, so a number may print as 100 rather than 100.0).
        self.assertEqual(history.read_bars(self.root / 'ACME.csv'), history.read_bars(expected))
        self.assertEqual(history.read_bars(self.root / 'ACME.csv')[-2]['close'], 10.0)  # yesterday's late print corrected
        # Every row before the replaced last one keeps its bytes, and no temporary file is left behind.
        prefix = original[:original.rstrip(b'\r\n').rfind(b'\n') + 1]
        self.assertTrue((self.root / 'ACME.csv').read_bytes().startswith(prefix))
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['ACME.csv', 'expected.csv'])

    def test_anything_unusual_goes_to_the_full_path(self):
        record = market.HistoryTests.RECORD
        self.assertIsNone(history.append_tail(record, self.root, '2026-11-09'))  # no file
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-04', 10.0)])
        self.assertIsNone(history.append_tail(record, self.root, '2026-11-09'))  # a gap
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-06', 20.0)])
        self.assertIsNone(history.append_tail(record, self.root, '2026-11-09'))  # a split
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-06', 10.0), bar('2026-11-09', 10.8)])
        self.assertIsNone(history.append_tail(record, self.root, '2026-11-09'))  # already current
        self.assertIsNone(history.append_tail({**record, 'tradingview_bar': None}, self.root, '2026-11-09'))


class YahooEmptyTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def run_with(self, response, records):
        get = mock.Mock(**({'side_effect': response} if isinstance(response, Exception) else {'return_value': response}))
        with mock.patch.object(build.requests, 'get', get):
            build.update_histories(records, self.root, '2026-11-09', interval=0, workers=1)
        return json.loads((self.root / build.YAHOO_EMPTY).read_text()), get

    def test_only_a_real_empty_answer_for_an_uncovered_stock_is_remembered(self):
        uncovered = {**market.HistoryTests.RECORD, 'symbol': 'GONE', 'tradingview_bar': None, 'tradingview_previous_close': None}
        history.write_bars(self.root / 'GONE.csv', [bar('2026-11-04', 10.0)])
        empty, _ = self.run_with(__import__('requests').ConnectionError('down'), [uncovered])
        self.assertEqual(empty, {})  # a failed request is not "Yahoo has nothing"
        empty, _ = self.run_with(mock.Mock(status_code=404), [uncovered])
        self.assertEqual(empty, {'GONE': '2026-11-09'})
        _, get = self.run_with(mock.Mock(status_code=404), [uncovered])
        get.assert_not_called()  # skipped for a week

    def test_a_stock_with_a_tradingview_bar_is_never_skipped(self):
        (self.root / build.YAHOO_EMPTY).write_text(json.dumps({'ACME': '2026-11-08'}))
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-04', 10.0)])  # a gap Yahoo must fill
        _, get = self.run_with(mock.Mock(status_code=404), [market.HistoryTests.RECORD])
        get.assert_called()


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
        rows = market.TradingViewTests()
        response = rows.response(rows.row('NYSE:ROKU', 'US0000000009', name='ROKU', open=99.0, high=101.0, low=98.0,
                                          volume=1e6, change_abs=1.0))
        records = [{'symbol': 'ROKU', 'isin': 'US77543R1023', 'close': 100.0}]
        report = tradingview.enrich(records, '2026-11-09', fetch_response=lambda: response)
        self.assertEqual(report['matched'], 1)
        self.assertEqual(records[0]['tradingview_bar']['close'], 100.0)
        self.assertEqual(records[0]['tradingview_previous_close'], 99.0)

    def test_too_many_yahoo_fills_or_thin_coverage_stop_the_release(self):
        from edl_pipeline.markets.us import __main__ as entry
        report = {'session': '2026-11-09', 'history': {'appended': 5100, 'filled': 900}, 'benchmarks': {}, 'rs_ratings': 6000,
                  'stocks': 6000, 'aligned': 5900, 'tradingview': {'matched': 6000, 'without_bar': 900}}
        with mock.patch.object(entry, 'build', return_value=report):
            self.assertEqual(entry.main(['root']), 1)
            # A cold cache fetches every stock in full: the count is still of stocks without TradingView's bar.
            report['history'] = {'refetched': 6000}
            self.assertEqual(entry.main(['root']), 1)
            report['tradingview']['without_bar'] = 360
            report['history'] = {'appended': 100, 'gap_filled': 5900}  # a missed run fills every stock: no alarm
            self.assertEqual(entry.main(['root']), 0)


if __name__ == '__main__':
    unittest.main()
