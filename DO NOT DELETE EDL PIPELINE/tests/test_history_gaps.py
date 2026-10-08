"""A healthy latest candle must not hide missing intermediate sessions."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from apply_nse_daily_ohlcv import repair_official_history
from fetch_all_ohlcv import expected_sessions_by_symbol, fetch_single_stock, has_official_history
from ohlcv_utils import missing_history_sessions, parse_history_date, plan_history_ranges, read_ohlcv_csv, write_ohlcv_csv
from edl_pipeline.quality import inspect_breadth_history
from edl_pipeline.artifacts import OHLCV_FETCH_LANE, PHASE2_SCRIPTS


def candle(day, close=11):
    return dict(Date=day, Open=10, High=12, Low=9, Close=close, Volume=100)


def history():
    return [candle((datetime(2020,1,1)+timedelta(days=i)).strftime('%Y-%m-%d')) for i in range(260)] + [candle('2026-09-25'),candle('2026-10-06')]


class HistoryGapTests(unittest.TestCase):
    def test_fast_date_parser_preserves_legacy_dates_and_invalid_inputs(self):
        for value in ['2026-10-07', '2026-1-7', '2024-02-29', '2023-02-29', '20261007', '', None, 42]:
            with self.subTest(value=value):
                try:
                    expected = datetime.strptime(value, '%Y-%m-%d')
                except (ValueError, TypeError) as error:
                    with self.assertRaises(type(error)):
                        parse_history_date(value)
                else:
                    self.assertEqual(parse_history_date(value), expected)

    def test_requests_start_at_listing_date_without_trimming_older_cached_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for existing in ([], [candle('2026-10-05')], [candle('2020-01-02'), candle('2026-10-05')]):
                with self.subTest(existing=existing):
                    write_ohlcv_csv(root / 'TEST.csv', existing)
                    with patch('fetch_all_ohlcv.resolve_path', return_value=root), \
                            patch('fetch_all_ohlcv.is_nse_cash_session', return_value=False), \
                            patch('fetch_all_ohlcv.time.time', return_value=datetime(2026,10,8,18).timestamp()), \
                            patch('fetch_all_ohlcv.fetch_history_chunk', return_value=[candle('2026-10-06'), candle('2026-10-07')]) as fetch:
                        result = fetch_single_stock('TEST', dict(Exch='NSE', Seg='E', Inst='EQUITY', Sid=1,
                            ListingDate='2026-10-05'), official_nse_session='2026-10-07', expected_sessions=['2026-10-06', '2026-10-07'])
                    self.assertEqual(result, 'success')
                    self.assertTrue(fetch.called)
                    self.assertTrue(all(call.args[0]['START'] >= datetime(2026,10,5).timestamp() for call in fetch.call_args_list))
                    if existing:
                        self.assertEqual(read_ohlcv_csv(root / 'TEST.csv')[0]['Date'], existing[0]['Date'])

    def test_latest_official_candle_does_not_hide_internal_gaps(self):
        expected=['2026-09-25','2026-09-28','2026-09-29','2026-10-05','2026-10-06']
        self.assertFalse(has_official_history(history(),'2026-10-06',datetime(2022,1,1).timestamp(),expected))
        ranges=plan_history_ranges(history(),datetime(2020,1,1).timestamp(),datetime(2026,10,6).timestamp(),expected)
        self.assertEqual(ranges,[(int(datetime(2026,9,28).timestamp()),int(datetime(2026,10,6).timestamp()))])
        self.assertEqual(plan_history_ranges(history(),datetime(2020,1,1).timestamp(),datetime(2026,10,6).timestamp()),[])

    def test_no_prelisting_or_unobserved_session_is_required(self):
        self.assertEqual(missing_history_sessions([candle('2026-09-28'),candle('2026-09-30')],['2026-09-25','2026-09-28','2026-09-30']),[])
        self.assertEqual(missing_history_sessions([],['2026-09-28']),['2026-09-28'])

    def test_repair_fetches_gap_and_retains_official_latest_close(self):
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)/'TEST.csv';write_ohlcv_csv(destination,history())
            with patch('fetch_all_ohlcv.resolve_path',return_value=Path(folder)), patch('fetch_all_ohlcv.is_nse_cash_session',return_value=False), patch('fetch_all_ohlcv.time.time',return_value=datetime(2026,10,6,18).timestamp()), patch('fetch_all_ohlcv.fetch_history_chunk',return_value=[candle('2026-09-28'),candle('2026-10-06',10)]) as fetch:
                result=fetch_single_stock('TEST',{'Exch':'NSE','Seg':'E','Inst':'EQUITY','Sid':1},official_nse_session='2026-10-06',expected_sessions=['2026-09-28','2026-10-06'])
            self.assertEqual(result,'success');self.assertEqual(fetch.call_count,1)
            observed={r['Date']:r for r in read_ohlcv_csv(destination)}
            self.assertIn('2026-09-28',observed);self.assertEqual(float(observed['2026-10-06']['Close']),11)

    def test_empty_provider_response_does_not_report_a_gap_as_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            write_ohlcv_csv(Path(folder)/'TEST.csv', history())
            with patch('fetch_all_ohlcv.resolve_path',return_value=Path(folder)), patch('fetch_all_ohlcv.is_nse_cash_session',return_value=False), patch('fetch_all_ohlcv.time.time',return_value=datetime(2026,10,6,18).timestamp()), patch('fetch_all_ohlcv.fetch_history_chunk',return_value=[]):
                with self.assertRaisesRegex(ValueError, 'required history sessions missing'):
                    fetch_single_stock('TEST',{'Exch':'NSE','Seg':'E','Inst':'EQUITY','Sid':1},official_nse_session='2026-10-06',expected_sessions=['2026-09-28','2026-10-06'])

    def test_official_recovery_fills_only_the_evidenced_missing_candle(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_ohlcv_csv(root / 'TEST.csv', [candle('2026-09-28')])
            fetched = []

            def official(day, _session):
                fetched.append(day.isoformat())
                return [
                    {'symbol': 'OTHER', 'series': 'EQ', 'date': day.isoformat(),
                     'open': 1, 'high': 1, 'low': 1, 'close': 1, 'volume': 1},
                    {'symbol': 'TEST', 'series': 'EQ', 'date': day.isoformat(),
                     'open': 20, 'high': 22, 'low': 19, 'close': 21, 'volume': 200},
                ]

            self.assertEqual(repair_official_history({'TEST': {'2026-09-28', '2026-09-29'}}, root, official,
                                                   adjusted_through={'TEST': '2026-09-28'}), 1)
            self.assertEqual(fetched, ['2026-09-29'])
            rows = {row['Date']: row for row in read_ohlcv_csv(root / 'TEST.csv')}
            self.assertEqual(float(rows['2026-09-28']['Close']), 11)
            self.assertEqual(float(rows['2026-09-29']['Close']), 21)

    def test_official_recovery_leaves_provider_fallback_when_nse_has_no_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_ohlcv_csv(root / 'TEST.csv', [candle('2026-09-28')])
            with patch('apply_nse_daily_ohlcv.requests.Session'), \
                    patch('builtins.print'):
                self.assertEqual(repair_official_history(
                    {'TEST': {'2026-09-28', '2026-09-29'}}, root,
                    lambda *_: (_ for _ in ()).throw(ValueError('not published')),
                    adjusted_through={'TEST': '2026-09-28'}), 0)
            self.assertEqual([row['Date'] for row in read_ohlcv_csv(root / 'TEST.csv')], ['2026-09-28'])

    def test_recovery_skips_adjusted_and_unknown_bases_and_batches_safe_gaps(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for symbol in ('ADJUSTED', 'UNKNOWN'):
                write_ohlcv_csv(root / f'{symbol}.csv', [dict(Date='2026-09-25',
                    Open=5, High=6, Low=4, Close=5, Volume=100)])
            expected = {symbol: {'2026-09-28', '2026-09-29', '2026-09-30'}
                        for symbol in ('ADJUSTED', 'UNKNOWN', 'EMPTY')}

            def official(day, _session):
                return [dict(symbol=symbol, series='EQ', date=day.isoformat(),
                             open=20, high=22, low=19, close=21, volume=200)
                        for symbol in expected]

            with patch('apply_nse_daily_ohlcv.read_ohlcv_csv', wraps=read_ohlcv_csv) as read, \
                    patch('apply_nse_daily_ohlcv.write_ohlcv_csv', wraps=write_ohlcv_csv) as write:
                self.assertEqual(repair_official_history(expected, root, official,
                    adjusted_through={'ADJUSTED': '2026-09-28'}), 5)
            self.assertEqual(read.call_count, 3)
            self.assertEqual(write.call_count, 2)
            adjusted = read_ohlcv_csv(root / 'ADJUSTED.csv')
            self.assertEqual([row['Date'] for row in adjusted], ['2026-09-25', '2026-09-29', '2026-09-30'])
            self.assertEqual(float(adjusted[0]['Close']), 5)
            self.assertEqual(len(read_ohlcv_csv(root / 'UNKNOWN.csv')), 1)
            self.assertEqual(len(read_ohlcv_csv(root / 'EMPTY.csv')), 3)

    def test_recovery_write_failure_keeps_other_symbols_retryable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)

            def write(path, rows):
                if path.name == 'LOCKED.csv':
                    raise OSError('locked')
                write_ohlcv_csv(path, rows)

            def official(day, _session):
                return [dict(symbol=symbol, series='EQ', date=day.isoformat(),
                             open=10, high=12, low=9, close=11, volume=100)
                        for symbol in ('LOCKED', 'OK')]

            with patch('apply_nse_daily_ohlcv.write_ohlcv_csv', side_effect=write):
                self.assertEqual(repair_official_history(
                    {'LOCKED': {'2026-09-28'}, 'OK': {'2026-09-28'}}, root, official), 1)
            self.assertFalse((root / 'LOCKED.csv').exists())
            self.assertEqual(len(read_ohlcv_csv(root / 'OK.csv')), 1)

    def test_expected_sessions_use_only_dated_official_security_records(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for day in ['2026-09-25','2026-09-28','2026-10-07']:
                (root/(day+'.json')).write_text(json.dumps({'date':day,'records':[{'symbol':'TEST','series':'E1','date':day}]}))
            self.assertEqual(expected_sessions_by_symbol(root,['TEST','NO_TRADES'],'2026-10-06'),{'TEST':{'2026-09-25','2026-09-28'},'NO_TRADES':set()})
            (root/'2026-09-29.json').write_text(json.dumps({'date':'2026-09-29','records':[{'symbol':'TEST','date':'2026-09-28'}]}))
            with self.assertWarns(UserWarning):
                self.assertEqual(expected_sessions_by_symbol(root,['TEST'],'2026-10-06')['TEST'], {'2026-09-25','2026-09-28'})

    def test_breadth_rejects_thin_history_even_with_healthy_latest_session(self):
        payload={'quality':{'eligible_symbols':2315},'records':[{'date':'2026-09-28','eligible_with_candle':8},{'date':'2026-10-06','eligible_with_candle':2312}]}
        self.assertEqual([r['date'] for r in inspect_breadth_history(payload, ['2026-09-28', '2026-10-06'], window=2)['low_coverage_sessions']],['2026-09-28'])
        payload['records'][0]['eligible_with_candle']=2200
        self.assertEqual(inspect_breadth_history(payload, ['2026-09-28', '2026-10-06'], window=2)['low_coverage_sessions'],[])
        del payload['records'][0]['eligible_with_candle']
        self.assertTrue(inspect_breadth_history(payload, ['2026-09-28', '2026-10-06'], window=2)['errors'])

    def test_bounded_check_preserves_90_percent_boundary(self):
        payload={'quality':{'eligible_symbols':10},'records':[{'date':'2020-01-01','eligible_with_candle':0},{'date':'2026-10-06','eligible_with_candle':9}]}
        self.assertEqual(inspect_breadth_history(payload,['2026-10-06'],window=1)['low_coverage_sessions'],[])

    def test_official_session_ledger_is_ready_before_gap_repair(self):
        self.assertIn('fetch_nse_delivery_history.py',OHLCV_FETCH_LANE)
        self.assertNotIn('fetch_nse_delivery_history.py',PHASE2_SCRIPTS)
        self.assertLess(OHLCV_FETCH_LANE.index('fetch_nse_delivery_history.py'),OHLCV_FETCH_LANE.index('fetch_all_ohlcv.py'))
