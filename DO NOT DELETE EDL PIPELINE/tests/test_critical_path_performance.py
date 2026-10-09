"""Scheduling changes preserve ordered work, bytes and publication gates."""
from concurrent.futures import Future
import contextlib
import gzip
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
import announcement_artifacts as announcements
import filing_classification as classification
import standardize_stock_artifact as standardize
import enrich_published_fields as enrichment
import copy
from edl_pipeline import runner
from edl_pipeline.validators import ArtifactCheck, ArtifactSpec
from pipeline_utils import file_fingerprint
from test_announcement_artifacts import filing


def object_files(root):
    return {path.name: path.read_bytes() for path in root.glob('*.json.gz')}


class CriticalPathTests(unittest.TestCase):
    def test_long_lane_yields_worker_between_scripts(self):
        started = threading.Barrier(3)
        independent = threading.Event()
        calls = []
        def run(script, phase='', required=False):
            if script in ('filings', 'delivery', 'ipo'):
                started.wait(timeout=5)
                if script != 'delivery':
                    self.assertTrue(independent.wait(timeout=5))
            if script == 'independent':
                independent.set()
            if script == 'overlay':
                self.assertTrue(independent.is_set())
            calls.append(script)
            return runner.ScriptResult(script != 'overlay', required)
        lanes = {'filings': [('filings', '', True)],
                 'prices': [('delivery', '', True), ('overlay', '', True), ('daily', '', True)],
                 'ipo': [('ipo', '', True)], 'other': [('independent', '', False)]}
        with mock.patch.object(runner, 'run_script', side_effect=run):
            results = runner.run_script_lanes(lanes)
        self.assertEqual(list(results), list(lanes))
        self.assertEqual(list(results['prices']), ['delivery', 'overlay', 'daily'])
        self.assertFalse(results['prices']['overlay'].ok)
        self.assertTrue(results['prices']['daily'].ok)
        self.assertEqual(len(calls), 6)
        self.assertEqual(runner.run_script_lanes({'empty': []}), {'empty': {}})

    def test_bulk_provider_pools_cannot_overlap(self):
        active = set()
        lock = threading.Lock()
        def run(script, phase='', required=False):
            with lock:
                self.assertFalse(active)
                active.add(script)
            # Yield the interpreter without making test correctness depend on
            # elapsed time: exclusivity holds for the complete script call.
            for _ in range(1000):
                with lock:
                    self.assertEqual(active, {script})
            with lock:
                active.remove(script)
            return runner.ScriptResult(True, required)
        lanes = {name: [(name, '', False)] for name in
                 ('fetch_all_ohlcv.py', 'fetch_market_news.py',
                  'fetch_new_announcements.py', 'fetch_advanced_indicators.py')}
        with mock.patch.object(runner, 'run_script', side_effect=run):
            self.assertEqual(len(runner.run_script_lanes(lanes)), 4)

    def test_early_validation_reused_only_for_identical_bytes_and_order(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = ArtifactSpec('filing_history.json.gz', 'gzip_json', required_fields=('records',))
            other = ArtifactSpec('other.json', 'json')
            path = root / spec.path
            path.write_bytes(gzip.compress(b'{"records":[]}', mtime=0))
            early = ArtifactCheck(spec.path, spec.kind, True)
            ordinary = ArtifactCheck(other.path, other.kind, True)
            prepared = {spec.path: (file_fingerprint(path), early)}
            with mock.patch.object(runner, 'BASE_DIR', folder), \
                    mock.patch.object(runner, 'FINAL_ARTIFACT_SPECS', [other, spec]), \
                    mock.patch.object(runner, 'validate_many', return_value=[ordinary]) as validate:
                checks = runner.validate_final_artifacts(prepared=prepared)
                validate.assert_called_once_with([other])
                self.assertEqual(checks, [ordinary, early])
            # Same size is not enough: replacing bytes must trigger validation.
            path.write_bytes(bytes([path.read_bytes()[0] ^ 1]) + path.read_bytes()[1:])
            bad = ArtifactCheck(spec.path, spec.kind, False, 'corrupted')
            with mock.patch.object(runner, 'BASE_DIR', folder), \
                    mock.patch.object(runner, 'FINAL_ARTIFACT_SPECS', [spec]), \
                    mock.patch.object(runner, 'validate_many', return_value=[bad]) as validate, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.validate_final_artifacts(prepared=prepared), [bad])
                validate.assert_called_once_with([spec])
            path.unlink()
            with mock.patch.object(runner, 'BASE_DIR', folder), \
                    mock.patch.object(runner, 'FINAL_ARTIFACT_SPECS', [spec]), \
                    mock.patch.object(runner, 'validate_many', return_value=[bad]) as validate, \
                    contextlib.redirect_stdout(io.StringIO()):
                runner.validate_final_artifacts(prepared=prepared)
                validate.assert_called_once_with([spec])

    def test_failed_early_validation_is_not_dropped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'filing_history.json.gz'
            path.write_bytes(b'bad')
            spec = ArtifactSpec(path.name, 'gzip_json')
            bad = ArtifactCheck(path.name, 'gzip_json', False, 'invalid gzip')
            with mock.patch.object(runner, 'BASE_DIR', folder), \
                    mock.patch.object(runner, 'FINAL_ARTIFACT_SPECS', [spec]), \
                    mock.patch.object(runner, 'validate_many', return_value=[]) as validate, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.validate_final_artifacts(
                    prepared={path.name: (file_fingerprint(path), bad)}), [bad])
                validate.assert_called_once_with([])

    def test_spawned_announcements_match_serial_cold_warm_and_streamed_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = [{'symbol': symbol, 'fetch_status': {'lodr': {'error': None}},
                     'filings': [filing(f'2025-01-01T{n // 60:02d}:{n % 60:02d}:00+05:30', f'{symbol}-{n}')
                                 for n in range(205)] + [filing('2026-10-07T10:00:00', symbol)]}
                    for symbol in ('Z', 'A')]
            outputs = []
            for workers, streamed in ((0, False), (2, False), (2, True)):
                directory = root / f'{workers}-{streamed}'
                cache = directory / 'cache'
                for warm in (False, True):
                    records = iter(rows) if streamed else rows
                    result = announcements.build_announcements(
                        {'updated_at': '2026-10-07T12:00:00+05:30', 'records': records},
                        directory, {'Z', 'A', 'MISSING'}, '2026-10-06', cache, workers=workers)
                    outputs.append((result, object_files(directory)))
                    self.assertTrue(cache.exists())
            self.assertTrue(all(output == outputs[0] for output in outputs))

    def test_announcement_queue_is_bounded_and_cancelled_on_close(self):
        executor = mock.Mock()
        submitted = []
        def submit(function, task):
            future = Future()
            if not submitted:
                future.set_result(task)
            submitted.append(future)
            return future
        executor.submit.side_effect = submit
        with mock.patch.object(announcements, 'ProcessPoolExecutor', return_value=executor):
            result = announcements._company_results(iter(range(5000)), 2)
            self.assertEqual(next(result), 0)
            result.close()
        self.assertEqual(len(submitted), 4)
        self.assertTrue(all(future.cancelled() for future in submitted[1:]))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_announcement_stream_and_worker_errors_do_not_prune_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'cache'; cache.mkdir()
            sentinel = cache / ('f' * 64 + '.json.gz'); sentinel.write_bytes(b'retain')
            def broken_records():
                yield {'symbol': 'A', 'filings': []}
                raise ValueError('broken tail')
            for records, error in ((broken_records(), 'broken tail'),
                                   (iter([{'symbol': 'A', 'filings': [{'filingId': 'bad', 'classification': None}]}]), 'get')):
                with self.assertRaisesRegex((ValueError, AttributeError), error):
                    announcements.build_announcements({'records': records}, root, {'A'}, '2026-10-07', cache, workers=2)
                self.assertEqual(sentinel.read_bytes(), b'retain')

    def test_bounded_normalization_caches_preserve_original_results(self):
        samples = [None, False, 0, True, 123, 'Déjà-Vu / BOARD Outcome', 'X' * 4097]
        for value in samples:
            expected = re.sub(r'[^a-z0-9]+', ' ', str(value or '').lower()).strip()
            self.assertEqual(classification._text(value), expected)
        for i in range(5000):
            standardize.snake_case(f'Field ({i}) %')
            classification._text(f'Caption {i}')
        self.assertLessEqual(standardize.snake_case.cache_info().currsize, 4096)
        self.assertLessEqual(classification._normalized_text.cache_info().currsize, 2048)
        stock = {'Symbol': 'TEST', 'Stock Price(₹)': 5, 'Nested Field':
                 [{'Already_snake': 'N/A', 'Yes No': 'Yes'}, {'Already_snake': '', 'Yes No': 'No'}]}
        expected = standardize.canonicalize_stock(stock)
        with mock.patch.object(standardize, 'snake_case', standardize.snake_case.__wrapped__):
            self.assertEqual(json.dumps(standardize.canonicalize_stock(stock)), json.dumps(expected))

    def test_parallel_enrichment_keeps_bytes_missing_data_and_input_order(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stocks = [{'Symbol': symbol, 'Listing Date': '2026-09-01'} for symbol in
                      ('Z', 'A', 'MISSING', 'STALE', 'BAD', 'DUPLICATE')]
            for symbol in ('Z', 'A', 'STALE', 'BAD', 'DUPLICATE'):
                rows = ['2026-09-01,100,110,90,101,1000', '2026-09-02,100,110,90,102,1000']
                if symbol == 'STALE':
                    rows.pop()
                if symbol == 'BAD':
                    rows.append('2026-09-02,nan,110,90,102,1000')
                if symbol == 'DUPLICATE':
                    rows.extend(['2026-09-02,100,111,89,103,1000', '2026-09-03,100,110,90,104,1000'])
                (root / f'{symbol}.csv').write_text('Date,Open,High,Low,Close,Volume\n' + '\n'.join(rows) + '\n')
            args = ({'as_of_date': '2026-09-02', 'ohlcv_records': [
                {'symbol': 'Z', 'date': '2026-09-02', 'vwap': 101.5}]},
                {'records': [{'symbol': 'Z', 'action_type': 'DIVIDEND', 'ex_date': '2026-09-01',
                              'dividend_per_share': 2}]},
                {'symbol_history': {symbol: {'start_date': '2026-09-01'} for symbol in ('A', 'Z')}}, root)
            expected = enrichment.enrich(copy.deepcopy(stocks), *args)
            for workers in (1, 2):
                observed = copy.deepcopy(stocks)
                references = list(observed)
                self.assertIs(enrichment.enrich_parallel(observed, *args, workers), observed)
                self.assertTrue(all(before is after for before, after in zip(references, observed)))
                self.assertEqual(json.dumps(observed, allow_nan=False), json.dumps(expected, allow_nan=False))

    def test_enrichment_worker_failure_prevents_publication_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            destination = root / 'all_stocks_fundamental_analysis.json'
            original = json.dumps([{'Symbol': f'S{i}'} for i in range(256)])
            destination.write_text(original)
            with mock.patch.object(enrichment, 'BASE_DIR', folder), \
                    mock.patch.object(enrichment.os, 'cpu_count', return_value=4), \
                    mock.patch.object(enrichment, 'enrich_parallel', side_effect=RuntimeError('worker failed')):
                with self.assertRaisesRegex(RuntimeError, 'worker failed'):
                    enrichment.main()
            self.assertEqual(destination.read_text(), original)

    def test_enrichment_failure_cancels_only_a_bounded_window(self):
        executor = mock.MagicMock()
        executor.__enter__.return_value = executor
        submitted = []
        def submit(function, chunk):
            future = Future()
            if not submitted:
                future.set_result([{**stock, 'prepared': True} for stock in chunk])
            elif len(submitted) == 1:
                future.set_exception(RuntimeError('worker failed'))
            submitted.append(future)
            return future
        executor.submit.side_effect = submit
        stocks = [{'Symbol': str(n)} for n in range(5000)]
        with mock.patch.object(enrichment, 'ProcessPoolExecutor', return_value=executor):
            with self.assertRaisesRegex(RuntimeError, 'worker failed'):
                enrichment.enrich_parallel(stocks, {}, {}, {}, Path('unused'), 2)
        self.assertEqual(len(submitted), 5)
        self.assertTrue(all(future.cancelled() for future in submitted[2:]))
        self.assertTrue(all(stock.get('prepared') for stock in stocks[:8]))
        self.assertTrue(all('prepared' not in stock for stock in stocks[8:]))


if __name__ == '__main__':
    unittest.main()
