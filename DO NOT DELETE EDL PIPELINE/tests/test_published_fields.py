"""Publication integration regressions: source -> normalized stock -> query."""
import sys
import tempfile
import json
import unittest
from pathlib import Path
from datetime import date
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
from import_eod2_ohlcv import import_eod2_ohlcv
from edl_pipeline.scanner.history import SCANNER_SNAPSHOT_FIELDS
from build_corporate_action_ledger import build_ledger, dividend_amount
from enrich_published_fields import enrich
from nse_delivery import normalize_ohlcv_row
from ohlcv_utils import write_ohlcv_csv
from standardize_stock_artifact import canonicalize_stock
from edl_pipeline.transforms.fundamentals import published_financial_fields, valuation_fields
from edl_pipeline.scanner.query import compile_query
from edl_pipeline.scanner.context import _published_field_value
from edl_pipeline.scanner.trend import normalize_history


class PublishedFieldsTests(unittest.TestCase):
    def test_amounts_ratios_and_missing_debt(self):
        fields = published_financial_fields({'REVENUE':'12|9','YEAR':'Jun 2026'},
            {'PROFIT_BEFORE_TAX':'20','INTEREST':'5','YEAR':'Mar 2026'},
            {'TOTAL_ASSETS':'100','CURRENT_ASSETS':'30','CURRENT_LIABILITIES':'12',
             'NON_CURRENT_LIABILITIES':'18','TOTAL_EQUITY':'70','YEAR':'Mar 2026'})
        self.assertEqual(fields['total_revenue_in_lakhs'], 1200)
        self.assertEqual(fields['non_current_assets_in_lakhs'], 7000)
        self.assertEqual(fields['total_liabilities_in_lakhs'], 3000)
        self.assertEqual(fields['interest_coverage'], 5)
        self.assertIsNone(valuation_fields({}, {}, {}, {'NON_CURRENT_LIABILITIES':'50','TOTAL_EQUITY':'100'}, None, None)['D/E'])
        self.assertEqual(valuation_fields({}, {}, {}, {'TOTAL_BORROWINGS':'20','TOTAL_EQUITY':'100'}, None, None)['D/E'], .2)
        missing = published_financial_fields({}, {'INTEREST':'0'}, {'TOTAL_ASSETS':'100'})
        self.assertIsNone(missing['non_current_assets_in_lakhs'])
        self.assertIsNone(missing['interest_coverage'])

    def test_cold_bootstrap_retains_five_year_history_and_new_snapshot_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root/'source'; (source/'daily').mkdir(parents=True)
            (source/'isin_symbol_map.json').write_text(json.dumps({'sym2isin':{'ABC':'ISIN1'},'isin2hist':{}}))
            days = pd.bdate_range('2020-01-01', periods=1261)
            candles = [{'Date':day.strftime('%Y-%m-%d'),'Open':100+i,'High':102+i,
                        'Low':99+i,'Close':101+i,'Volume':100} for i,day in enumerate(days)]
            write_ohlcv_csv(source/'daily/abc.csv', candles)
            report = import_eod2_ohlcv(source, [{'Symbol':'ABC','ISIN':'ISIN1'}], root/'ohlcv')
            self.assertEqual(report['symbol_history']['ABC']['sessions'], 1261)
            stock = {'Symbol':'ABC','Listing Date':'2020-01-01'}
            enrich([stock], {'as_of_date':candles[-1]['Date']}, {}, report, root/'ohlcv')
            self.assertAlmostEqual(stock['return_5y'], (1361/101-1)*100)
            self.assertTrue(stock['history_metadata']['covers_listing'])
            self.assertEqual(stock['all_time_high'], 1362)
            stock['Listing Date'] = '1977-01-01'
            enrich([stock], {'as_of_date':candles[-1]['Date']}, {}, report, root/'ohlcv')
            self.assertIsNone(stock['all_time_high'])
            self.assertIsNotNone(stock['return_5y'])
        for field in ['vwap','dividend_per_share_latest','interest_coverage','total_revenue_in_lakhs','all_time_high']:
            self.assertIn(field, SCANNER_SNAPSHOT_FIELDS)

    def test_vwap_without_delivery_and_bad_values(self):
        row = {'SYMBOL':'ABC','DATE1':'30-Sep-2026','OPEN_PRICE':'10','HIGH_PRICE':'12',
               'LOW_PRICE':'9','CLOSE_PRICE':'11','TTL_TRD_QNTY':'100','AVG_PRICE':'10.5'}
        self.assertEqual(normalize_ohlcv_row(row)['vwap'], 10.5)
        row['AVG_PRICE'] = ''; row['TURNOVER_LACS'] = '.0105'
        self.assertEqual(normalize_ohlcv_row(row)['vwap'], 10.5)
        row['AVG_PRICE'] = 'NaN'
        self.assertNotIn('vwap', normalize_ohlcv_row(row))

    def test_dividend_source_details_and_ambiguity(self):
        self.assertEqual(dividend_amount('Dividend - Rs. 5/- per share'), 5)
        self.assertEqual(dividend_amount('Interim Dividend Re 0.50 Per Share'), .5)
        self.assertEqual(dividend_amount('Final Dividend Rs - 2.25 Per Share'), 2.25)
        self.assertIsNone(dividend_amount('Dividend 200%'))
        self.assertIsNone(dividend_amount('Rs 5 per share and Rs 2 per share'))
        self.assertIsNone(dividend_amount('Dividend Rs Re 1 per share'))
        self.assertIsNone(dividend_amount('Dividend Rs Re1 per share'))
        self.assertIsNone(dividend_amount('shares are 5 per share'))
        action = {'symbol':'ABC','categories':['dividend'],'exDate':'2026-09-01',
                  'subject':'Dividend - Rs. 5 per share'}
        ledger = build_ledger([action, action])
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]['dividend_per_share'], 5)

    def test_history_dates_are_normalized_and_missing_bhavcopy_does_not_erase_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_ohlcv_csv(root/'ABC.csv', [
                {'Date':'29-Sep-2026','Open':10,'High':12,'Low':9,'Close':11,'Volume':100},
                {'Date':'2026-09-29','Open':10,'High':14,'Low':9,'Close':11.5,'Volume':125},
                {'Date':'30/09/2026','Open':11,'High':13,'Low':10,'Close':12,'Volume':150},
            ])
            stock = {'Symbol':'ABC','Listing Date':'29-Sep-2026'}
            enrich([stock], {}, {}, {}, root)
            self.assertEqual(stock['history_metadata']['start_date'], '2026-09-29')
            self.assertEqual(stock['history_metadata']['end_date'], '2026-09-30')
            self.assertEqual(stock['history_metadata']['sessions'], 2)
            self.assertFalse(stock['history_metadata']['covers_listing'])
            self.assertEqual(stock['available_history_high'], 14)

    def test_ambiguous_dividend_has_no_companion_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = {'Symbol':'ABC'}
            ledger = {'range':'2026', 'records':[
                {'symbol':'ABC','action_type':'DIVIDEND','ex_date':'2026-09-01','dividend_per_share':2},
                {'symbol':'ABC','action_type':'DIVIDEND','ex_date':'2026-09-01','dividend_per_share':3},
            ]}
            enrich([stock], {'as_of_date':'2026-09-30'}, ledger, {}, root)
            for field in ('dividend_per_share_latest','dividend_ex_date','dividend_basis','dividend_source_range'):
                self.assertIsNone(stock[field])

    def test_pipeline_enrichment_queries_and_history_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candles = [{'Date':'2026-09-29','Open':10,'High':12,'Low':9,'Close':11,'Volume':100},
                       {'Date':'2026-09-30','Open':11,'High':13,'Low':10,'Close':12,'Volume':150}]
            write_ohlcv_csv(root/'ABC.csv', candles)
            stock = {'Symbol':'ABC','Listing Date':'29-Sep-2026','as_of_date':'2026-09-30'}
            bhav = {'as_of_date':'2026-09-30','ohlcv_records':[{'symbol':'ABC','date':'2026-09-30','vwap':11.5}]}
            report = {'symbol_history':{'ABC':{'start_date':'2026-09-29'}},'source':'EOD2','price_policy':'split_and_bonus_adjusted'}
            ledger = {'records':build_ledger([{'symbol':'ABC','categories':['dividend'],'exDate':'2026-09-29','subject':'Rs 2 per share'},
                                            {'symbol':'ABC','categories':['dividend'],'exDate':'2026-10-01','subject':'Rs 9 per share'}])}
            enrich([stock], bhav, ledger, report, root)
            canonical = canonicalize_stock(stock)
            self.assertEqual(canonical['all_time_high'], 13)
            self.assertEqual(canonical['all_time_low'], 9)
            self.assertIsNone(canonical['return_5y'])
            self.assertEqual(canonical['dividend_per_share_latest'], 2)
            frame = normalize_history(pd.DataFrame(candles))
            self.assertEqual(_published_field_value(frame, canonical, 'vwap', date(2026,9,30)), (11.5, None))
            canonical['vwap_as_of_date'] = '2026-09-29'
            self.assertIsNone(_published_field_value(frame, canonical, 'vwap', date(2026,9,30))[0])
            stock['Listing Date'] = '1990-01-01'
            enrich([stock], bhav, ledger, report, root)
            self.assertIsNone(stock['all_time_high'])
            self.assertIsNone(stock['% from ATH'])
            self.assertEqual(stock['available_history_high'], 13)
        for name in ['Total revenue (in lakhs)', 'Non-current assets (in lakhs)', 'Total liabilities (in lakhs)',
                     'Interest coverage', 'Dividend per share (DPS)', 'VWAP', 'All time high', 'All time low', 'Price to Earning (P/E)']:
            self.assertEqual(compile_query(name+' > 1')['condition'], 'field_comparison')


if __name__ == '__main__':
    unittest.main()
