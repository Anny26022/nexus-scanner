import sys
from io import BytesIO
import zipfile
from unittest.mock import Mock
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'src')]
from nse_delivery import normalize_ohlcv_row
from ohlcv_utils import merge_rows_by_date, read_ohlcv_csv, write_ohlcv_csv
from backfill_nse_turnover import backfill, fetch_turnover
from advanced_metrics_processor import process_symbol_csv
from edl_pipeline.scanner.base_publication import trend_series
from edl_pipeline.scanner.trend import evaluate_history


class OfficialTurnoverTests(unittest.TestCase):
    def test_legacy_archive_uses_rupees_and_validates_session(self):
        buffer=BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:
            archive.writestr('cm03OCT2016bhav.csv','SYMBOL,SERIES,TOTTRDVAL,TIMESTAMP\nTEST,EQ,123456789,03-OCT-2016\nWRONG,EQ,42,04-OCT-2016\n')
        client=Mock()
        client.get.side_effect=[Mock(status_code=404),Mock(status_code=200,content=buffer.getvalue())]
        self.assertEqual(fetch_turnover('2016-10-03',client),{'TEST':123456789})
        self.assertIn('/2016/OCT/cm03OCT2016bhav.csv.zip',client.get.call_args.args[0])

    def frame(self):
        return pd.DataFrame({'Date':pd.bdate_range('2026-08-01',periods=30),
            'Open':100,'High':101,'Low':99,'Close':100,'Volume':1000000,'Turnover':200000000})

    def test_official_units_and_invalid_values(self):
        row={'SYMBOL':'TEST','SERIES':'EQ','DATE1':'01-Oct-2026','OPEN_PRICE':100,'HIGH_PRICE':101,
             'LOW_PRICE':99,'CLOSE_PRICE':100,'TTL_TRD_QNTY':1000000,'TURNOVER_LACS':2000}
        self.assertEqual(normalize_ohlcv_row(row)['turnover'],200000000)
        for value in ('nan','inf',-1):
            self.assertNotIn('turnover',normalize_ohlcv_row({**row,'TURNOVER_LACS':value}))

    def test_refresh_preserves_official_value_and_zero(self):
        rows=merge_rows_by_date([{'Date':'2026-10-01','Turnover':123,'Close':100},
                                 {'Date':'2026-10-01','Close':200}])
        self.assertEqual(rows[0]['Turnover'],123)
        self.assertEqual(merge_rows_by_date([*rows,{'Date':'2026-10-01','Turnover':0}])[0]['Turnover'],0)

    def test_mean_median_and_missing_window_never_estimate(self):
        frame=self.frame();spec={'kind':'AVG_TURNOVER','params':{'lookbackDays':20,'comparison':'ABOVE','valueCr':15}}
        self.assertEqual(evaluate_history(frame,[spec])['status'],'match')
        self.assertEqual(trend_series(frame)['medianTurnover20'].iloc[-1],20)
        frame.loc[29,'Turnover']=float('nan')
        self.assertEqual(evaluate_history(frame,[spec])['status'],'unavailable')
        self.assertTrue(pd.isna(trend_series(frame)['medianTurnover20'].iloc[-1]))
        self.assertEqual(evaluate_history(frame.drop(columns='Turnover'),[spec])['status'],'unavailable')

    def test_bulk_backfill_is_cached_and_preserves_prices(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'ohlcv_data').mkdir();path=root/'ohlcv_data/TEST.csv'
            frame=self.frame();frame['Date']=frame.Date.dt.strftime('%Y-%m-%d')
            rows=frame.drop(columns='Turnover').to_dict('records');write_ohlcv_csv(path,rows)
            calls=[]
            def fetch(day,session):
                calls.append(day);return {'TEST':200000000}
            report=backfill(root,20,fetch)
            self.assertEqual(report['applied_rows'],20);self.assertEqual(len(calls),20)
            updated=read_ohlcv_csv(path)
            self.assertEqual(float(updated[-1]['Close']),100)
            self.assertEqual(float(updated[-1]['Turnover']),200000000)
            self.assertEqual(process_symbol_csv(str(path))[1]['Daily Rupee Turnover 20(Cr.)'],20)
            self.assertIsNone(process_symbol_csv(str(path))[1]['Daily Rupee Turnover 50(Cr.)'])
            self.assertEqual(backfill(root,20,fetch)['applied_rows'],0)
            self.assertEqual(len(calls),20)

    def test_calendar_year_horizon_and_session_horizon_are_distinct(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'ohlcv_data').mkdir()
            rows=[{'Date':day,'Open':100,'High':101,'Low':99,'Close':100,'Volume':1}
                  for day in ['2016-09-30','2016-10-03','2026-10-01']]
            write_ohlcv_csv(root/'ohlcv_data/TEST.csv',rows)
            calls=[]
            report=backfill(root,fetcher=lambda day,session: calls.append(day) or {'TEST':123},years=10)
            self.assertEqual(set(calls),{'2016-10-03','2026-10-01'})
            self.assertEqual(report['requested_years'],10)
            self.assertEqual(report['first_date'],'2016-10-03')
