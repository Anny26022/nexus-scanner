import json
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
import scanner_bridge as bridge
from snapshot_technicals import technical_metrics, CONFIGURATIONS, MA_PERIODS
from publish_snapshot import _stock_row, primitive_keys
from edl_pipeline.scanner.calculation_cache import calculation_cache
from edl_pipeline.scanner.trend import _ma


class TechnicalSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.session = '2026-10-09'
        close = 100 + np.arange(400) / 10 + np.sin(np.arange(400) / 7) * 5
        self.frame = pd.DataFrame({'Date':pd.bdate_range(end=self.session, periods=400),
            'Open':close-1, 'High':close+2, 'Low':close-2, 'Close':close, 'Volume':1000+np.arange(400)})
        self.stock = {'symbol':'TEST', 'as_of_date':self.session,
            'listing_date':str(self.frame.Date.iloc[0].date()), 'latest_earnings_date':'2026-10-02'}
        self.context = {'stock':self.stock, 'screen_date':self.session, 'rs_ratings':{},
            'benchmarks':{'NIFTY_50':self.frame.assign(Close=100+np.arange(400)/20)},
            'fno_ban_symbols':{'TEST':True}, 'fno_ban_available':True, 'fno_ban_trade_date':self.session}

    def test_all_configurations_use_existing_engine_values_and_semantics(self):
        native = json.loads((Path(__file__).parent / 'src/data/nativeConditions.json').read_text())
        defaults = {d['id']:{p['id']:p['defaultValue'] for p in d['parameters']} for d in native}
        with calculation_cache():
            metrics = technical_metrics(self.stock, self.frame, self.context, self.session)
            for config in CONFIGURATIONS:
                with self.subTest(id=config['id']):
                    params = defaults.get(config['id'], dict(config['fixed']))
                    if config.get('threshold') and config['threshold'] not in params:
                        params = {**params, config['threshold']:5}
                    result = bridge._leaf_results(bridge._evaluate_expression(self.frame,
                        bridge.translate(config['id'], params), [], self.context))[0]
                    self.assertNotEqual(result['status'], 'unavailable')
                    if config.get('threshold'):
                        self.assertEqual(metrics[config['id']], result['details'].get('raw_value',result['value']))
                    else:
                        self.assertEqual(metrics[config['id']], int(result['status'] == 'match'))
            for period in MA_PERIODS:
                for kind in ('sma', 'ema'):
                    self.assertEqual(metrics[f'{kind}{period}'], float(_ma(self.frame, kind, period).iloc[-1]))
                for side in ('above', 'below'):
                    for days in (1,10,100,300,400):
                        outcome = bridge.evaluate(bridge.translate('PRICE_VS_EMA',
                            {'period':period,'comparison':side.upper(),'persistDays':days}),
                            self.stock,self.frame,self.context,self.session,set(),[])
                        expected = None if metrics[f'emaValid{period}'] < days else metrics[f'ema{side.title()}Run{period}'] >= days
                        self.assertEqual(outcome, expected)

    def test_stale_missing_short_history_and_session_counts(self):
        self.assertEqual(technical_metrics(self.stock,None,self.context,self.session), {})
        self.assertEqual(technical_metrics(self.stock,self.frame.iloc[:-1],self.context,self.session), {})
        short = technical_metrics(self.stock,self.frame.tail(2),self.context,self.session)
        self.assertIsNone(short['ADX'])
        self.assertIsNone(short['NEW_HIGH'])
        self.assertIsNone(short['LISTING_AGE_DAYS'])
        self.assertIsNone(short['DAYS_SINCE_EARNINGS'])
        metrics = technical_metrics(self.stock,self.frame,self.context,self.session)
        self.assertEqual(metrics['LISTING_AGE_DAYS'],399)
        self.assertEqual(metrics['DAYS_SINCE_EARNINGS'],5)  # not seven calendar days
        stale = {**self.context, 'benchmarks':{'NIFTY_50':self.frame.iloc[:-1]}}
        metrics = technical_metrics(self.stock,self.frame,stale,self.session)
        self.assertIsNone(metrics['RELATIVE_STRENGTH'])
        self.assertIsNone(metrics['RS_NEW_HIGH'])

    def test_threshold_values_are_not_rounded_for_browser_evaluation(self):
        with patch('edl_pipeline.scanner.trend._adx',return_value=pd.Series([24.9999998]*len(self.frame))):
            metrics = technical_metrics(self.stock,self.frame,self.context,self.session)
            result = bridge._leaf_results(bridge._evaluate_expression(self.frame,
                bridge.translate('ADX',{'period':14,'comparison':'ABOVE','value':25}),[],self.context))[0]
            self.assertEqual(result['value'],25)  # display-only rounding
            self.assertEqual(result['status'],'no_match')
            self.assertLess(metrics['ADX'],25)

    def test_stock_publication_populates_emas_and_respects_ban_date(self):
        default = bridge.translate('PRICE_RANGE',{'minPrice':0,'maxPrice':10000})
        def row(context, frame=self.frame):
            return _stock_row((self.stock,frame,[]),context,self.session,{},default,primitive_keys([default]))[0]
        published = row(self.context)
        for field in ('sma20', 'sma50', 'sma200'):
            self.assertEqual(published[field],published['metrics'][field])
        self.assertEqual(published['ema20'],published['metrics']['ema20'])
        self.assertEqual(published['daysSinceEarnings'],5)
        self.assertTrue(published['fnoBan'])
        self.assertEqual(published['fnoBanAsOfDate'],self.session)
        future = row({**self.context,'fno_ban_trade_date':'2026-10-12'})
        self.assertIsNone(future['fnoBan'])
        self.assertIsNone(row(self.context,None)['ema20'])


if __name__ == '__main__':
    unittest.main()
