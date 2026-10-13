from datetime import datetime
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import fetch_indices_ohlcv as indices
import fetch_all_indices as index_list
from fetch_indices_ohlcv import equity_session, snapshot_matches_session
from ohlcv_utils import read_ohlcv_csv, NSE_TIMEZONE


class IndexSessionAlignmentTests(unittest.TestCase):
    def test_stock_session_survives_midnight_and_rejects_outliers_or_missing_coverage(self):
        now = datetime(2026,10,14,1,30,tzinfo=NSE_TIMEZONE)
        symbols = {str(i) for i in range(10)}
        rows = lambda path: [{'Date':'2026-10-13' if path.stem != '9' else '2026-10-12'}]
        with patch.object(indices, 'read_ohlcv_csv', side_effect=rows):
            self.assertEqual(equity_session('.', symbols, now), '2026-10-13')
        with patch.object(indices, 'read_ohlcv_csv', side_effect=lambda path:
                [{'Date':'2026-10-14' if path.stem == '9' else '2026-10-13'}]):
            self.assertIsNone(equity_session('.', symbols, now))  # one new stock is not a new session
        for rows in ([], [{'Date':'invalid'}], [{'Date':'2026-10-15'}]):
            with self.subTest(rows=rows), patch.object(indices, 'read_ohlcv_csv', return_value=rows):
                self.assertIsNone(equity_session('.', symbols, now))
        self.assertIsNone(equity_session('.', set(), now))

    def test_snapshot_capture_window_includes_midnight_and_weekend_not_next_open(self):
        now = datetime(2026,10,14,12,tzinfo=NSE_TIMEZONE)
        for captured in ('2026-10-13T16:00:00+05:30', '2026-10-14T01:30:00+05:30'):
            self.assertTrue(snapshot_matches_session(captured, '2026-10-13', now))
        for captured in (None, 'invalid', '2026-10-14T01:30:00', '2026-10-13T08:00:00+05:30',
                         '2026-10-14T09:15:00+05:30', '2026-10-15T01:00:00+05:30'):
            self.assertFalse(snapshot_matches_session(captured, '2026-10-13', now))
        monday = datetime(2026,10,12,8,tzinfo=NSE_TIMEZONE)
        self.assertTrue(snapshot_matches_session(monday.isoformat(), '2026-10-09', monday))
        # Missing holiday-calendar evidence must not extend the snapshot window.
        self.assertFalse(snapshot_matches_session('2026-10-14T16:00:00+05:30', '2026-10-13',
                                                now.replace(hour=17)))

    def test_index_list_records_snapshot_capture_time(self):
        now = datetime(2026,10,14,1,30,tzinfo=NSE_TIMEZONE)
        with patch.object(index_list, 'fetch_scanx_data', return_value=[{'Sym':'NIFTY'}]), \
                patch.object(index_list, 'nse_now', return_value=now), patch.object(index_list, 'save_json') as save:
            self.assertTrue(index_list.fetch_all_indices())
        self.assertEqual(save.call_args.args[1][0]['SnapshotFetchedAt'], now.isoformat())

    def test_delayed_run_uses_stock_date_and_dated_provider_candle_wins(self):
        now = datetime(2026,10,14,1,30,tzinfo=NSE_TIMEZONE)
        for provider_close in (None, 101.):
            with self.subTest(provider_close=provider_close), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root/'ohlcv_data').mkdir()
                (root/'ohlcv_data/MAIN.csv').write_text('Date\n2026-10-13\n')
                (root/'indices_ohlcv_data').mkdir()
                (root/'indices_ohlcv_data/NIFTY.csv').write_text(
                    'Date,Open,High,Low,Close,Volume\n2026-10-12,90,110,80,100,1000\n')
                snapshot = {'Symbol':'NIFTY','Exchange':'IDX','Segment':'I','Instrument':'IDX','IndexID':13,
                            'Open':90,'High':110,'Low':80,'Ltp':105,'Volume':1000,'SnapshotFetchedAt':now.isoformat()}
                fetched = [] if provider_close is None else [{'Date':'2026-10-13','Open':90,'High':110,
                                                              'Low':80,'Close':provider_close,'Volume':1000}]
                with patch.object(indices, 'ensure_dir'), patch.object(indices, 'nse_now', return_value=now), \
                        patch.object(indices, 'load_json', side_effect=[[snapshot],[{'Symbol':'MAIN'}]]), \
                        patch.object(indices, 'resolve_path', side_effect=lambda path:root/path), \
                        patch.object(indices, 'fetch_chunk', return_value=fetched) as fetch:
                    self.assertTrue(indices.main())
                rows = read_ohlcv_csv(root/'indices_ohlcv_data/NIFTY.csv')
                self.assertEqual(rows[-1]['Date'], '2026-10-13')
                self.assertEqual(float(rows[-1]['Close']), provider_close or 105.)
                self.assertEqual(fetch.call_count, 1)  # do not skip a single missing session
                end = datetime.fromtimestamp(fetch.call_args.args[0]['END'], NSE_TIMEZONE)
                self.assertEqual(end.date().isoformat(), '2026-10-13')

    def test_uses_current_master_universe_not_stale_cache_files(self):
        with patch.object(indices, 'read_ohlcv_csv', return_value=[{'Date':'2026-10-13'}]) as read:
            self.assertEqual(equity_session('.', {'MAIN'}, datetime(2026,10,14,tzinfo=NSE_TIMEZONE)),
                             '2026-10-13')
        read.assert_called_once_with(Path('MAIN.csv'))


if __name__ == "__main__":
    unittest.main()
