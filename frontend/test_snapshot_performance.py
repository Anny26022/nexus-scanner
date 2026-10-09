"""Bounded row preparation must preserve revisions, order and failure gates."""
from concurrent.futures import Future
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import pandas as pd
import publish_snapshot as snapshot
import test_publish_snapshot as fixtures


def files(root):
    return {str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}


class SnapshotPerformanceTests(unittest.TestCase):
    def test_primitive_keys_use_the_same_canonical_leaf_keys_once(self):
        a = {'type':'snapshot','field':'close','min':10}
        b = {'min':10,'field':'close','type':'snapshot'}
        expression = {'type':'group','children':[a, {'type':'preset','expression':b}]}
        keys = snapshot.primitive_keys([expression])
        self.assertEqual(keys, {id(a):json.dumps(a,sort_keys=True), id(b):json.dumps(b,sort_keys=True)})
        self.assertEqual(keys[id(a)], keys[id(b)])

    def test_spawned_rows_keep_complete_revisions_for_missing_stale_and_aligned_histories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'edl'; root.mkdir()
            fixtures.SnapshotPublicationTests().fixture(root)
            with gzip.open(root / 'all_stocks_fundamental_analysis.json.gz', 'rt') as handle:
                sample = json.load(handle)[0]
            stocks = [{**sample, 'symbol':symbol, 'index_memberships':['NIFTY50'],
                       'default_screener_eligible':symbol != 'EXCLUDED',
                       'promoter_holding_percent':50.48, 'fii_percent_change_qoq':-1.47,
                       'financial_statement_history':{'source':'ScanX', 'observed_on':'2026-09-30',
                           'quarterly':[{'period_end':'2026-06-30','revenue':120}], 'annual':[]}}
                      for symbol in ['Z','A','MISSING','STALE','B','EXCLUDED']]
            (root / 'all_stocks_fundamental_analysis.json.gz').write_bytes(gzip.compress(json.dumps(stocks).encode(),mtime=0))
            financials = {'records':[{'symbol':stock['symbol'], 'quarter_end':quarter,
                'filing_date':'2026-08-01', 'report_type':'CONSOLIDATED', 'net_profit':profit}
                for stock in stocks for quarter,profit in zip(
                    ['2025-09-30','2025-12-31','2026-03-31','2026-06-30'],[10,20,30,40])]}
            (root / 'quarterly_financial_history.json.gz').write_bytes(gzip.compress(json.dumps(financials).encode(),mtime=0))
            delivery = {'records':[{'symbol':stock['symbol'], 'date':day, 'delivery_percent':value}
                for stock in stocks for day,value in [('2026-09-29',65),('2026-09-30',70)]]}
            (root / 'delivery_history_data/2026-09-30.json').write_text(json.dumps(delivery))
            frame = pd.DataFrame({'Date':pd.bdate_range(end='2026-09-30',periods=400),
                                  'Open':100.,'High':110.,'Low':90.,
                                  'Close':[100+i%5 for i in range(400)],
                                  'Volume':[1000+i%20 for i in range(400)]})
            for stock in stocks:
                if stock['symbol'] != 'MISSING':
                    frame.iloc[:-1 if stock['symbol'] == 'STALE' else None].to_csv(root / 'ohlcv_data' / f"{stock['symbol']}.csv",index=False)
            outputs = []
            with mock.patch.dict('os.environ', {'EDL_CHART_STORAGE':'r2'},clear=True), \
                    mock.patch.object(snapshot, 'datetime') as clock:
                clock.now.return_value.isoformat.return_value = '2026-10-09T00:00:00+00:00'
                for workers in (0, 1, 2):
                    output = Path(directory) / str(workers)
                    manifest = snapshot.publish(root,output,workers=workers)
                    self.assertEqual(manifest['totalStocks'],5)
                    rows = json.loads((output / 'revisions' / manifest['revision'] / 'stocks.json').read_text())['stocks']
                    self.assertTrue(all(row['peRatio'] == 50 for row in rows))
                    outputs.append(files(output))
            self.assertEqual(outputs[0],outputs[1])
            self.assertEqual(outputs[0],outputs[2])

    def test_worker_exception_does_not_replace_previous_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'edl'; root.mkdir(); output = Path(directory) / 'public'
            fixtures.SnapshotPublicationTests().fixture(root)
            with mock.patch.dict('os.environ', {'EDL_CHART_STORAGE':'r2'},clear=True):
                snapshot.publish(root,output)
                previous = (output / 'current.json').read_bytes()
                translate = snapshot.bridge.translate
                def invalid(identifier, parameters):
                    return {'type':'snapshot','field':[]} if identifier == 'broken' else translate(identifier,parameters)
                with mock.patch.object(snapshot, 'list_presets',return_value=[{'id':'broken'}]), \
                        mock.patch.object(snapshot.bridge, 'translate',side_effect=invalid):
                    with self.assertRaisesRegex(RuntimeError, 'TEST'):
                        snapshot.publish(root,output,workers=2)
            self.assertEqual((output / 'current.json').read_bytes(),previous)

    def test_row_queue_is_bounded_and_cancelled_on_consumer_failure(self):
        submitted = []
        executor = mock.Mock()
        def submit(function, tasks):
            future = Future()
            if not submitted:
                future.set_result([({'symbol':task},True) for task in tasks])
            submitted.append(future)
            return future
        executor.submit.side_effect = submit
        with mock.patch.object(snapshot, 'ProcessPoolExecutor',return_value=executor):
            iterator = snapshot.stock_rows(iter(range(5000)),{},'unused',{}, {}, workers=2)
            self.assertEqual(next(iterator), ({'symbol':0},True))
            iterator.close()
        self.assertEqual(len(submitted),4)
        self.assertTrue(all(future.cancelled() for future in submitted[1:]))
        executor.shutdown.assert_called_once_with(wait=True,cancel_futures=True)

    def test_row_worker_error_names_the_chunk_symbols(self):
        snapshot._ROW_INPUTS = ({}, 'unused', {}, {}, {})
        tasks = [({'symbol':'FIRST'}, None, []), ({'symbol':'SECOND'}, None, [])]
        with mock.patch.object(snapshot, '_stock_row', side_effect=ValueError('bad candle')):
            with self.assertRaisesRegex(RuntimeError, 'FIRST, SECOND'):
                snapshot._row_chunk(tasks)


if __name__ == '__main__':
    unittest.main()
