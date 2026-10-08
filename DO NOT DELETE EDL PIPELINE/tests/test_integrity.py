import csv
from datetime import date
import gzip
import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from advanced_metrics_processor import process_symbol_csv
from process_earnings_performance import calculate_earnings_metrics, get_earnings_info, is_financial_results_filing
from edl_pipeline.quality import inspect_delivery_history
import fetch_fundamental_data
import import_eod2_ohlcv
import apply_nse_daily_ohlcv
import fetch_nse_corporate_actions
from pipeline_utils import save_json
from edl_pipeline.artifacts import FILES_TO_COMPRESS, FINAL_ARTIFACT_SPECS, PHASE4_SCRIPTS, OHLCV_DERIVED_SCRIPT
from edl_pipeline.publication import promote, main as publish
from edl_pipeline.quality import inspect_publication
from edl_pipeline.transforms.fundamentals import analyze_stock, calculate_change, get_float
from edl_pipeline.validators import validate_json, validate_gzip_json
from build_corporate_action_ledger import build_ledger


class IntegrityTests(unittest.TestCase):
    def test_eod2_bootstrap_joins_by_isin_overlays_history_and_keeps_newer_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "eod2_data"
            daily = source / "daily"
            daily.mkdir(parents=True)
            (source / "isin_symbol_map.json").write_text(json.dumps({
                "isin2hist": {"INE000": [{"symbol": "OLDNAME", "from_date": "2020-01-01", "to_date": "2026-12-31"}]},
            }))
            (source / "meta.json").write_text(json.dumps({"lastUpdate": "2026-09-18T00:00:00+05:30"}))
            (daily / "oldname.csv").write_text(
                "Date,Open,High,Low,Close,Volume,DLV_QTY\n"
                "2025-01-01,10,12,9,11,100,70\n"
                "2025-01-02,11,13,10,12,200,140\n"
            )
            output = root / "ohlcv_data"
            output.mkdir()
            (output / "NEWNAME.csv").write_text(
                "Date,Open,High,Low,Close,Volume\n"
                "2025-01-01,100,120,90,110,1\n"
                "2026-09-25,200,210,190,205,5\n"
            )
            report = import_eod2_ohlcv.import_eod2_ohlcv(
                source, [{"Symbol": "NEWNAME", "ISIN": "INE000"}], output,
                root / "eod2_delivery_history_data",
            )
            rows = import_eod2_ohlcv.read_ohlcv_csv(output / "NEWNAME.csv")
            self.assertEqual(report["imported_symbols"], 1)
            self.assertEqual(report["source_last_update"], "2026-09-18T00:00:00+05:30")
            self.assertEqual(report["price_policy"], "split_and_bonus_adjusted")
            self.assertEqual(report["volume_policy"], "exchange_traded_quantity_unadjusted")
            self.assertEqual(report["delivery_policy"], "exchange_reported_unadjusted")
            self.assertEqual([row["Date"] for row in rows], ["2025-01-01", "2025-01-02", "2026-09-25"])
            self.assertEqual(rows[0]["Close"], "11.0")
            self.assertEqual(rows[0]["Volume"], "100.0")
            self.assertEqual(rows[-1]["Close"], "205")
            self.assertNotIn("DLV_QTY", rows[0])
            with (root / "eod2_delivery_history_data" / "NEWNAME.csv").open() as handle:
                delivery = list(csv.DictReader(handle))
            self.assertEqual(report["delivery_rows"], 2)
            self.assertEqual(delivery[0]["delivery_percent"], "70.0")

    def test_eod2_bootstrap_imports_verified_history_before_current_isin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "eod2_data"
            daily = source / "daily"
            daily.mkdir(parents=True)
            (source / "isin_symbol_map.json").write_text(json.dumps({
                "sym2isin": {"NEWNAME": "INE000"},
                "isin2hist": {"INE000": [
                    {"symbol": "OLDNAME", "from_date": "2020-01-01", "to_date": "2024-12-31"},
                    {"symbol": "NEWNAME", "from_date": "2025-01-01", "to_date": "2026-12-31"},
                ]},
            }))
            (daily / "oldname.csv").write_text(
                "Date,Open,High,Low,Close,Volume\n"
                "2020-01-02,20,22,19,21,200\n"
            )
            (daily / "newname.csv").write_text(
                "Date,Open,High,Low,Close,Volume\n"
                "2010-01-04,10,12,9,11,100\n"
                "2020-01-02,90,92,89,91,900\n"
                "2025-01-02,30,32,29,31,300\n"
            )
            output = root / "ohlcv_data"
            report = import_eod2_ohlcv.import_eod2_ohlcv(
                source, [{"Symbol": "NEWNAME", "ISIN": "INE000"}], output,
            )
            rows = import_eod2_ohlcv.read_ohlcv_csv(output / "NEWNAME.csv")
            self.assertEqual([row["Date"] for row in rows], ["2010-01-04", "2020-01-02", "2025-01-02"])
            self.assertEqual(rows[1]["Close"], "21.0")
            self.assertEqual(report["verified_symbol_history_symbols"], 1)
            self.assertEqual(report["verified_symbol_history_additional_rows"], 1)

    def test_eod2_bootstrap_does_not_trust_unverified_symbol_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "eod2_data"
            daily = source / "daily"
            daily.mkdir(parents=True)
            (source / "isin_symbol_map.json").write_text(json.dumps({
                "sym2isin": {"CURRENT": "DIFFERENT_ISIN"},
                "isin2hist": {"INE000": [
                    {"symbol": "CURRENT", "from_date": "2025-01-01", "to_date": "2026-12-31"},
                ]},
            }))
            (daily / "current.csv").write_text(
                "Date,Open,High,Low,Close,Volume\n"
                "2010-01-04,10,12,9,11,100\n"
                "2025-01-02,30,32,29,31,300\n"
            )
            output = root / "ohlcv_data"
            report = import_eod2_ohlcv.import_eod2_ohlcv(
                source, [{"Symbol": "CURRENT", "ISIN": "INE000"}], output,
            )
            rows = import_eod2_ohlcv.read_ohlcv_csv(output / "CURRENT.csv")
            self.assertEqual([row["Date"] for row in rows], ["2025-01-02"])
            self.assertEqual(report["verified_symbol_history_additional_rows"], 0)

    def test_official_nse_close_overrides_only_its_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "ohlcv_data"
            output.mkdir()
            (output / "ABC.csv").write_text(
                "Date,Open,High,Low,Close,Volume\n"
                "2026-09-25,1,2,1,2,10\n"
                "2026-09-26,3,4,3,4,20\n"
            )
            applied = apply_nse_daily_ohlcv.apply_official_ohlcv(
                [{"Symbol": "ABC"}], [{
                    "symbol": "ABC", "date": "2026-09-25", "open": 10, "high": 12,
                    "low": 9, "close": 11, "volume": 100,
                }], output,
            )
            rows = import_eod2_ohlcv.read_ohlcv_csv(output / "ABC.csv")
            self.assertEqual(applied, 1)
            self.assertEqual(rows[0]["Close"], "11")
            self.assertEqual(rows[1]["Close"], "4")

    def test_earnings_date_accepts_approved_lodr_outcome_not_intimation(self):
        approved = {
            "descriptor": "Outcome of Board Meeting",
            "news_date": "2026-07-27 18:07:24",
            "news_body": "The Board approved the unaudited financial results for the quarter ended June 30 2026.",
        }
        intimation = {
            "descriptor": "Board Meeting",
            "news_date": "2026-07-20 16:46:00",
            "news_body": "Meeting scheduled to consider unaudited financial results for the quarter ended June 30 2026.",
        }
        self.assertTrue(is_financial_results_filing(approved))
        self.assertFalse(is_financial_results_filing(intimation))
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
            json.dump({"data": [intimation, approved]}, handle)
            handle.flush()
            self.assertEqual(get_earnings_info(handle.name)[0], "2026-07-27 18:07:24")

    def history(self, root, count, flat=False):
        rows = []
        for i, day in enumerate(pd.bdate_range('2025-01-01', periods=count)):
            rows.append(dict(Date=str(day.date()), Open=100+i, High=100+i if flat else 102+i,
                             Low=100+i if flat else 99+i, Close=100+i, Volume=1000+i))
        path = root / 'IPO.csv'
        pd.DataFrame(rows).to_csv(path, index=False)
        return path

    def test_independent_indicator_warmups(self):
        with tempfile.TemporaryDirectory() as tmp:
            for count in (1, 5, 13, 14, 19, 20, 21, 50, 51, 126, 127, 199, 200, 201, 252, 253):
                with self.subTest(count=count):
                    _, metrics = process_symbol_csv(self.history(Path(tmp), count))
                    self.assertIsNotNone(metrics)
                    self.assertEqual(metrics['atr14'] is not None, count >= 14)
                    self.assertEqual(metrics['relative_volume_20'] is not None, count >= 21)
                    self.assertEqual(metrics['close_above_sma200'] is not None, count >= 200)
                    self.assertEqual(metrics['sma50_crossed_above_sma200_today'] is not None, count >= 201)
                    self.assertEqual(metrics['breakout_above_52w_high'] is not None, count >= 253)
                    self.assertEqual(metrics['6 Month Returns(%)'] is not None, count >= 127)

    def test_flat_range_does_not_discard_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, metrics = process_symbol_csv(self.history(Path(tmp), 21, flat=True))
        self.assertIsNone(metrics['close_near_day_high'])
        self.assertIsNotNone(metrics['relative_volume_20'])

    def test_zero_earnings_base_is_unavailable_not_infinity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'zero.csv'
            path.write_text('Date,Close,High\n2026-01-01,0,0\n2026-01-02,10,11\n')
            self.assertEqual(calculate_earnings_metrics(path, '2026-01-02'), (None, None))
        self.assertEqual(calculate_earnings_metrics('missing', None), (None, None))

    def test_earnings_history_is_sorted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'unsorted.csv'
            path.write_text('Date,Close,High\n2026-01-02,110,120\n2026-01-01,100,101\n')
            self.assertEqual(calculate_earnings_metrics(path, '2026-01-02'), (10.0, 20.0))

    def test_missing_financials_remain_null_but_real_zero_survives(self):
        row = analyze_stock({'Symbol': 'IPO'}, {}, {}, {})
        for key in ('Net Profit Latest Quarter', 'QoQ % Net Profit Latest', 'P/E', 'D/E', 'Forward P/E', 'FII % change QoQ', 'close'):
            self.assertIsNone(row[key], key)
        self.assertEqual(get_float('0'), 0)
        self.assertIsNone(get_float('Infinity'))
        self.assertEqual(calculate_change(0, 10), -100)
        self.assertIsNone(calculate_change(10, 0))

    def test_failed_fundamental_batch_does_not_publish_partial_data(self):
        master=[{'ISIN':'ONE','Symbol':'A'},{'ISIN':'TWO','Symbol':'B'}]
        with mock.patch.object(fetch_fundamental_data,'load_json',return_value=master), \
             mock.patch.object(fetch_fundamental_data,'BATCH_SIZE',1), \
             mock.patch.object(fetch_fundamental_data,'post_json',side_effect=[{'status':'success','data':[{'isin':'ONE'}]},OSError('offline')]), \
             mock.patch.object(fetch_fundamental_data.time,'sleep'), \
             mock.patch.object(fetch_fundamental_data,'save_json') as saved:
            self.assertFalse(fetch_fundamental_data.fetch_fundamental_data())
            saved.assert_not_called()

    def test_nested_nonfinite_serialization_is_strict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'finite.json'
            save_json(path, {'rows': [{'x': float('inf'), 'y': float('nan'), 'z': 0}]})
            self.assertEqual(json.loads(path.read_text()), {'rows': [{'x': None, 'y': None, 'z': 0}]})

    def test_validator_checks_later_rows_and_overflow_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'rows.json'
            path.write_text('[{"symbol":"A"},{}]')
            self.assertFalse(validate_json(path, required_fields=('symbol',)).ok)
            for value in ('Infinity', 'NaN', '1e999'):
                path.write_text('[{"value":'+value+'}]')
                self.assertFalse(validate_json(path).ok)
                compressed = Path(tmp) / 'rows.json.gz'
                compressed.write_bytes(gzip.compress(path.read_bytes()))
                self.assertFalse(validate_gzip_json(compressed).ok)

    def test_v2_registered_for_generation_compression_and_validation(self):
        self.assertIn(OHLCV_DERIVED_SCRIPT, PHASE4_SCRIPTS)
        paths = {spec.path for spec in FINAL_ARTIFACT_SPECS}
        for name in ('market_breadth_v2', 'all_indices_history_v2', 'breadth_universe_snapshot'):
            self.assertEqual(FILES_TO_COMPRESS[name+'.json'], name+'.json.gz')
            self.assertIn(name+'.json.gz', paths)

    def fixture(self, root):
        stamp='2026-09-24T12:00:00+00:00'
        bar={'date':'2026-09-24','open':100,'high':102,'low':99,'close':101,'volume':10}
        files={
            'all_stocks_fundamental_analysis.json.gz':[dict(bar, symbol='ABC', as_of_date='2026-09-24', atr14=None)],
            'master_isin_map.json':[{'Symbol':'ABC'}],
            'all_indices_list.json':[{'Symbol':'NIFTY'}, {'Symbol':'NIFTY 500'}],
            'sector_analytics.json.gz':{'sectors':[], 'industries':[]},
            'all_indices_history_v2.json.gz':{'generated_at':stamp,'indices':[
                {'symbol':'NIFTY','records':[bar]},
                {'symbol':'NIFTY 500','records':[bar]},
            ]},
            'market_breadth_v2.json.gz':{'generated_at':stamp,'quality':{'eligible_symbols':1},'records':[{'date':(date(2026,9,24)-timedelta(days=offset)).isoformat(), 'eligible_with_candle':1} for offset in reversed(range(30))]},
            'breadth_universe_snapshot.json.gz':{'generated_at':stamp},
            'corporate_action_ledger.json.gz':{'source':'test','price_adjusted':False,'records':[]},
            'nse_fno_ban.json.gz':{'source':'test','available':False,'trade_date':None,'symbols':[]},
            'rs_rating_daily.json.gz':{
                'source':'test','as_of_date':'2026-09-24',
                'methodology':{'benchmark':'NIFTY 500'},
                'ratings':{'ABC':{'one_month':1,'three_month':1,'six_month':1,'twelve_month':1,'front_weighted':1}},
            },
        }
        for name, data in files.items():
            self.write(root, name, data)
        delivery_dir = root / 'delivery_history_data'; delivery_dir.mkdir(exist_ok=True)
        for offset in range(252):
            day = (date(2026, 9, 24) - timedelta(days=offset)).isoformat()
            (delivery_dir / f'{day}.json').write_text(json.dumps({
                'date': day,
                'records': [{'symbol': 'ABC', 'series': 'EQ', 'date': day, 'delivery_percent': 50}],
            }))
        (root/'market_breadth.json.gz').write_bytes(gzip.compress(b'Type of Info,2026-09-24\nAdvances,1\n'))
        return files

    def write(self, root, name, data):
        raw=json.dumps(data).encode()
        (root/name).write_bytes(gzip.compress(raw) if name.endswith('.gz') else raw)

    def test_whole_publication_and_symbol_availability(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            report=inspect_publication(root, today=date(2026,9,24))
            self.assertEqual(report['errors'], [])
            self.assertIn('atr14', report['symbols'][0]['missing_fields'])
            self.assertEqual(report['coverage']['listing_date']['missing'], 1)
            self.assertFalse(report['corporate_action_ledger']['price_adjusted'])

    def test_delivery_history_allows_only_the_immediately_prior_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            (root / 'delivery_history_data' / '2026-09-24.json').unlink()
            report = inspect_delivery_history(root, '2026-09-24', '2026-09-23')
            self.assertFalse(report['reference_session_present'])
            self.assertTrue(report['previous_session_present'])
            self.assertTrue(report['aligned_session_present'])
            self.assertEqual(report['aligned_session'], '2026-09-23')

    def test_stale_mixed_invalid_and_incomplete_publications_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for scenario in ('old_generation','missing_symbol','invalid_ohlc','stale_stock','duplicate_index_date','wrong_breadth_date'):
                with self.subTest(scenario=scenario):
                    data=self.fixture(root)
                    if scenario=='old_generation':data['market_breadth_v2.json.gz']['generated_at']='2026-08-07T12:00:00+00:00'
                    if scenario=='missing_symbol':data['master_isin_map.json'].append({'Symbol':'MISSING'})
                    if scenario=='invalid_ohlc':data['all_stocks_fundamental_analysis.json.gz'][0]['high']=0
                    if scenario=='stale_stock':data['all_stocks_fundamental_analysis.json.gz'][0]['as_of_date']='2026-09-23'
                    if scenario=='duplicate_index_date':data['all_indices_history_v2.json.gz']['indices'][0]['records']*=2
                    if scenario=='wrong_breadth_date':data['market_breadth_v2.json.gz']['records'][0]['date']='2026-09-23'
                    for name,value in data.items():self.write(root,name,value)
                    self.assertTrue(inspect_publication(root,today=date(2026,9,24))['errors'])

    def test_missing_historical_breadth_blocks_current_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self.fixture(root)
            files['market_breadth_v2.json.gz']['records'][-2]['eligible_with_candle'] = 0
            self.write(root, 'market_breadth_v2.json.gz', files['market_breadth_v2.json.gz'])
            report = inspect_publication(root, today=date(2026,9,24))
            self.assertTrue(any('breadth candle coverage below 90%' in error for error in report['errors']))
            self.assertEqual(report['breadth_history']['low_coverage_sessions'][0]['date'], '2026-09-23')

    def test_exact_session_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            self.assertTrue(inspect_publication(root,today=date(2026,9,24),expected_session='2026-09-23')['errors'])

    def test_rs_ratings_require_current_nifty500_metadata_and_values(self):
        cases = {
            'stale_nifty_500': 'RS ratings and NIFTY 500 sessions differ from the publication session',
            'invalid_methodology': 'RS ratings methodology is missing or invalid',
            'empty_ratings': 'RS ratings are empty or invalid',
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for scenario, expected_error in cases.items():
                with self.subTest(scenario=scenario):
                    data = self.fixture(root)
                    if scenario == 'stale_nifty_500':
                        data['all_indices_history_v2.json.gz']['indices'][1]['records'][0]['date'] = '2026-09-23'
                    elif scenario == 'invalid_methodology':
                        data['rs_rating_daily.json.gz']['methodology'] = []
                    else:
                        data['rs_rating_daily.json.gz']['ratings'] = {}
                    for name, value in data.items():
                        self.write(root, name, value)
                    self.assertIn(expected_error, inspect_publication(root, today=date(2026, 9, 24))['errors'])

    def test_failed_promotion_restores_all_previous_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stage=root/'stage';stage.mkdir();dest=root/'dest';dest.mkdir()
            for name in ('a','b'):
                (stage/name).write_text('new');(dest/name).write_text('old')
            from edl_pipeline.publication import atomic_copy
            calls=0
            def failing(source, path):
                nonlocal calls
                calls+=1
                if calls==2:raise OSError('disk failure')
                atomic_copy(source,path)
            with mock.patch('edl_pipeline.publication.atomic_copy',side_effect=failing):
                with self.assertRaises(OSError):promote(stage,dest,['a','b'])
            self.assertEqual([(dest/name).read_text() for name in ('a','b')], ['old','old'])

    def test_missing_candidate_never_replaces_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stage=root/'stage';stage.mkdir();dest=root/'dest';dest.mkdir()
            (stage/'a').write_text('new');(dest/'a').write_text('old')
            with self.assertRaises(FileNotFoundError):promote(stage,dest,['a','missing'])
            self.assertEqual((dest/'a').read_text(),'old')

    def test_failed_worker_keeps_published_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'all_indices_list.json').write_text('old')
            def failed_worker(*args, **kwargs):
                stage = Path(kwargs['env']['EDL_BASE_DIR'])
                (stage / 'price_validation_report.json').write_text('{"errors":[{"symbol":"BI"}]}')
                return mock.Mock(returncode=1)
            with mock.patch('edl_pipeline.publication.pipeline_utils.BASE_DIR',str(root)), mock.patch('edl_pipeline.publication.subprocess.run',side_effect=failed_worker):
                self.assertEqual(publish(),1)
            self.assertEqual((root/'all_indices_list.json').read_text(),'old')
            self.assertFalse(json.loads((root/'pipeline_failure_report.json').read_text())['published'])
            self.assertEqual(json.loads((root/'price_validation_report.json').read_text())['errors'], [{'symbol':'BI'}])

    def test_quality_rejection_keeps_published_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'all_indices_list.json').write_text('old')
            with mock.patch('edl_pipeline.publication.pipeline_utils.BASE_DIR',str(root)), \
                 mock.patch('edl_pipeline.publication.subprocess.run',return_value=mock.Mock(returncode=0)), \
                 mock.patch('edl_pipeline.publication.inspect_publication',return_value={'errors':['stale benchmark']}):
                self.assertEqual(publish(),1)
            self.assertEqual((root/'all_indices_list.json').read_text(),'old')

    def test_publication_rejects_sme_record_in_canonical_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            stocks = json.loads(gzip.decompress((root / 'all_stocks_fundamental_analysis.json.gz').read_bytes()))
            stocks[0]['is_sme'] = True
            self.write(root, 'all_stocks_fundamental_analysis.json.gz', stocks)
            report = inspect_publication(root, today=date(2026, 9, 24))
            self.assertIn('canonical stock universe contains SME securities: 1', report['errors'])

    def test_success_promotes_artifacts_and_quality_together(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def worker(command, cwd, env):
                stage=Path(cwd)
                for spec in FINAL_ARTIFACT_SPECS:
                    (stage/spec.path).write_bytes(b'new validated bytes')
                self.write(stage,'pipeline_report.json',{'exit_code':0})
                (stage/'chart_artifacts').mkdir()
                (stage/'chart_artifacts/index.json').write_text('{}')
                return mock.Mock(returncode=0)
            with mock.patch('edl_pipeline.publication.pipeline_utils.BASE_DIR',str(root)), \
                 mock.patch('edl_pipeline.publication.subprocess.run',side_effect=worker), \
                 mock.patch('edl_pipeline.publication.publish_frontend') as frontend_publish, \
                 mock.patch('edl_pipeline.publication.inspect_publication',return_value={'errors':[]}):
                self.assertEqual(publish(),0)
            frontend_publish.assert_called_once_with(root)
            self.assertTrue(json.loads((root/'pipeline_report.json').read_text())['published'])
            self.assertTrue(all((root/spec.path).read_bytes()==b'new validated bytes' for spec in FINAL_ARTIFACT_SPECS))
            self.assertEqual(json.loads((root/'data_quality.json').read_text()),{'errors':[]})

    def test_real_transform_scripts_generate_publishable_outputs_offline(self):
        today=datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            stocks_dir=root/'ohlcv_data';stocks_dir.mkdir()
            indices_dir=root/'indices_ohlcv_data';indices_dir.mkdir()
            # Use dates ending on today's calendar date to isolate publication
            # mechanics from exchange-calendar policy (tested separately).
            dates=pd.date_range(end=today, periods=300, freq='D')
            bars=[{'Date':str(day.date()),'Open':100+i,'High':102+i,'Low':99+i,'Close':101+i,'Volume':1000+i}
                  for i,day in enumerate(dates)]
            frame=pd.DataFrame(bars)
            frame.to_csv(stocks_dir/'ABC.csv',index=False)
            frame.to_csv(indices_dir/'NIFTY.csv',index=False)
            frame.to_csv(indices_dir/'NIFTY_500.csv',index=False)
            last=bars[-1]
            master=[{'Symbol':'ABC','Name':'ABC Ltd','ISIN':'INE000000001','Sid':1}]
            self.write(root,'master_isin_map.json',master)
            self.write(root,'fundamental_data.json',[{
                'Symbol':'ABC','isin':'INE000000001',
                'sHp':{
                    'YEAR':'202606', 'PROMOTER':'50', 'FII':'20', 'DII':'10',
                    'PUBLIC':'20', 'NO_OF_SHARE_HOLDERS':'1000',
                },
            }])
            self.write(root,'dhan_data_response.json',[{
                'Sym':'ABC','DispSym':'ABC Ltd','Isin':'INE000000001','Sid':1,
                'Mcap':1000,'Ltp':last['Close'],'Open':last['Open'],
                'High':last['High'],'Low':last['Low'],'Volume':last['Volume'],
            }])
            self.write(root,'mainboard_scanx_data.json',[{
                'Sym':'ABC','DispSym':'ABC Ltd','Isin':'INE000000001','Sid':1,
                'Mcap':1000,'Ltp':last['Close'],'Open':last['Open'],
                'High':last['High'],'Low':last['Low'],'Volume':last['Volume'],
            }])
            self.write(root,'sme_market_data.json',[])
            self.write(root,'mainboard_universe_report.json',{
                'raw_scanx_count':1,'excluded_sme_count':0,
                'mainboard_count':1,'mainboard_scanx_count':1,
            })
            (root/'nse_equity_list.csv').write_text(
                'SYMBOL,NAME OF COMPANY,SERIES,DATE OF LISTING\n'
                'ABC,ABC Ltd,EQ,01-JAN-2026\n'
            )
            self.write(root,'nse_corporate_actions.json',{
                'source':'https://www.nseindia.com/api/corporates-corporateActions',
                'range':{'from':'2018-01-01','to':str(today)},'actions':[],
            })
            self.write(root,'nse_corporate_action_adjustments.json',{
                'source':'https://www.nseindia.com/api/corporates-corporateActions',
                'range':{'from':'2018-01-01','to':str(today)},'revision':'test','actions':[],
            })
            self.write(root,'all_indices_list.json',[
                {'Symbol':'NIFTY','IndexID':13,'IndexName':'Nifty 50'},
                {'Symbol':'NIFTY 500','IndexID':19,'IndexName':'NIFTY 500'},
            ])
            self.write(root,'nse_fno_ban.json',{'source':'test','available':False,'trade_date':None,'symbols':[]})
            self.write(root,'earnings_calendar.json',{'source':'BSE forthcoming results calendar','fetched_at':'2026-10-01T00:00:00+00:00','events':[],'available':True})
            (root/'filing_history_data').mkdir()
            self.write(root/'filing_history_data','filing_history.json',{
                'symbols':{'ABC':{'isin':'INE000000001','lodr_backfill_complete':True,'filings':[{'news_id':'one'}]}},
            })
            shutil.copy2(ROOT/'breadth_methodology.json',root/'breadth_methodology.json')
            delivery_dir=root/'delivery_history_data'; delivery_dir.mkdir()
            for offset in range(252):
                day=(today-timedelta(days=offset)).isoformat()
                (delivery_dir/f'{day}.json').write_text(json.dumps({'date':day,'records':[{'symbol':'ABC','series':'EQ','date':day,'delivery_percent':50}]}))
            env=dict(os.environ,EDL_BASE_DIR=str(root))
            for name in ('bulk_market_analyzer.py','advanced_metrics_processor.py',
                         'process_earnings_performance.py','process_market_breadth.py',
                         'process_historical_market_breadth.py','add_corporate_events.py',
                         'process_mbi_market_breadth.py','build_rs_ratings.py','build_shareholding_history.py',
                         'build_corporate_action_ledger.py','standardize_stock_artifact.py',
                         'build_filing_history_artifact.py',
                         'build_quarterly_financial_ledger.py',
                         'build_ipo_screener_artifact.py'):
                result=subprocess.run([sys.executable,str(ROOT/name)],cwd=root,env=env,capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode,0,name+'\n'+result.stdout+'\n'+result.stderr)
            rs_output = json.loads((root / 'rs_rating_daily.json').read_text())
            self.assertIn('ABC', rs_output['ratings'])
            self.assertEqual(
                set(rs_output['ratings']['ABC']),
                {'one_month', 'three_month', 'six_month', 'twelve_month', 'front_weighted'},
            )
            for raw,compressed in FILES_TO_COMPRESS.items():
                (root/compressed).write_bytes(gzip.compress((root/raw).read_bytes()))
            report=inspect_publication(root,today=today,expected_session=str(today))
            self.assertEqual(report['errors'],[])
            self.assertEqual(report['stock_count'],1)
            self.assertIn('net_profit_latest_quarter',report['symbols'][0]['missing_fields'])

    def test_official_action_ledger_preserves_deterministic_and_review_status(self):
        ledger = build_ledger([
            {'symbol':'ABC','categories':['split'],'exDate':'2026-01-01','recordDate':'2025-12-30','subject':'Face value 10 to 5',
             'adjustment':{'mode':'deterministic','priceFactor':0.5,'shareFactor':2}},
            {'symbol':'ABC','categories':['scheme'],'exDate':'2026-01-02','subject':'Scheme of arrangement',
             'adjustment':{'mode':'manual-review'}},
        ])
        self.assertEqual(ledger[0]['adjustment_status'], 'verified')
        self.assertEqual(ledger[0]['adjustment_factor'], 0.5)
        self.assertEqual(ledger[0]['share_factor'], 2)
        self.assertEqual(ledger[1]['adjustment_status'], 'manual-review')

    def test_official_nse_actions_create_verified_runtime_adjustments(self):
        full, runtime = fetch_nse_corporate_actions.build_outputs([
            {'series':'EQ','symbol':'ABC','isin':'INE000000001','comp':'ABC Ltd','subject':'Bonus 1:1',
             'exDate':'01-Jan-2026','recDate':'02-Jan-2026','faceVal':'5'},
            {'series':'EQ','symbol':'ABC','isin':'INE000000001','comp':'ABC Ltd','subject':'Scheme of Arrangement',
             'exDate':'03-Jan-2026','recDate':'04-Jan-2026','faceVal':'5'},
            {'series':'BE','symbol':'IGNORED','subject':'Bonus 1:1','exDate':'01-Jan-2026'},
        ], '2018-01-01', '2026-12-31', generated_at='2026-01-01T00:00:00Z')
        self.assertEqual(len(full['actions']), 2)
        self.assertEqual(full['actions'][0]['adjustment']['priceFactor'], 0.5)
        self.assertEqual(len(runtime['actions']), 2)
        self.assertTrue(runtime['revision'])


if __name__=='__main__':unittest.main()
