"""Output, ordering and failure contracts for the post-PR-50 optimizations."""
from collections import defaultdict
from concurrent.futures import Future
from datetime import datetime
import gzip
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
import weakref
from unittest import mock

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
import announcement_artifacts as announcements
import build_chart_artifacts as charts
import build_filing_history_artifact as filings
import enrich_published_fields as published
import fetch_all_ohlcv as fetch
import filing_archives as archives
import ohlcv_utils as ohlcv
import pipeline_utils as utils
from edl_pipeline.breadth.config import BreadthMethodology
from edl_pipeline.breadth import pipeline as breadth
from test_breadth_v2 import make_ohlcv


def candle(day, close=10):
    return {'Date': day, 'Open': 10, 'High': 12, 'Low': 9, 'Close': close, 'Volume': 100}


def tree_bytes(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


class FollowupPerformanceTests(unittest.TestCase):
    def test_evidenced_scan_matches_full_cleaning_for_unsorted_invalid_and_duplicate_rows(self):
        rng = random.Random(42)
        days = list(pd.date_range('2026-09-01', periods=40).strftime('%Y-%m-%d'))
        for _ in range(100):
            rows = [candle(rng.choice(days), rng.choice([10, 20, float('nan')])) for _ in range(100)]
            rows += [candle('bad date'), candle('2026-9-7'), candle('2026-09-07')]
            rng.shuffle(rows)
            expected = rng.sample(days, 15)
            before = ohlcv.missing_history_sessions(ohlcv.discard_invalid_ohlcv_rows(
                ohlcv.discard_weekend_rows(rows)), expected)
            self.assertEqual(ohlcv.evidenced_history_gaps(rows, expected), before)
        for broken in ({}, {'Date': None}, {'Date': 42}):
            rows = [candle('2026-09-01'), {**candle('2026-09-02'), **broken}]
            if not broken:
                rows[-1].pop('Date')
            try:
                before = ohlcv.missing_history_sessions(ohlcv.discard_invalid_ohlcv_rows(
                    ohlcv.discard_weekend_rows(rows)), days)
            except (KeyError, TypeError) as error:
                with self.assertRaises(type(error)):
                    ohlcv.evidenced_history_gaps(rows, days)
            else:
                self.assertEqual(ohlcv.evidenced_history_gaps(rows, days), before)

    def test_gap_scan_does_not_revalidate_irrelevant_old_candles(self):
        rows = [candle(day) for day in pd.bdate_range('2020-01-01', periods=1500).strftime('%Y-%m-%d')]
        expected = [row['Date'] for row in rows[-30:]]
        with mock.patch.object(ohlcv, 'has_valid_ohlcv', wraps=ohlcv.has_valid_ohlcv) as validate:
            self.assertEqual(ohlcv.evidenced_history_gaps(rows, expected), [])
        self.assertEqual(validate.call_count, 31)

    def test_sync_revalidates_only_new_rows_and_keeps_official_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = [candle('2020-01-02'), candle('2026-10-08'), candle('2026-10-07', 30)]
            ohlcv.write_ohlcv_csv(root / 'ABC.csv', original)
            with mock.patch.object(fetch, 'resolve_path', return_value=root), \
                    mock.patch.object(fetch, 'time') as clock, \
                    mock.patch.object(fetch, 'is_nse_cash_session', return_value=True), \
                    mock.patch.object(fetch, 'nse_calendar_date', return_value='2026-10-08'), \
                    mock.patch.object(fetch, 'has_official_history', return_value=False), \
                    mock.patch.object(fetch, 'fetch_history_chunk', return_value=[candle('2026-10-07'), candle('2026-10-08', 11)]), \
                    mock.patch.object(fetch, 'discard_invalid_ohlcv_rows', wraps=ohlcv.discard_invalid_ohlcv_rows) as validate:
                clock.time.return_value = datetime(2026, 10, 9).timestamp()
                self.assertEqual(fetch.fetch_single_stock('ABC', {'Exch':'NSE','Seg':'E','Inst':'EQUITY','Sid':1},
                    {'Open':10,'High':12,'Low':9,'Ltp':11,'Volume':100}, '2026-10-08',
                    ['2026-10-07','2026-10-08']), 'success')
            self.assertEqual(len(validate.call_args_list), 2)
            rows = ohlcv.read_ohlcv_csv(root / 'ABC.csv')
            self.assertEqual([row['Date'] for row in rows], ['2020-01-02','2026-10-07','2026-10-08'])
            self.assertEqual([float(row['Close']) for row in rows], [10, 10, 10])

    def test_listing_date_cache_keeps_legacy_whitespace_and_invalid_rules(self):
        for value, expected in [('2026-09-30', '2026-09-30'), (' 2026-09-30 ', '2026-09-30'),
                                ('30-Sep-2026', '2026-09-30'), ('30/09/2026', '2026-09-30'),
                                (' 30-Sep-2026 ', '2026-09-30'), (None, None), ('bad', None)]:
            result = published.listing_day(value)
            self.assertEqual(result.isoformat() if result else None, expected)
            self.assertEqual(published.listing_day(value), result)
        self.assertGreater(published._listing_day.cache_info().hits, 0)

    def test_chart_volume_ties_and_retention_match_original_bucket_replay(self):
        rng = random.Random(123)
        rows = [{'date':day, 'volume':rng.randrange(4)}
                for day in pd.bdate_range('2010-01-01', periods=5000).strftime('%Y-%m-%d')]
        rng.shuffle(rows)
        for candles in ([], rows, rows + rows[:20]):
            actual = charts._volume_events(candles)
            low = lambda group: min(group, key=lambda row: (row['volume'], -int(row['date'].replace('-', '')))) if group else None
            event = lambda row: {'date':row['date'],'volume':row['volume']} if row else None
            quarters = defaultdict(list)
            for row in candles:
                quarters[f"{row['date'][:4]}-Q{(int(row['date'][5:7])-1)//3+1}"].append(row)
            self.assertEqual(actual['lowestEver'], event(low(candles)))
            self.assertEqual(actual['lowestQuarterly'], [event(low(quarters[key])) for key in sorted(quarters)[-20:]])

    def test_filing_time_cache_keeps_timezone_and_invalid_fallback(self):
        for value in ['2026-10-08', '2026-10-08T12:30:00Z', '2026-10-08T18:00:00+05:30', 'bad', None]:
            try:
                stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            except ValueError:
                expected = None
            else:
                expected = (stamp.replace(tzinfo=announcements.IST) if stamp.tzinfo is None else stamp).astimezone(announcements.timezone.utc)
            self.assertEqual(announcements.filing_time(value), expected)
            self.assertEqual(announcements.filing_time(value), expected)

    def test_breadth_spawn_preparation_preserves_all_artifacts_and_quality_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); history = root / 'histories'; history.mkdir()
            universe = [{'Sym':symbol,'ISIN':symbol,'Sid':i+1,'Ltp':100,'Mcap':5000,
                         'Sector':'Tech','Index':['NIFTY50','NIFTY500']}
                        for i,symbol in enumerate(['C','A','MISSING','INVALID','B','EMPTY'])]
            index = root / 'index.csv'
            make_ohlcv([100 + i % 19 for i in range(310)]).to_csv(index, index=False)
            for symbol in ['A', 'B', 'C']:
                frame = make_ohlcv([100 + i % 29 for i in range(310)])
                frame['Volume'] = ([1e16, .1, 0, np.nan] * 78)[:310]
                frame.to_csv(history / f'{symbol}.csv', index=False)
            (history / 'INVALID.csv').write_text('invalid\n1\n')
            make_ohlcv([]).to_csv(history / 'EMPTY.csv', index=False)
            results = []
            for workers in (0, 1, 2):
                output = root / str(workers); output.mkdir()
                breadth.generate_market_breadth(universe, history, index, BreadthMethodology(),
                    output / 'breadth.json', output / 'snapshot.json', generated_at='fixed',
                    sector_output_path=output / 'sectors.json', contribution_output_path=output / 'audit.json',
                    preparation_workers=workers)
                results.append(tree_bytes(output))
            self.assertEqual(results[0], results[1])
            self.assertEqual(results[0], results[2])

    def test_breadth_preparation_queue_is_bounded_and_cancelled_on_close(self):
        submitted = []
        executor = mock.Mock()
        def submit(function, task):
            future = Future()
            if not submitted:
                future.set_result((task[0], 'frame', None))
            submitted.append(future)
            return future
        executor.submit.side_effect = submit
        stocks = [{'symbol':str(i)} for i in range(5000)]
        with mock.patch.object(breadth, 'ProcessPoolExecutor', return_value=executor):
            iterator = breadth._prepared_histories(stocks, Path('unused'), BreadthMethodology(), 2)
            self.assertEqual(next(iterator), ('0','frame',None))
            iterator.close()
        self.assertEqual(len(submitted), 4)
        self.assertTrue(all(future.cancelled() for future in submitted[1:]))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_breadth_worker_failure_falls_back_to_serial_preparation(self):
        executor = mock.Mock()
        def submit(*_):
            future = Future()
            future.set_exception(RuntimeError('worker stopped'))
            return future
        executor.submit.side_effect = submit
        stocks = [{'symbol':str(index)} for index in range(5)]
        with mock.patch.object(breadth, 'ProcessPoolExecutor', return_value=executor):
            result = list(breadth._prepared_histories(stocks, Path('unused'), BreadthMethodology(), 2))
        self.assertEqual([symbol for symbol, _, _ in result], [str(index) for index in range(5)])
        self.assertTrue(all(prepared is None and error is None for _, prepared, error in result))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_breadth_pool_start_and_submission_failures_preserve_order(self):
        stocks = [{'symbol':str(i)} for i in range(7)]
        for failure in ('start', 1, 5):
            with self.subTest(failure=failure):
                executor = mock.Mock()
                calls = 0
                def submit(_, task):
                    nonlocal calls
                    calls += 1
                    if calls == failure:
                        raise RuntimeError('pool unavailable')
                    future = Future(); future.set_result((task[0], 'worker', None))
                    return future
                executor.submit.side_effect = submit
                options = {'side_effect':RuntimeError('start failed')} if failure == 'start' else {'return_value':executor}
                def serial(task):
                    if failure != 'start':
                        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)
                    return (task[0], 'serial', None)
                with mock.patch.object(breadth, 'ProcessPoolExecutor', **options), \
                        mock.patch.object(breadth, '_prepare_stock', side_effect=serial) as prepare:
                    result = list(breadth._prepared_histories(stocks, Path('unused'), BreadthMethodology(), 2))
                self.assertEqual([row[0] for row in result], [str(i) for i in range(7)])
                first_serial = 1 if failure == 5 else 0
                self.assertEqual([row[1] for row in result], ['worker'] * first_serial + ['serial'] * (7 - first_serial))
                self.assertEqual([call.args[0][0] for call in prepare.call_args_list],
                                 [str(i) for i in range(first_serial, 7)])
                if failure != 'start':
                    executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_breadth_consumer_failure_does_not_retry_preparation(self):
        executor = mock.Mock()
        def submit(_, task):
            future = Future(); future.set_result((task[0], None, None)); return future
        executor.submit.side_effect = submit
        with mock.patch.object(breadth, 'ProcessPoolExecutor', return_value=executor), \
                mock.patch.object(breadth, '_prepare_stock', side_effect=AssertionError('must not retry')):
            iterator = breadth._prepared_histories([{'symbol':str(i)} for i in range(5)],
                                                  Path('unused'), BreadthMethodology(), 2)
            self.assertEqual(next(iterator)[0], '0')
            with self.assertRaisesRegex(ValueError, 'consumer failed'):
                iterator.throw(ValueError('consumer failed'))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_archive_reuses_compression_without_changing_gzip_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'filing_history_data').mkdir()
            for content in (b'{"records":[]}', b'filing ' * 400000, os.urandom(2200000)):
                (root / 'filing_history.json').write_bytes(content)
                (root / 'filing_history_data/filing_history.json').write_bytes(content[:1000])
                compressed = root / 'filing_history.json.gz'
                utils.compress_file(root / 'filing_history.json', compressed)
                expected = archives.prepare_filing_archives(root, root / 'old')
                actual = archives.prepare_filing_archives(root, root / 'new', compressed_classified=compressed)
                self.assertEqual(actual, expected)
                self.assertEqual(tree_bytes(root / 'new'), tree_bytes(root / 'old'))
                self.assertEqual(gzip.decompress((root / 'new' / (actual['classified'] + '.json.gz')).read_bytes()), content)
                # An unsupported producer header uses the existing writer.
                compressed.write_bytes(b'unsupported')
                self.assertEqual(archives.prepare_filing_archives(root, root / 'fallback',
                    compressed_classified=compressed), expected)

    def test_encoded_record_writer_keeps_exact_bytes_and_atomic_failure(self):
        records = [{'symbol':'₹','value':float('nan')}, {'symbol':'A','value':-0.0}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); before, after = root / 'before.json', root / 'after.json'
            payload = {'coverage':{'count':2}, 'records':records}
            utils.save_json_records(before, payload, ensure_ascii=False)
            encoded = (json.dumps(utils.finite_json(row), separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode() for row in records)
            utils.save_json_records(after, {**payload,'records':[]}, ensure_ascii=False, encoded_records=encoded)
            self.assertEqual(before.read_bytes(), after.read_bytes())
            def failed():
                yield b'{}'
                raise OSError('spool read failed')
            with self.assertRaisesRegex(OSError, 'spool read failed'):
                utils.save_json_records(after, {'records':[]}, encoded_records=failed())
            self.assertEqual(before.read_bytes(), after.read_bytes())
            self.assertEqual(list(root.glob('*.tmp')), [])

    def test_filing_spool_matches_original_encoder_and_releases_each_company(self):
        source = {'updated_at':'2026-10-08','symbols':{
            symbol:{'lodr_backfill_complete':symbol == 'A','filings':[
                {'news_date':'2020-01-01','caption':'Corporate guarantee '+symbol,'extra':float('nan')}]} for symbol in ['Z','A','B']}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            utils.save_json(root / 'filing_history_data/filing_history.json', source)
            with mock.patch.object(filings, 'BASE_DIR', str(root)):
                class CompanyFilings(list):
                    pass
                references = []
                classify = filings.classify_cached
                def tracked(*args, **kwargs):
                    self.assertTrue(all(reference() is None for reference in references))
                    result = CompanyFilings(classify(*args, **kwargs))
                    references.append(weakref.ref(result))
                    return result
                with mock.patch.object(filings, 'classify_cached', side_effect=tracked):
                    self.assertEqual(filings.main(), 0)
                self.assertTrue(all(reference() is None for reference in references))
                first = (root / 'filing_history.json').read_bytes()
                self.assertEqual(filings.main(), 0)
                self.assertEqual((root / 'filing_history.json').read_bytes(), first)
                payload = json.loads(first)
                self.assertEqual([row['symbol'] for row in payload['records']], ['A','B','Z'])
                self.assertEqual(first, json.dumps(utils.finite_json(payload), separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode())
                with mock.patch.object(filings, 'classify_cached', side_effect=[[], RuntimeError('classification failed')]):
                    with self.assertRaisesRegex(RuntimeError, 'classification failed'):
                        filings.main()
                self.assertEqual((root / 'filing_history.json').read_bytes(), first)

    def test_filing_spool_releases_raw_cache_aliases_before_next_company(self):
        class RawFilings(list):
            pass
        references = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = {'updated_at':'2026-10-08','symbols':{symbol:{'filings':[
                {'news_date':'2020-01-01','caption':'Corporate guarantee'}]} for symbol in ['A','B','C']}}
            utils.save_json(root / 'filing_history_data/filing_history.json', source)
            load = filings.load_json
            classify = filings.classify_cached
            def tracked_load(path, **kwargs):
                value = load(path, **kwargs)
                if 'symbols' in value:
                    for record in value['symbols'].values():
                        record['filings'] = RawFilings(record['filings'])
                        references.append(weakref.ref(record['filings']))
                return value
            count = 0
            def tracked_classify(*args, **kwargs):
                nonlocal count
                self.assertTrue(all(reference() is None for reference in references[:count]))
                count += 1
                return classify(*args, **kwargs)
            with mock.patch.object(filings, 'BASE_DIR', str(root)), \
                    mock.patch.object(filings, 'load_json', new=tracked_load), \
                    mock.patch.object(filings, 'classify_cached', new=tracked_classify):
                self.assertEqual(filings.main(), 0)
            self.assertEqual(count, 3)
            self.assertTrue(all(reference() is None for reference in references))


if __name__ == '__main__':
    unittest.main()
