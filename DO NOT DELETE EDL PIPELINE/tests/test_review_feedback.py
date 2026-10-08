"""Regression coverage for the daily-runtime PR review findings."""
import csv
import ast
import io
from pathlib import Path
import sys
import tempfile
import threading
import contextlib
import unittest
from concurrent.futures import Future
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
from json_records import record_artifact
from announcement_artifacts import build_announcements
import build_chart_artifacts as charts
import import_eod2_ohlcv as eod2
import filing_archives
from edl_pipeline import runner
from edl_pipeline.config import PipelineConfig


class ReviewFeedbackTests(unittest.TestCase):
    def test_new_runner_helpers_are_in_the_wheel_module_manifest(self):
        manifest = (ROOT / 'pyproject.toml').read_text()
        value = manifest.split('py-modules = ', 1)[1].split(']', 1)[0] + ']'
        modules = ast.literal_eval(value)
        self.assertTrue({'json_records', 'filing_archives'}.issubset(modules))

    def test_required_builds_start_before_blocking_optional_reference(self):
        filing, breadth = threading.Event(), threading.Event()
        release_builds, release_reference = threading.Event(), threading.Event()
        checkpoint = {'config': {'fetch_ohlcv': True, 'fetch_optional': False, 'cleanup_intermediate': False},
                      'exit_code': 0, 'total_time_seconds': 0, 'scripts': {}}
        def run(script, phase_label='', required=False):
            if script == 'build_filing_history_artifact.py':
                filing.set()
                self.assertTrue(release_builds.wait(5))
            elif script == runner.OHLCV_DERIVED_SCRIPT:
                breadth.set()
                self.assertTrue(release_builds.wait(5))
            elif script == 'refresh_official_index_constituents.py':
                self.assertTrue(release_reference.wait(5))
            elif script == runner.PHASE4_SCRIPTS[0]:
                self.assertTrue(filing.wait(5))
                self.assertTrue(breadth.wait(5))
                release_builds.set()
            elif script == 'build_chart_artifacts.py':
                release_reference.set()
            return runner.ScriptResult(True, required)
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(runner, 'BASE_DIR', folder), \
                mock.patch.object(runner.pipeline_utils, 'load_json', return_value=checkpoint), \
                mock.patch.object(runner, 'run_script', side_effect=run), \
                mock.patch.object(runner, 'compress_output', return_value=(0, 0)), \
                mock.patch.object(runner, 'validate_final_artifacts', return_value=[]), \
                mock.patch.object(runner, 'write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(PipelineConfig(cleanup_intermediate=False), phase='build'), 0)

    def test_invalid_records_and_duplicate_record_fields_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'filing_history.json'
            for value in ('null', '{}', '"bad"', '1', 'true'):
                path.write_text('{"updated_at":"2026-10-08","records":' + value + '}')
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'must be an array'):
                    record_artifact(path)
            path.write_text('{"records":[],"records":[1]}')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                list(record_artifact(path)['records'])

    def test_duplicate_streamed_symbols_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            payload = {'updated_at': '2026-10-08', 'records': iter([
                {'symbol': 'A', 'filings': []}, {'symbol': 'A', 'filings': []}])}
            with self.assertRaisesRegex(ValueError, 'Duplicate streamed filing symbol: A'):
                build_announcements(payload, Path(folder), {'A'}, '2026-10-08')

    def test_parallel_chart_failure_bounds_submission_and_cancels_pending_chunks(self):
        class Executor:
            def __init__(self):
                self.futures = []
                self.shutdowns = []
            def submit(self, function, chunk):
                future = Future()
                if not self.futures:
                    future.set_exception(RuntimeError('worker failed'))
                self.futures.append(future)
                return future
            def shutdown(self, **kwargs):
                self.shutdowns.append(kwargs)
        executor = Executor()
        with mock.patch.object(charts, 'ProcessPoolExecutor', return_value=executor):
            with self.assertRaisesRegex(RuntimeError, 'worker failed'):
                charts._parallel_chart_objects(list(range(5000)), workers=2)
        self.assertEqual(len(executor.futures), 4)
        self.assertTrue(all(future.cancelled() for future in executor.futures[1:]))
        self.assertEqual(executor.shutdowns, [{'wait': True, 'cancel_futures': True}])

    def test_csv_changed_and_unchanged_paths_render_once_and_keep_original_bytes(self):
        rows = [{'Date': '2026-10-08', 'Open': 1.0, 'High': 2.0, 'Low': 1.0,
                 'Close': 2.0, 'Volume': 0.1}]
        expected = io.StringIO(newline='')
        writer = csv.DictWriter(expected, fieldnames=eod2.OHLCV_FIELDS)
        writer.writeheader(); writer.writerows(rows)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'A.csv'
            with mock.patch.object(eod2.csv, 'DictWriter', wraps=csv.DictWriter) as render:
                eod2.write_csv_if_changed(path, rows, eod2.OHLCV_FIELDS)
                self.assertEqual(render.call_count, 1)
            self.assertEqual(path.read_bytes(), expected.getvalue().encode())
            with mock.patch.object(Path, 'write_bytes', side_effect=AssertionError('unchanged write')):
                eod2.write_csv_if_changed(path, rows, eod2.OHLCV_FIELDS)

    def test_announcement_failure_interrupts_chart_wait_and_cancels_bounded_queue(self):
        announcement = Future()
        futures = []
        executor = mock.Mock()
        def submit(function, chunk):
            future = Future()
            futures.append(future)
            return future
        def wait(waiting, **kwargs):
            self.assertIn(announcement, waiting)
            announcement.set_exception(ValueError('malformed filings'))
            return {announcement}, set(futures)
        executor.submit.side_effect = submit
        with mock.patch.object(charts, 'ProcessPoolExecutor', return_value=executor), \
                mock.patch.object(charts, 'wait', side_effect=wait):
            with self.assertRaisesRegex(ValueError, 'malformed filings'):
                charts._parallel_chart_objects(list(range(5000)), 2, announcement)
        self.assertEqual(len(futures), 4)
        self.assertTrue(all(future.cancelled() for future in futures))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)
        # The single-core path must also stop before generating another object
        # and leave the previously published chart directory intact.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / 'chart_artifacts'
            output.mkdir()
            index = output / 'index.json'
            index.write_text('retained')
            stocks = [{'symbol': symbol, 'as_of_date': '2026-10-08'} for symbol in ('A', 'B')]
            background = mock.MagicMock()
            background.__enter__.return_value.submit.return_value = announcement
            def artifact(root, name, default):
                return stocks if name == 'all_stocks_fundamental_analysis.json' else default
            with mock.patch.object(charts, 'BASE_DIR', folder), \
                    mock.patch.object(charts, '_artifact', side_effect=artifact), \
                    mock.patch.object(charts, 'ThreadPoolExecutor', return_value=background), \
                    mock.patch.object(charts.os, 'cpu_count', return_value=1), \
                    mock.patch.object(charts, '_chart_object') as build:
                with self.assertRaisesRegex(ValueError, 'malformed filings'):
                    charts.main()
            build.assert_not_called()
            self.assertEqual(index.read_text(), 'retained')

    def test_archive_manifest_partial_write_does_not_replace_existing_index(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            directory = root / 'prepared'
            directory.mkdir()
            index = directory / 'index.json'
            index.write_text('{"classified":"previous"}')
            original_write = Path.write_text
            def fail_write(path, text, **kwargs):
                original_write(path, text[:1], **kwargs)
                raise OSError('disk full')
            with mock.patch.object(Path, 'write_text', fail_write):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    filing_archives.prepare_filing_archives(root, directory)
            self.assertEqual(index.read_text(), '{"classified":"previous"}')
            self.assertEqual(list(directory.iterdir()), [index])


if __name__ == '__main__':
    unittest.main()
